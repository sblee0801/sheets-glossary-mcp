/**
 * server.mjs (Polished)
 *
 * 목적:
 * - “대화형 웹 세션”에서 Glossary를 1회 로드(세션 캐시)하고
 * - 사용자가 명시적으로 “Glossary 업데이트”를 요청하기 전까지
 *   동일 Glossary 기준으로 치환(Glossary Lock)만 수행
 *
 * 엔드포인트:
 * - GET  /              : 연결 확인(상태 JSON)
 * - GET  /healthz       : Liveness (외부 의존성 없이 항상 200)
 * - GET  /readyz        : Readiness (Sheets 연결/권한/범위 체크)
 * - POST /v1/session/init      : 세션 생성 + Glossary 1회 로드
 * - POST /v1/translate/replace : 세션 Glossary로 용어 치환(Phase 1)
 * - POST /v1/glossary/update   : 세션 Glossary 강제 갱신
 * - (옵션) /mcp         : MCP 연결 유지
 *
 * 설계 포인트:
 * - 서버 부팅 시점에는 외부 의존성(Sheets)을 강제하지 않음 → Cloud Run 안정성
 * - /readyz에서만 실제 Sheets 호출로 “정상 연결” 확인 가능
 * - Glossary는 세션 단위로 1회 로드 (요청마다 Sheets 재호출하지 않음)
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
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// “부팅 안정성”을 위해 여기서 throw 하지 않습니다.
// 대신 /readyz 및 실제 로딩 시점에서 오류를 명확히 반환합니다.
function envSummary() {
  return {
    PORT,
    SPREADSHEET_ID: Boolean(SPREADSHEET_ID),
    SHEET_NAME: SHEET_NAME || "",
    GOOGLE_SERVICE_ACCOUNT_JSON: Boolean(GOOGLE_SERVICE_ACCOUNT_JSON),
  };
}

// ---------------- Logging / Safety ----------------
function nowIso() {
  return new Date().toISOString();
}

function log(level, msg, extra = undefined) {
  // Cloud Logging에서 구조화 로그로 보기 좋게 JSON 형태 유지
  const base = { ts: nowIso(), level, msg };
  if (extra !== undefined) {
    console.log(JSON.stringify({ ...base, ...extra }));
  } else {
    console.log(JSON.stringify(base));
  }
}

process.on("unhandledRejection", (err) => {
  log("error", "unhandledRejection", { err: String(err?.stack || err) });
});
process.on("uncaughtException", (err) => {
  log("error", "uncaughtException", { err: String(err?.stack || err) });
  // 의도적으로 즉시 종료하지 않음 (Cloud Run에서 restart loop 방지 관점)
});

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
  if (!text || !pairs || pairs.length === 0) {
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

// ---------------- Google Sheets Client ----------------
// 간단한 “프로세스 단위” 캐시: 매번 auth 생성 비용을 줄이기 위함
let _sheetsClient = null;

function getSheetsClientOrThrow() {
  if (_sheetsClient) return _sheetsClient;

  if (!SPREADSHEET_ID) {
    throw new Error("SPREADSHEET_ID is missing. Check env.");
  }
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing. Check env.");
  }

  const serviceAccount = safeJsonParse(GOOGLE_SERVICE_ACCOUNT_JSON, null);
  if (!serviceAccount) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  _sheetsClient = sheets;
  return sheets;
}

// ---------------- Sheets Reader (I:U only) ----------------
async function readGlossaryIU() {
  const sheets = getSheetsClientOrThrow();

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

  // 스프레드시트 기준: I=분류, ... T=LEN, U=TERM (헤더 대소문자/위치 변동 가능)
  const idx = {
    category: header.indexOf("분류"),
    term: header.indexOf("term"),
    len: header.indexOf("len"),
  };

  if (idx.term < 0) {
    throw new Error("I:U 범위 헤더에 TERM(또는 term)이 없습니다. U열 헤더가 'TERM'인지 확인하세요.");
  }

  // 언어 컬럼 인덱스 맵: 예) ko-kr, en-us ...
  const langIndex = {};
  for (let i = 0; i < header.length; i++) {
    if (i === idx.term || i === idx.len || i === idx.category) continue;

    const h = header[i];
    if (!h) continue;

    // locale 형태면 언어 컬럼로 인정
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
/**
 * sessions.get(sessionId) = {
 *   createdAt,
 *   updatedAt,
 *   category,
 *   sourceLang,
 *   targetLang,
 *   glossaryVersion,
 *   map,             // Map<sourceTerm, targetTerm>
 *   pairsSorted,     // [{ko,en}] length desc
 *   termCount
 * }
 */
const sessions = new Map();

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
    const srcTerm = String(r.translations?.[src] ?? "").trim();
    const tgtTerm = String(r.translations?.[tgt] ?? "").trim();
    if (!srcTerm || !tgtTerm) continue;

    // 중복 sourceTerm 정책: 첫 값 유지
    if (!map.has(srcTerm)) map.set(srcTerm, tgtTerm);
  }

  const pairsSorted = [...map.entries()]
    .map(([ko, en]) => ({ ko, en }))
    .sort((a, b) => b.ko.length - a.ko.length);

  return { map, pairsSorted, count: pairsSorted.length };
}

