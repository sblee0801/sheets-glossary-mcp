import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { google } from "googleapis";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT || 8080);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Glossary";

/**
 * ✅ TERM(V열) 무시: A~U만 읽음
 * (A=KEY, I=분류, K~U=언어 데이터)
 */
const SHEET_RANGE = process.env.SHEET_RANGE || `${SHEET_NAME}!A:U`;

if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is missing. Check env.");
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing. Check env.");

// ---------------- Helpers ----------------
function normalizeHeader(h) {
  return String(h ?? "").trim().toLowerCase();
}
function normalizeLang(lang) {
  if (!lang) return "";
  return String(lang).trim().toLowerCase().replace(/_/g, "-");
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function newSessionId() {
  return crypto.randomUUID?.() ?? crypto.randomBytes(16).toString("hex");
}
function getParsedBody(req) {
  if (req.body == null) return undefined;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return req.body;
    }
  }
  return req.body;
}

// ---------------- Google Sheets Read ----------------
async function readSheetRange() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
  });

  const values = res.data.values || [];
  if (values.length < 1) return { header: [], rows: [] };

  const header = (values[0] || []).map((h) => String(h ?? "").trim());
  const rows = values.slice(1);

  return { header, rows };
}

/**
 * Glossary 전체 로드 (중복 제거/필터 제거 없이 "온전히" 로드)
 * - 필수 헤더: KEY, 분류, ko-KR
 * - TERM은 읽지 않음(범위에 없음)
 */
async function loadGlossaryAll() {
  const { header, rows } = await readSheetRange();
  if (!header.length) {
    return {
      header: [],
      entries: [],
      rawRowCount: 0,
      langIndex: {},
      loadedAt: new Date().toISOString(),
    };
  }

  const norm = header.map(normalizeHeader);

  const idxKey = norm.indexOf("key");
  const idxCategory = norm.indexOf("분류"); // 시트 헤더가 '분류'라고 가정

  if (idxKey < 0) throw new Error("헤더에 KEY가 없습니다. A열 헤더가 'KEY'인지 확인하세요.");
  if (idxCategory < 0)
    throw new Error("헤더에 분류가 없습니다. I열 헤더가 '분류'인지 확인하세요.");

  const excluded = new Set([
    "key",
    "분류",
    "category",
    "term",
    "len",
    "length",
    "gt_lang",
    "note",
    "notes",
    "번역메모",
    "클리펀트",
    "우선순위",
    "priority",
    "src_lang",
    "match_type",
    "atch_type",
    "src_len",
    "trg_len",
  ]);

  const langIndex = {};
  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    if (!h) continue;
    if (excluded.has(h)) continue;
    langIndex[h] = i;
  }

  if (langIndex["ko-kr"] == null) {
    throw new Error("헤더에 ko-KR이 없습니다. 언어 컬럼 헤더가 'ko-KR'인지 확인하세요.");
  }

  // ✅ 행은 절대 필터링/중복제거 하지 않음
  const entries = rows.map((r, rowIdx) => {
    const key = String(r[idxKey] ?? "").trim();
    const category = String(r[idxCategory] ?? "").trim();
    const ko = String(r[langIndex["ko-kr"]] ?? "").trim();

    const translations = {};
    for (const [langKey, colIdx] of Object.entries(langIndex)) {
      const v = String(r[colIdx] ?? "").trim();
      // 값이 있는 것만 저장(메모리 절약) — 행 자체는 entries로 온전히 보존됨
      if (v) translations[langKey] = v;
    }

    return {
      _rowIndex: rowIdx + 2, // 시트 행 추적
      key,
      category,
      ko,
      translations,
    };
  });

  return {
    header,
    entries,
    rawRowCount: rows.length,
    langIndex,
    loadedAt: new Date().toISOString(),
  };
}

// ---------------- Session Cache (In-Memory) ----------------
/**
 * sessions.get(sessionId) = {
 *   sessionId,
 *   categoryKey, sourceLangKey, targetLangKey,
 *   glossary: { entries, rawRowCount, loadedAt, byCategoryKo }
 * }
 *
 * byCategoryKo: Map<categoryLower, Map<koString, entry[]>>
 * ✅ 중복 보존: entry[] 로 저장
 */
const sessions = new Map();

function getSessionOrThrow(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) {
    const err = new Error("Invalid sessionId (session not found or expired).");
    err.status = 404;
    throw err;
  }
  return s;
}

function buildIndexPreserveDuplicates(entries) {
  const byCategoryKo = new Map();

  for (const e of entries) {
    const cat = String(e.category ?? "").trim().toLowerCase();
    if (!cat) continue;

    const ko = String(e.ko ?? "").trim();
    if (!ko) continue; // 인덱스 제외(치환 기준 불가) — entries는 보존됨

    if (!byCategoryKo.has(cat)) byCategoryKo.set(cat, new Map());
    const koMap = byCategoryKo.get(cat);

    if (!koMap.has(ko)) koMap.set(ko, []);
    koMap.get(ko).push(e);
  }

  return byCategoryKo;
}

