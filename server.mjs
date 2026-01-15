import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { google } from "googleapis";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * ============================================================
 * ROZ Glossary Server (Cloud Run, Node.js ESM)
 *
 * 요구사항 반영:
 * - Google Sheets 기반 Glossary
 * - A열 KEY, I열 분류(category), K~U 언어 컬럼(ko-KR, en-US, th-TH 등)
 * - V열 TERM은 무시 (ko-KR과 동일)
 * - Glossary는 세션당 1회 로드 후 메모리 고정
 * - 사용자가 "Glossary 업데이트" 요청(/v1/glossary/update) 전까지 재로딩 금지
 * - 행 개수(예: 5000개)는 "온전히" 로드 (중복/필터로 제거하지 않음)
 * - 매칭 입력 언어는 2개만: ko-KR 또는 en-US
 * - targetLang은 th-TH 포함, K~U에 존재하는 어떤 언어도 가능
 * - 긴 문자열 우선 치환 (substring 치환)
 *
 * REST:
 * - POST /v1/session/init
 * - POST /v1/translate/replace
 * - POST /v1/glossary/update
 * - GET  /v1/glossary/raw   (원본 row 읽기, 선택적 but 요청사항 반영)
 * - GET  /healthz
 *
 * MCP:
 * - /mcp endpoint 유지
 * - get_glossary            (페이지네이션 지원)
 * - lookup_text             (sourceLang=ko-KR|en-US 기준으로 targetLang 반환)
 * - read_sheet_rows         (원본 row 읽기)
 * ============================================================
 */

const PORT = Number(process.env.PORT || 8080);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Glossary";

/**
 * ✅ TERM(V열) 완전 무시 → A:U만 읽음
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

/** 허용 sourceLang: ko-kr | en-us */
function assertAllowedSourceLang(sourceLangKey) {
  if (sourceLangKey !== "ko-kr" && sourceLangKey !== "en-us") {
    const err = new Error("sourceLang must be ko-KR or en-US");
    err.status = 400;
    throw err;
  }
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
  const rows = values.slice(1); // raw rows (cells[])

  return { header, rows };
}

/**
 * Glossary 전체 로드
 * - ✅ rawRows를 "그대로" 저장 (원본 row 읽기용)
 * - ✅ entries는 "필터링 없이" 모든 row를 entries로 생성 (행 개수 보존)
 * - 언어컬럼은 헤더 기반으로 동적으로 수집
 */
async function loadGlossaryAll() {
  const { header, rows } = await readSheetRange();
  const loadedAt = new Date().toISOString();

  if (!header.length) {
    return {
      loadedAt,
      header: [],
      rawRows: [],
      entries: [],
      rawRowCount: 0,
      langIndex: {},
      idx: { key: -1, category: -1 },
    };
  }

  const norm = header.map(normalizeHeader);

  const idxKey = norm.indexOf("key");
  const idxCategory = norm.indexOf("분류"); // 시트 헤더명이 '분류'라고 가정(확정 구조)

  if (idxKey < 0) throw new Error("헤더에 KEY가 없습니다. A열 헤더가 'KEY'인지 확인하세요.");
  if (idxCategory < 0)
    throw new Error("헤더에 분류가 없습니다. I열 헤더가 '분류'인지 확인하세요.");

  // 언어컬럼 후보: 제외 목록 외 전부
  const excluded = new Set([
    "key",
    "분류",
    "category",
    "term", // 범위 밖이지만 혹시 있더라도 제외
    "len",
    "length",
    "note",
    "notes",
    "번역메모",
    "클리펀트",
    "우선순위",
    "priority",
    "src_lang",
    "match_type",
  ]);

  const langIndex = {};
  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    if (!h) continue;
    if (excluded.has(h)) continue;
    langIndex[h] = i; // e.g. ko-kr, en-us, th-th ...
  }

  // ko-KR은 반드시 있어야 함 (프로젝트 기준)
  if (langIndex["ko-kr"] == null) {
    throw new Error("헤더에 ko-KR이 없습니다. 언어 컬럼 헤더가 'ko-KR'인지 확인하세요.");
  }

  // ✅ rows를 entries로 "온전히" 변환 (필터링 없음)
  const entries = rows.map((r, rowIdx) => {
    const key = String(r[idxKey] ?? "").trim();
    const category = String(r[idxCategory] ?? "").trim();

    const translations = {};
    for (const [langKey, colIdx] of Object.entries(langIndex)) {
      const v = String(r[colIdx] ?? "").trim();
      // 메모리 최적화: 값이 있는 번역만 저장(행 자체는 entries에 유지됨)
      if (v) translations[langKey] = v;
    }

    return {
      _rowIndex: rowIdx + 2, // sheet row number (header=1)
      key,
      category,
      translations,
    };
  });

  return {
    loadedAt,
    header,
    rawRows: rows,
    entries,
    rawRowCount: rows.length,
    langIndex,
    idx: { key: idxKey, category: idxCategory },
  };
}

