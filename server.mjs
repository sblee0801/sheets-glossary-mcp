/**
 * server.mjs
 * 목적:
 * - “대화형 웹 세션”에서 Glossary를 1회 로드(캐시)하고
 * - 사용자가 명시적으로 “Glossary 업데이트”를 요청하기 전까지
 *   동일 Glossary 기준으로 치환(Glossary Lock)만 수행
 *
 * 주요 엔드포인트:
 * - POST /v1/session/init            : 세션 생성 + Glossary 로드(카테고리/언어 기준)
 * - POST /v1/translate/replace       : (세션 or 무세션) Glossary로 용어 치환
 * - POST /v1/glossary/update         : (세션 or 무세션) Glossary 강제 갱신
 * - GET  /healthz                   : 헬스체크
 *
 * (선택) MCP 엔드포인트도 유지: /mcp
 */

import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { google } from "googleapis";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------- Env ----------------
const PORT = Number(process.env.PORT || 8080);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Glossary";

if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is missing. Check env.");
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing. Check env.");

// ---------------- Helpers ----------------
function normalizeHeader(h) {
  return String(h ?? "").trim().toLowerCase();
}

function normalizeLang(lang) {
  return String(lang ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function normalizeCategory(cat) {
  return String(cat ?? "").trim().toLowerCase();
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// 단순 치환(긴 term 우선) + 중복치환 방지(placeholder)
function applyReplacements(text, pairs) {
  // pairs: [{ ko, en }]
  if (!text || pairs.length === 0) {
    return { output: text ?? "", hits: [] };
  }

  const source = String(text);
  const hits = [];
  const placeholders = [];

  // 1) ko 매칭된 부분을 placeholder로 치환
  let tmp = source;

  for (let i = 0; i < pairs.length; i++) {
    const { ko, en } = pairs[i];
    if (!ko) continue;

    // 전역 replace (정확 문자열 매칭)
    if (tmp.includes(ko)) {
      const ph = `[[G${i}]]`;
      tmp = tmp.split(ko).join(ph);
      placeholders.push({ ph, en, ko });
      hits.push({ ko, en });
    }
  }

  // 2) placeholder를 en으로 복원
  let out = tmp;
  for (const p of placeholders) {
    out = out.split(p.ph).join(p.en);
  }

  return { output: out, hits };
}

// ---------------- Sheets Reader (I:U only) ----------------
async function readGlossaryIU() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // ✅ I~U만 읽음
  const range = `${SHEET_NAME}!I:U`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return { header: [], data: [] };

  const headerRaw = rows[0].map((h) => String(h ?? "").trim());
  const header = headerRaw.map(normalizeHeader);
  const body = rows.slice(1);

  const idx = {
    category: header.indexOf("분류"),
    term: header.indexOf("term"),
    len: header.indexOf("len"),
  };

  if (idx.term < 0) {
    throw new Error(
      "I:U 범위 헤더에 TERM(또는 term)이 없습니다. U열 헤더가 'TERM'인지 확인하세요."
    );
  }

  const langIndex = {};
  for (let i = 0; i < header.length; i++) {
    if (i === idx.term || i === idx.len || i === idx.category) continue;

    const h = header[i];
    if (!h) continue;

    if (/^[a-z]{2}(-[a-z]{2})?$/.test(h) || /^[a-z]{2}-[a-z]{2}$/.test(h)) {
      langIndex[h] = i;
    }
  }

  const data = body
    .map((r) => {
      const term = String(r[idx.term] ?? "").trim();
      const category = idx.category >= 0 ? String(r[idx.category] ?? "").trim() : "";
      const len = idx.len >= 0 ? String(r[idx.len] ?? "").trim() : "";

      const translations = {};
      for (const [langKey, colIdx] of Object.entries(langIndex)) {
        const v = String(r[colIdx] ?? "").trim();
        if (v) translations[langKey] = v;
      }

      return { term, category, len, translations };
    })
    .filter((x) => x.term);

  return { header: headerRaw, data };
}

// ---------------- Session-Scoped Glossary Cache ----------------
const sessions = new Map();

// ---------------- Process-Scoped Glossary Cache (shared within a single instance) ----------------
let processGlossaryCache = null;
// (category|source|target) 조합별로 치환쌍을 캐시(프로세스 단위)
const processPairsCache = new Map();

async function ensureProcessGlossaryLoaded(forceReload = false) {
  if (processGlossaryCache && !forceReload) return processGlossaryCache;
  const loadedAt = nowIso();
  const { header, data } = await readGlossaryIU();
  processGlossaryCache = { loadedAt, header, data };
  processPairsCache.clear();
  return processGlossaryCache;
}

function buildGlossaryMap(rows, category, sourceLang, targetLang) {
  const cat = normalizeCategory(category);
  const src = normalizeLang(sourceLang);
  const tgt = normalizeLang(targetLang);

  const filtered = rows.filter((r) => {
    if (!cat) return true;
    return normalizeCategory(r.category) === cat;
  });

  const map = new Map();

  for (const r of filtered) {
    const ko = String(r.translations?.[src] ?? "").trim();
    const en = String(r.translations?.[tgt] ?? "").trim();
    if (!ko || !en) continue;

    if (!map.has(ko)) map.set(ko, en);
  }

  const pairsSorted = [...map.entries()]
    .map(([ko, en]) => ({ ko, en }))
    .sort((a, b) => b.ko.length - a.ko.length);

  return { map, pairsSorted, count: pairsSorted.length };
}

function getPairsFromProcessCache({ category, sourceLang, targetLang }) {
  const catKey = normalizeCategory(category);
  const srcKey = normalizeLang(sourceLang);
  const tgtKey = normalizeLang(targetLang);
  const cacheKey = `${catKey}||${srcKey}||${tgtKey}`;
  const found = processPairsCache.get(cacheKey);
  if (found) return found;

  if (!processGlossaryCache) return null;
  const built = buildGlossaryMap(processGlossaryCache.data, catKey, srcKey, tgtKey);
  processPairsCache.set(cacheKey, built);
  return built;
}

async function reloadAllInThisProcess() {
  await ensureProcessGlossaryLoaded(true);

  for (const [sessionId, s] of sessions.entries()) {
    const built = getPairsFromProcessCache({
      category: s.category,
      sourceLang: s.sourceLang,
      targetLang: s.targetLang,
    });
    if (!built) continue;

    sessions.set(sessionId, {
      ...s,
      updatedAt: nowIso(),
      glossaryVersion: sha1(`${nowIso()}|${s.category}|${s.sourceLang}|${s.targetLang}`),
      map: built.map,
      pairsSorted: built.pairsSorted,
      termCount: built.count,
    });
  }

  return {
    loadedAt: processGlossaryCache?.loadedAt,
    sessionCount: sessions.size,
  };
}

async function loadSessionGlossary(sessionId, { category, sourceLang, targetLang }) {
  const cache = await ensureProcessGlossaryLoaded(false);
  const built = buildGlossaryMap(cache.data, category, sourceLang, targetLang);

  const session = {
    createdAt: sessions.get(sessionId)?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    category: category ?? "",
    sourceLang: normalizeLang(sourceLang),
    targetLang: normalizeLang(targetLang),
    glossaryVersion: sha1(`${nowIso()}|${category}|${sourceLang}|${targetLang}`),
    map: built.map,
    pairsSorted: built.pairsSorted,
    termCount: built.count,
  };

  sessions.set(sessionId, session);
  return session;
}

// ---------------- Express App ----------------
const app = express();
app.use(express.json({ limit: "5mb", type: ["application/json", "application/*+json"] }));
app.use(express.text({ limit: "5mb", type: ["text/*"] }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// 1) 세션 생성 + Glossary 1회 로드
app.post("/v1/session/init", async (req, res) => {
  const schema = z.object({
    category: z.string().optional().default(""),
    sourceLang: z.string().optional().default("ko-KR"),
    targetLang: z.string().optional().default("en-US"),
    sessionId: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { category, sourceLang, targetLang } = parsed.data;
  const sessionId = parsed.data.sessionId?.trim() || crypto.randomUUID();

  try {
    const session = await loadSessionGlossary(sessionId, { category, sourceLang, targetLang });
    return res.status(200).json({
      sessionId,
      category: session.category,
      sourceLang: session.sourceLang,
      targetLang: session.targetLang,
      glossaryVersion: session.glossaryVersion,
      termCount: session.termCount,
      updatedAt: session.updatedAt,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// 2) Glossary 업데이트: sessionId 없으면 “프로세스 전역 갱신”, 있으면 “세션만 갱신”
app.post("/v1/glossary/update", async (req, res) => {
  const schema = z.object({
    sessionId: z.string().optional(),
    category: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLang: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const sessionId = parsed.data.sessionId?.trim();

  try {
    if (!sessionId) {
      const info = await reloadAllInThisProcess();
      return res.status(200).json({
        ok: true,
        mode: "process",
        glossaryLoadedAt: processGlossaryCache?.loadedAt,
        sessionCount: info.sessionCount,
      });
    }

    const current = sessions.get(sessionId);
    if (!current) return res.status(404).json({ error: "Unknown sessionId." });

    const category = parsed.data.category ?? current.category;
    const sourceLang = parsed.data.sourceLang ?? current.sourceLang;
    const targetLang = parsed.data.targetLang ?? current.targetLang;

    const session = await loadSessionGlossary(sessionId, { category, sourceLang, targetLang });
    return res.status(200).json({
      ok: true,
      mode: "session",
      sessionId,
      category: session.category,
      sourceLang: session.sourceLang,
      targetLang: session.targetLang,
      glossaryVersion: session.glossaryVersion,
      termCount: session.termCount,
      updatedAt: session.updatedAt,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// 3) Phase 1 치환: sessionId 없으면 즉시 수행(프로세스 캐시)
app.post("/v1/translate/replace", async (req, res) => {
  const schema = z.object({
    sessionId: z.string().optional(),
    category: z.string().optional(),
    sourceLang: z.string().optional().default("ko-KR"),
    targetLang: z.string().optional().default("en-US"),
    texts: z.array(z.string()).min(1).max(200),
    includeLogs: z.boolean().optional().default(true),
    limit: z.number().int().min(1).max(200).optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { texts } = parsed.data;
  const sessionId = parsed.data.sessionId?.trim();
  const includeLogs = parsed.data.includeLogs ?? true;

  let s = null;
  let mode = "process";

  if (sessionId) {
    const found = sessions.get(sessionId);
    if (!found) return res.status(404).json({ error: "Unknown sessionId. Call /v1/session/init first." });
    s = found;
    mode = "session";
  }

  const limit = parsed.data.limit ?? texts.length;
  const sliced = texts.slice(0, limit);

  let pairsSorted = null;
  let meta = {
    category: s?.category ?? normalizeCategory(parsed.data.category ?? ""),
    sourceLang: s?.sourceLang ?? normalizeLang(parsed.data.sourceLang),
    targetLang: s?.targetLang ?? normalizeLang(parsed.data.targetLang),
    glossaryVersion: s?.glossaryVersion ?? undefined,
    glossaryLoadedAt: s ? undefined : undefined,
    termCount: s?.termCount ?? 0,
  };

  if (!s) {
    await ensureProcessGlossaryLoaded(false);
    const built = getPairsFromProcessCache({
      category: meta.category,
      sourceLang: meta.sourceLang,
      targetLang: meta.targetLang,
    });
    pairsSorted = built?.pairsSorted ?? [];
    meta.termCount = built?.count ?? 0;
    meta.glossaryLoadedAt = processGlossaryCache?.loadedAt;
    meta.glossaryVersion = sha1(`${meta.glossaryLoadedAt}|${meta.category}|${meta.sourceLang}|${meta.targetLang}`);
  } else {
    pairsSorted = s.pairsSorted;
  }

  const results = [];
  const outTexts = [];
  const logs = [];
  const missing = new Set();

  for (const t of sliced) {
    const { output, hits } = applyReplacements(t, pairsSorted);

    if ((hits?.length ?? 0) === 0) {
      missing.add("(no glossary hit in some lines)");
    }

    results.push({ input: t, output, replacements: hits });
    outTexts.push(output);
    if (includeLogs) logs.push(hits);
  }

  return res.status(200).json({
    ok: true,
    mode,
    sessionId: sessionId || undefined,
    glossaryVersion: meta.glossaryVersion,
    glossaryLoadedAt: meta.glossaryLoadedAt,
    category: meta.category,
    sourceLang: meta.sourceLang,
    targetLang: meta.targetLang,
    texts: outTexts,
    logs: includeLogs ? logs : undefined,
    results,
    notes: missing.size ? [...missing] : [],
  });
});

// ---------------- MCP 유지: /mcp ----------------
const mcp = new McpServer({ name: "sheets-glossary-mcp", version: "1.0.0" });

// MCP: Glossary 강제 업데이트 (프로세스 캐시 + 현재 프로세스 세션 재빌드)
mcp.tool(
  "glossary_update",
  { force: z.boolean().optional() },
  async ({ force }) => {
    const info = force
      ? await reloadAllInThisProcess()
      : await ensureProcessGlossaryLoaded(false).then(() => ({
          loadedAt: processGlossaryCache?.loadedAt,
          sessionCount: sessions.size,
        }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              glossaryLoadedAt: processGlossaryCache?.loadedAt,
              sessionCount: info.sessionCount,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

mcp.tool(
  "session_init",
  {
    category: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLang: z.string().optional(),
  },
  async ({ category, sourceLang, targetLang }) => {
    const sessionId = crypto.randomUUID();
    const session = await loadSessionGlossary(sessionId, {
      category: category ?? "",
      sourceLang: sourceLang ?? "ko-KR",
      targetLang: targetLang ?? "en-US",
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionId,
              category: session.category,
              sourceLang: session.sourceLang,
              targetLang: session.targetLang,
              glossaryVersion: session.glossaryVersion,
              termCount: session.termCount,
              updatedAt: session.updatedAt,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

mcp.tool(
  "replace_batch",
  {
    sessionId: z.string(),
    texts: z.array(z.string()).min(1).max(200),
  },
  async ({ sessionId, texts }) => {
    const s = sessions.get(sessionId);
    if (!s) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Unknown sessionId" }, null, 2) }],
      };
    }

    const results = texts.map((t) => {
      const { output, hits } = applyReplacements(t, s.pairsSorted);
      return { input: t, output, replacements: hits };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { sessionId, glossaryVersion: s.glossaryVersion, results },
            null,
            2
          ),
        },
      ],
    };
  }
);

app.all("/mcp", async (req, res) => {
  let body = req.body;
  if (typeof body === "string") body = safeJsonParse(body, body);

  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => transport.close());

  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
});

app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