// ---------------- Replace Logic (Phase 1) ----------------
function replaceByGlossary({ text, targetLangKey, koMap }) {
  if (typeof text !== "string" || !text) {
    return { out: text ?? "", replacedTotal: 0 };
  }

  // ✅ 긴 문자열 우선(부분 중첩 방지)
  const terms = Array.from(koMap.keys()).sort((a, b) => b.length - a.length);

  let out = text;
  let replacedTotal = 0;

  for (const ko of terms) {
    const candidates = koMap.get(ko) || [];

    // ✅ 중복이 있어도 "시트에서 먼저 등장 + 타겟 값 존재" 첫 후보로 결정
    let target = "";
    for (const c of candidates) {
      const v = c?.translations?.[targetLangKey];
      if (v && String(v).trim()) {
        target = String(v).trim();
        break;
      }
    }
    if (!target) continue;

    const re = new RegExp(escapeRegExp(ko), "g");
    let localCount = 0;
    out = out.replace(re, () => {
      localCount += 1;
      return target;
    });
    replacedTotal += localCount;
  }

  return { out, replacedTotal };
}

// ---------------- REST API ----------------
const app = express();

app.use(
  express.json({
    limit: "8mb",
    type: ["application/json", "application/*+json"],
  })
);
app.use(express.text({ limit: "8mb", type: ["text/*"] }));

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
app.get("/", (_req, res) => res.status(200).send("ok"));

/**
 * POST /v1/session/init
 * body: { category, sourceLang, targetLang }
 */