// ---------------- Index Build (Preserve duplicates) ----------------
/**
 * byCategoryBySource:
 *   Map<categoryLower, Map<sourceLangKey, Map<sourceText, entry[]>>>
 *
 * - ✅ 중복(동일 sourceText 여러 행) 보존: entry[]로 축적
 * - sourceLangKey: "ko-kr" | "en-us"
 */
function buildIndexBySourcePreserveDuplicates(entries, sourceLangKeys = ["ko-kr", "en-us"]) {
  const byCategoryBySource = new Map();

  for (const e of entries) {
    const cat = String(e.category ?? "").trim().toLowerCase();
    if (!cat) continue;

    if (!byCategoryBySource.has(cat)) byCategoryBySource.set(cat, new Map());
    const bySource = byCategoryBySource.get(cat);

    for (const src of sourceLangKeys) {
      // sourceText는 해당 언어 컬럼 값
      const sourceText = String(e.translations?.[src] ?? "").trim();
      if (!sourceText) continue; // 소스 텍스트가 없으면 해당 인덱스에는 못 넣음

      if (!bySource.has(src)) bySource.set(src, new Map());
      const textMap = bySource.get(src);

      if (!textMap.has(sourceText)) textMap.set(sourceText, []);
      textMap.get(sourceText).push(e);
    }
  }

  return byCategoryBySource;
}

// ---------------- Replace Logic (Phase 1) ----------------
/**
 * 긴 문자열 우선 치환 (substring)
 * - 동일 sourceText 중복이 존재하면:
 *   "시트에서 먼저 등장한 것 중 targetLang 값이 존재하는 첫 후보"를 사용
 */
function replaceByGlossary({ text, targetLangKey, sourceTextMap }) {
  if (typeof text !== "string") text = String(text ?? "");
  if (!text) return { out: "", replacedTotal: 0 };

  const terms = Array.from(sourceTextMap.keys()).sort((a, b) => b.length - a.length);

  let out = text;
  let replacedTotal = 0;

  for (const term of terms) {
    const candidates = sourceTextMap.get(term) || [];

    // 중복 후보 중 타겟 번역이 있는 첫 후보 선택(결정적)
    let target = "";
    for (const c of candidates) {
      const v = c?.translations?.[targetLangKey];
      if (v && String(v).trim()) {
        target = String(v).trim();
        break;
      }
    }
    if (!target) continue;

    const re = new RegExp(escapeRegExp(term), "g");
    let localCount = 0;
    out = out.replace(re, () => {
      localCount += 1;
      return target;
    });
    replacedTotal += localCount;
  }

  return { out, replacedTotal };
}

// ---------------- REST Session Cache ----------------
/**
 * sessions.get(sessionId) = {
 *   sessionId,
 *   categoryKey,
 *   sourceLangKey ("ko-kr"|"en-us"),
 *   targetLangKey,
 *   glossary: { loadedAt, rawRowCount, header, rawRows, entries, langIndex, byCategoryBySource }
 * }
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

// ---------------- REST Schemas ----------------
const InitSchema = z.object({
  category: z.string().min(1),
  sourceLang: z.string().min(1), // ko-KR or en-US
  targetLang: z.string().min(1), // th-TH 등
});

const ReplaceSchema = z.object({
  sessionId: z.string().min(1),
  texts: z.array(z.string()).min(1),
});

const UpdateSchema = z.object({
  sessionId: z.string().min(1),
});

// ---------------- HTTP App ----------------
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
 * - 세션당 1회 Glossary 로드 → 메모리 고정
 * - category / sourceLang(ko-KR|en-US) / targetLang 설정
 */