async function loadSessionGlossary(sessionId, { category, sourceLang, targetLang }) {
  const { data } = await readGlossaryIU();
  const built = buildGlossaryMap(data, category, sourceLang, targetLang);

  const existing = sessions.get(sessionId);

  const session = {
    createdAt: existing?.createdAt ?? nowIso(),
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

// body parsing
app.use(express.json({ limit: "5mb", type: ["application/json", "application/*+json"] }));
app.use(express.text({ limit: "5mb", type: ["text/*"] }));

// 요청 로깅(필요 시 줄일 수 있음)
app.use((req, _res, next) => {
  log("info", "request", { method: req.method, path: req.path });
  next();
});

// 0) Root: “연결 확인”용 상태 JSON (단순 OK가 아니라 의미 있는 진단 정보)
app.get("/", (_req, res) => {
  const uptimeSec = Math.floor(process.uptime());
  const summary = envSummary();

  res.status(200).json({
    status: "OK",
    service: "sheets-glossary-mcp",
    time: nowIso(),
    uptimeSec,
    env: summary,
    sessions: {
      count: sessions.size,
    },
    endpoints: {
      healthz: "/healthz",
      readyz: "/readyz",
      sessionInit: "/v1/session/init",
      replace: "/v1/translate/replace",
      glossaryUpdate: "/v1/glossary/update",
    },
  });
});

// 0-1) Liveness: 외부 의존성 없이 항상 OK
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// 0-2) Readiness: Sheets 연결/권한/범위 접근 확인
app.get("/readyz", async (_req, res) => {
  try {
    // 최소 범위(I1:U1)만 읽어서 “연결”을 확인
    const sheets = getSheetsClientOrThrow();
    const range = `${SHEET_NAME}!I1:U1`;

    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });

    const header = r?.data?.values?.[0] ?? [];

    return res.status(200).json({
      status: "OK",
      sheets: {
        spreadsheetIdPresent: Boolean(SPREADSHEET_ID),
        sheetName: SHEET_NAME,
        range,
        headerCells: header.length,
      },
      time: nowIso(),
    });
  } catch (e) {
    return res.status(500).json({
      status: "NOT_READY",
      error: String(e?.message || e),
      env: envSummary(),
      time: nowIso(),
    });
  }
});

// ---------------- API ----------------

// 1) 세션 생성 + Glossary 1회 로드
app.post("/v1/session/init", async (req, res) => {
  const schema = z.object({
    category: z.string().optional().default(""),
    sourceLang: z.string().optional().default("ko-KR"),
    targetLang: z.string().optional().default("en-US"),
    sessionId: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

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
    log("error", "session_init_failed", { err: String(e?.stack || e) });
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// 2) Glossary 업데이트(명시적 갱신)
app.post("/v1/glossary/update", async (req, res) => {
  const schema = z.object({
    sessionId: z.string(),
    category: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLang: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { sessionId } = parsed.data;
  const current = sessions.get(sessionId);
  if (!current) return res.status(404).json({ error: "Unknown sessionId." });

  const category = parsed.data.category ?? current.category;
  const sourceLang = parsed.data.sourceLang ?? current.sourceLang;
  const targetLang = parsed.data.targetLang ?? current.targetLang;

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
    log("error", "glossary_update_failed", { err: String(e?.stack || e) });
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// 3) 대량 치환(Phase 1: Glossary Lock only)
app.post("/v1/translate/replace", async (req, res) => {
  const schema = z.object({
    sessionId: z.string(),
    texts: z.array(z.string()).min(1).max(200),
    limit: z.number().int().min(1).max(200).optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { sessionId, texts } = parsed.data;
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: "Unknown sessionId. Call /v1/session/init first." });

  const limit = parsed.data.limit ?? texts.length;
  const sliced = texts.slice(0, limit);

  const results = [];
  let noHitCount = 0;

  for (const t of sliced) {
    const { output, hits } = applyReplacements(t, s.pairsSorted);
    if ((hits?.length ?? 0) === 0) noHitCount++;

    results.push({
      input: t,
      output,
      replacements: hits,
    });
  }

  return res.status(200).json({
    sessionId,
    glossaryVersion: s.glossaryVersion,
    category: s.category,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    results,
    notes: noHitCount > 0 ? [`no glossary hit in ${noHitCount} line(s)`] : [],
  });
});

// ---------------- (선택) MCP 유지: /mcp ----------------
const mcp = new McpServer({ name: "sheets-glossary-mcp", version: "1.0.0" });

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
          text: JSON.stringify({ sessionId, glossaryVersion: s.glossaryVersion, results }, null, 2),
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

// ---------------- 404 / Error Handling ----------------
app.use((_req, res) => {
  res.status(404).json({ error: "Not Found" });
});

app.use((err, _req, res, _next) => {
  log("error", "express_error", { err: String(err?.stack || err) });
  res.status(500).json({ error: "Internal Server Error" });
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  log("info", "server_started", { port: PORT, env: envSummary() });
});