app.post("/v1/session/init", async (req, res) => {
  try {
    const category = String(req.body?.category ?? "").trim();
    const sourceLang = String(req.body?.sourceLang ?? "ko-KR").trim();
    const targetLang = String(req.body?.targetLang ?? "").trim();

    if (!category) return res.status(400).json({ ok: false, error: "category is required" });
    if (!targetLang) return res.status(400).json({ ok: false, error: "targetLang is required" });

    const categoryKey = category.toLowerCase();
    const sourceLangKey = normalizeLang(sourceLang);
    const targetLangKey = normalizeLang(targetLang);

    const loaded = await loadGlossaryAll();
    const byCategoryKo = buildIndexPreserveDuplicates(loaded.entries);

    if (!byCategoryKo.has(categoryKey)) {
      return res.status(400).json({
        ok: false,
        error: `Category not found in glossary index: ${category}`,
      });
    }

    const sessionId = newSessionId();
    sessions.set(sessionId, {
      sessionId,
      categoryKey,
      sourceLangKey,
      targetLangKey,
      glossary: {
        entries: loaded.entries, // ✅ 5000개면 5000개 그대로 보존
        rawRowCount: loaded.rawRowCount,
        loadedAt: loaded.loadedAt,
        byCategoryKo,
      },
    });

    return res.status(200).json({
      ok: true,
      sessionId,
      category: categoryKey,
      sourceLang: sourceLangKey,
      targetLang: targetLangKey,
      glossaryLoadedAt: loaded.loadedAt,
      rawRowCount: loaded.rawRowCount,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * POST /v1/translate/replace
 * body: { sessionId, texts: string[] }
 */
app.post("/v1/translate/replace", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const texts = req.body?.texts;

    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId is required" });
    if (!Array.isArray(texts) || texts.length < 1)
      return res.status(400).json({ ok: false, error: "texts[] is required" });

    const s = getSessionOrThrow(sessionId);
    const koMap = s.glossary.byCategoryKo.get(s.categoryKey);
    if (!koMap) {
      return res.status(400).json({ ok: false, error: `Category not indexed: ${s.categoryKey}` });
    }

    const outTexts = [];
    let replacedTotal = 0;

    for (const t of texts) {
      const { out, replacedTotal: c } = replaceByGlossary({
        text: String(t ?? ""),
        targetLangKey: s.targetLangKey,
        koMap,
      });
      outTexts.push(out);
      replacedTotal += c;
    }

    return res.status(200).json({
      ok: true,
      sessionId,
      category: s.categoryKey,
      targetLang: s.targetLangKey,
      replacedTotal,
      texts: outTexts,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * POST /v1/glossary/update
 * body: { sessionId }
 */
app.post("/v1/glossary/update", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId is required" });

    const s = getSessionOrThrow(sessionId);

    const loaded = await loadGlossaryAll();
    const byCategoryKo = buildIndexPreserveDuplicates(loaded.entries);

    if (!byCategoryKo.has(s.categoryKey)) {
      return res.status(400).json({
        ok: false,
        error: `Category not found after reload: ${s.categoryKey}`,
      });
    }

    s.glossary = {
      entries: loaded.entries,
      rawRowCount: loaded.rawRowCount,
      loadedAt: loaded.loadedAt,
      byCategoryKo,
    };
    sessions.set(sessionId, s);

    return res.status(200).json({
      ok: true,
      sessionId,
      category: s.categoryKey,
      targetLang: s.targetLangKey,
      glossaryLoadedAt: loaded.loadedAt,
      rawRowCount: loaded.rawRowCount,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

// ---------------- MCP Compatibility (/mcp) ----------------
/**
 * 기존 ChatGPT Actions / MCP 클라이언트가 /mcp 를 호출하므로,
 * /mcp 를 다시 제공해서 404를 없애고, get_glossary / lookup_term 도구를 유지합니다.
 *
 * 주의:
 * - MCP 도구는 "REST 세션 캐시"와 별개로 동작할 수 있습니다.
 * - 여기서는 MCP에서도 성능을 위해 "프로세스 내 캐시(단일 캐시)"를 둡니다.
 */
const mcp = new McpServer({
  name: "sheets-glossary-mcp",
  version: "1.0.0",
});

let mcpGlossaryCache = null; // { loadedAt, entries, rawRowCount, byCategoryKo, langIndex }

async function ensureMcpGlossaryLoaded(forceReload = false) {
  if (mcpGlossaryCache && !forceReload) return mcpGlossaryCache;

  const loaded = await loadGlossaryAll();
  mcpGlossaryCache = {
    loadedAt: loaded.loadedAt,
    entries: loaded.entries, // ✅ 전체 행
    rawRowCount: loaded.rawRowCount,
    langIndex: loaded.langIndex,
    byCategoryKo: buildIndexPreserveDuplicates(loaded.entries),
  };
  return mcpGlossaryCache;
}

/**
 * ✅ get_glossary
 * - category(분류) 지정 시 해당 category의 모든 행 반환
 * - lang 지정 시 해당 언어만 포함해서 반환(없으면 빈 문자열)
 * - TERM은 없음/무시
 */
mcp.tool(
  "get_glossary",
  {
    category: z.string().optional(),
    lang: z.string().optional(),
    forceReload: z.boolean().optional(), // 필요 시 강제 재로딩
  },
  async ({ category, lang, forceReload }) => {
    const cache = await ensureMcpGlossaryLoaded(Boolean(forceReload));
    const catKey = category ? String(category).trim().toLowerCase() : "";
    const langKey = lang ? normalizeLang(lang) : "";

    const out = [];
    for (const e of cache.entries) {
      const eCat = String(e.category ?? "").trim().toLowerCase();
      if (catKey && eCat !== catKey) continue;

      if (!langKey) {
        out.push({
          key: e.key || undefined,
          category: e.category || undefined,
          ko: e.ko || "",
          translations: e.translations,
          _rowIndex: e._rowIndex,
        });
      } else {
        out.push({
          key: e.key || undefined,
          category: e.category || undefined,
          ko: e.ko || "",
          lang: langKey,
          translation: e.translations?.[langKey] ?? "",
          _rowIndex: e._rowIndex,
        });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              loadedAt: cache.loadedAt,
              rawRowCount: cache.rawRowCount,
              count: out.length,
              data: out,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

/**
 * ✅ lookup_term
 * - ko-KR 문자열로 정확 조회(완전 일치)
 * - category 옵션으로 범위 제한
 * - lang 지정 시 해당 언어만 반환
 */
mcp.tool(
  "lookup_term",
  {
    ko: z.string(), // ✅ ko-KR 기준
    category: z.string().optional(),
    lang: z.string().optional(),
    forceReload: z.boolean().optional(),
  },
  async ({ ko, category, lang, forceReload }) => {
    const cache = await ensureMcpGlossaryLoaded(Boolean(forceReload));
    const koKey = String(ko).trim();
    const catKey = category ? String(category).trim().toLowerCase() : "";
    const langKey = lang ? normalizeLang(lang) : "";

    const results = [];
    for (const e of cache.entries) {
      const eCat = String(e.category ?? "").trim().toLowerCase();
      if (catKey && eCat !== catKey) continue;
      if (String(e.ko ?? "").trim() !== koKey) continue;

      if (!langKey) {
        results.push({
          key: e.key || undefined,
          category: e.category || undefined,
          ko: e.ko || "",
          translations: e.translations,
          _rowIndex: e._rowIndex,
        });
      } else {
        results.push({
          key: e.key || undefined,
          category: e.category || undefined,
          ko: e.ko || "",
          lang: langKey,
          translation: e.translations?.[langKey] ?? "",
          _rowIndex: e._rowIndex,
        });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { found: results.length > 0, count: results.length, results },
            null,
            2
          ),
        },
      ],
    };
  }
);

// MCP endpoint (restore)
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  res.on("close", () => transport.close());

  await mcp.connect(transport);

  const body = getParsedBody(req);
  await transport.handleRequest(req, res, body);
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`Sheet range: ${SHEET_RANGE} (TERM ignored)`);
  console.log(`REST: /v1/session/init, /v1/translate/replace, /v1/glossary/update`);
  console.log(`MCP: /mcp (get_glossary, lookup_term)`);
});