app.post("/v1/session/init", async (req, res) => {
  try {
    const { category, sourceLang, targetLang } = InitSchema.parse(req.body);

    const categoryKey = String(category).trim().toLowerCase();
    const sourceLangKey = normalizeLang(sourceLang);
    const targetLangKey = normalizeLang(targetLang);

    assertAllowedSourceLang(sourceLangKey);

    const loaded = await loadGlossaryAll();

    // sourceLangKey가 en-us인데 시트에 en-us 컬럼이 아예 없다면 오류
    if (sourceLangKey === "en-us" && loaded.langIndex["en-us"] == null) {
      return res.status(400).json({
        ok: false,
        error: "Header does not include en-US. Cannot use sourceLang=en-US.",
      });
    }

    // 인덱스는 ko-kr/en-us 모두 구성(향후 세션 변경에도 재사용 가능)
    const byCategoryBySource = buildIndexBySourcePreserveDuplicates(loaded.entries, ["ko-kr", "en-us"]);

    if (!byCategoryBySource.has(categoryKey)) {
      return res.status(400).json({
        ok: false,
        error: `Category not found in glossary index: ${category}`,
      });
    }

    const bySource = byCategoryBySource.get(categoryKey);
    const sourceTextMap = bySource?.get(sourceLangKey);
    if (!sourceTextMap || sourceTextMap.size === 0) {
      return res.status(400).json({
        ok: false,
        error: `No source texts found for category='${categoryKey}' and sourceLang='${sourceLangKey}'.`,
      });
    }

    const sessionId = newSessionId();
    sessions.set(sessionId, {
      sessionId,
      categoryKey,
      sourceLangKey,
      targetLangKey,
      glossary: {
        loadedAt: loaded.loadedAt,
        rawRowCount: loaded.rawRowCount,
        header: loaded.header,
        rawRows: loaded.rawRows,
        entries: loaded.entries, // ✅ 행 보존 (5000개면 5000개)
        langIndex: loaded.langIndex,
        byCategoryBySource,
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
 * - Phase 1: Glossary 치환만 수행
 * - 세션 캐시 사용 (시트 재조회 없음)
 */
app.post("/v1/translate/replace", async (req, res) => {
  try {
    const { sessionId, texts } = ReplaceSchema.parse(req.body);
    const s = getSessionOrThrow(sessionId);

    const bySource = s.glossary.byCategoryBySource.get(s.categoryKey);
    const sourceTextMap = bySource?.get(s.sourceLangKey);
    if (!sourceTextMap) {
      return res.status(400).json({
        ok: false,
        error: `Source index missing for category='${s.categoryKey}', sourceLang='${s.sourceLangKey}'`,
      });
    }

    const outTexts = [];
    let replacedTotal = 0;

    for (const t of texts) {
      const { out, replacedTotal: c } = replaceByGlossary({
        text: t,
        targetLangKey: s.targetLangKey,
        sourceTextMap,
      });
      outTexts.push(out);
      replacedTotal += c;
    }

    return res.status(200).json({
      ok: true,
      sessionId,
      category: s.categoryKey,
      sourceLang: s.sourceLangKey,
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
 * - 사용자가 명시적으로 업데이트 요청했을 때만 재로딩
 */
app.post("/v1/glossary/update", async (req, res) => {
  try {
    const { sessionId } = UpdateSchema.parse(req.body);
    const s = getSessionOrThrow(sessionId);

    const loaded = await loadGlossaryAll();

    if (s.sourceLangKey === "en-us" && loaded.langIndex["en-us"] == null) {
      return res.status(400).json({
        ok: false,
        error: "Header does not include en-US. Cannot keep sourceLang=en-US after reload.",
      });
    }

    const byCategoryBySource = buildIndexBySourcePreserveDuplicates(loaded.entries, ["ko-kr", "en-us"]);

    if (!byCategoryBySource.has(s.categoryKey)) {
      return res.status(400).json({
        ok: false,
        error: `Category not found after reload: ${s.categoryKey}`,
      });
    }

    const bySource = byCategoryBySource.get(s.categoryKey);
    const sourceTextMap = bySource?.get(s.sourceLangKey);
    if (!sourceTextMap || sourceTextMap.size === 0) {
      return res.status(400).json({
        ok: false,
        error: `No source texts found after reload for category='${s.categoryKey}', sourceLang='${s.sourceLangKey}'.`,
      });
    }

    s.glossary = {
      loadedAt: loaded.loadedAt,
      rawRowCount: loaded.rawRowCount,
      header: loaded.header,
      rawRows: loaded.rawRows,
      entries: loaded.entries,
      langIndex: loaded.langIndex,
      byCategoryBySource,
    };
    sessions.set(sessionId, s);

    return res.status(200).json({
      ok: true,
      sessionId,
      category: s.categoryKey,
      sourceLang: s.sourceLangKey,
      targetLang: s.targetLangKey,
      glossaryLoadedAt: loaded.loadedAt,
      rawRowCount: loaded.rawRowCount,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * GET /v1/glossary/raw?sessionId=...&offset=0&limit=200
 * - "시트 원본 row 읽기" (REST)
 */
app.get("/v1/glossary/raw", (req, res) => {
  try {
    const sessionId = String(req.query?.sessionId ?? "").trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId is required" });

    const offset = Math.max(0, Number(req.query?.offset ?? 0));
    const limit = Math.min(2000, Math.max(1, Number(req.query?.limit ?? 200)));

    const s = getSessionOrThrow(sessionId);

    const header = s.glossary.header || [];
    const rawRows = s.glossary.rawRows || [];

    const slice = rawRows.slice(offset, offset + limit).map((cells, i) => ({
      rowIndex: offset + i + 2,
      cells,
    }));

    return res.status(200).json({
      ok: true,
      sessionId,
      loadedAt: s.glossary.loadedAt,
      rawRowCount: rawRows.length,
      header,
      offset,
      limit,
      count: slice.length,
      rows: slice,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

// ---------------- MCP (Compatibility + Tools) ----------------
const mcp = new McpServer({
  name: "sheets-glossary-mcp",
  version: "2.0.0",
});

/**
 * MCP 캐시(프로세스 단위 1회 로드)
 * - 사용자가 forceReload를 주지 않는 한 고정
 * - Cloud Run 인스턴스가 재시작되면 자연스럽게 초기화(정상)
 */
let mcpCache = null;
/**
 * mcpCache = {
 *   loadedAt, header, rawRows, entries, rawRowCount, langIndex, byCategoryBySource
 * }
 */
async function ensureMcpLoaded(forceReload = false) {
  if (mcpCache && !forceReload) return mcpCache;

  const loaded = await loadGlossaryAll();
  const byCategoryBySource = buildIndexBySourcePreserveDuplicates(loaded.entries, ["ko-kr", "en-us"]);

  mcpCache = {
    loadedAt: loaded.loadedAt,
    header: loaded.header,
    rawRows: loaded.rawRows,
    entries: loaded.entries,
    rawRowCount: loaded.rawRowCount,
    langIndex: loaded.langIndex,
    byCategoryBySource,
  };
  return mcpCache;
}

/**
 * MCP: get_glossary
 * - category 필터 가능
 * - lang 지정 시 해당 언어만(없으면 translations 전체)
 * - offset/limit 페이지네이션
 */
mcp.tool(
  "get_glossary",
  {
    category: z.string().optional(),
    lang: z.string().optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
    forceReload: z.boolean().optional(),
  },
  async ({ category, lang, offset, limit, forceReload }) => {
    const cache = await ensureMcpLoaded(Boolean(forceReload));

    const catKey = category ? String(category).trim().toLowerCase() : "";
    const langKey = lang ? normalizeLang(lang) : "";

    const off = Math.max(0, Number(offset ?? 0));
    const lim = Math.min(2000, Math.max(1, Number(limit ?? 500)));

    const filtered = [];
    for (const e of cache.entries) {
      const eCat = String(e.category ?? "").trim().toLowerCase();
      if (catKey && eCat !== catKey) continue;
      filtered.push(e);
    }

    const page = filtered.slice(off, off + lim);
    const out = page.map((e) => {
      if (!langKey) {
        return {
          key: e.key || undefined,
          category: e.category || undefined,
          translations: e.translations || {},
          _rowIndex: e._rowIndex,
        };
      }
      return {
        key: e.key || undefined,
        category: e.category || undefined,
        lang: langKey,
        text: e.translations?.[langKey] ?? "",
        _rowIndex: e._rowIndex,
      };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              loadedAt: cache.loadedAt,
              rawRowCount: cache.rawRowCount,
              filteredCount: filtered.length,
              offset: off,
              limit: lim,
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
 * MCP: lookup_text
 * - sourceLang: ko-KR|en-US 기준으로 "정확 일치" 조회
 * - category 옵션 필터
 * - targetLang을 주면 해당 언어 값만 간단히 반환 가능
 * - 중복 행은 results[]로 모두 반환 (행 보존)
 */
mcp.tool(
  "lookup_text",
  {
    text: z.string(),
    sourceLang: z.string(), // ko-KR | en-US
    targetLang: z.string().optional(), // th-TH 등
    category: z.string().optional(),
    forceReload: z.boolean().optional(),
  },
  async ({ text, sourceLang, targetLang, category, forceReload }) => {
    const cache = await ensureMcpLoaded(Boolean(forceReload));

    const sourceLangKey = normalizeLang(sourceLang);
    assertAllowedSourceLang(sourceLangKey);

    const targetLangKey = targetLang ? normalizeLang(targetLang) : "";
    const catKey = category ? String(category).trim().toLowerCase() : "";
    const needle = String(text ?? "").trim();

    const out = [];

    // 인덱스 사용 (정확 일치)
    if (catKey) {
      const bySource = cache.byCategoryBySource.get(catKey);
      const map = bySource?.get(sourceLangKey);
      const candidates = map?.get(needle) || [];
      for (const e of candidates) {
        out.push({
          key: e.key || undefined,
          category: e.category || undefined,
          sourceLang: sourceLangKey,
          sourceText: needle,
          targetLang: targetLangKey || undefined,
          targetText: targetLangKey ? e.translations?.[targetLangKey] ?? "" : undefined,
          translations: targetLangKey ? undefined : (e.translations || {}),
          _rowIndex: e._rowIndex,
        });
      }
    } else {
      // category 미지정: 모든 category를 순회
      for (const [cat, bySource] of cache.byCategoryBySource.entries()) {
        const map = bySource.get(sourceLangKey);
        const candidates = map?.get(needle) || [];
        for (const e of candidates) {
          out.push({
            key: e.key || undefined,
            category: e.category || cat,
            sourceLang: sourceLangKey,
            sourceText: needle,
            targetLang: targetLangKey || undefined,
            targetText: targetLangKey ? e.translations?.[targetLangKey] ?? "" : undefined,
            translations: targetLangKey ? undefined : (e.translations || {}),
            _rowIndex: e._rowIndex,
          });
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { found: out.length > 0, count: out.length, results: out },
            null,
            2
          ),
        },
      ],
    };
  }
);

/**
 * MCP: read_sheet_rows
 * - "시트 원본 row 읽기" 전용
 * - header 포함 옵션, offset/limit 페이지네이션
 * - category 필터(분류) 가능
 */
mcp.tool(
  "read_sheet_rows",
  {
    category: z.string().optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
    includeHeader: z.boolean().optional(),
    forceReload: z.boolean().optional(),
  },
  async ({ category, offset, limit, includeHeader, forceReload }) => {
    const cache = await ensureMcpLoaded(Boolean(forceReload));

    const off = Math.max(0, Number(offset ?? 0));
    const lim = Math.min(2000, Math.max(1, Number(limit ?? 200)));
    const catKey = category ? String(category).trim().toLowerCase() : "";

    let rowsOut = [];

    if (!catKey) {
      rowsOut = cache.rawRows.slice(off, off + lim).map((cells, i) => ({
        rowIndex: off + i + 2,
        cells,
      }));
    } else {
      // category 필터: entries의 _rowIndex를 이용해 rawRows에서 매핑
      const indices = [];
      for (const e of cache.entries) {
        const eCat = String(e.category ?? "").trim().toLowerCase();
        if (eCat === catKey) indices.push(e._rowIndex);
      }
      const page = indices.slice(off, off + lim);
      rowsOut = page.map((rowIndex) => ({
        rowIndex,
        cells: cache.rawRows[rowIndex - 2] ?? [],
      }));
    }

    const payload = {
      loadedAt: cache.loadedAt,
      range: SHEET_RANGE,
      rawRowCount: cache.rawRowCount,
      offset: off,
      limit: lim,
      count: rowsOut.length,
      rows: rowsOut,
    };
    if (includeHeader) payload.header = cache.header;

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  }
);

// MCP endpoint
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
  console.log(`REST: /v1/session/init, /v1/translate/replace, /v1/glossary/update, /v1/glossary/raw`);
  console.log(`MCP: /mcp (get_glossary, lookup_text, read_sheet_rows)`);
});
