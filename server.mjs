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
 * ✅ TERM(V열) 무시 → A:U만 읽음
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
  const rows = values.slice(1);

  return { header, rows };
}

/**
 * Glossary 전체 로드 (온전히)
 * - rawRows 그대로 저장(원본 row 읽기)
 * - entries는 rows 길이만큼 모두 생성(필터링 없음)
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
    };
  }

  const norm = header.map(normalizeHeader);
  const idxKey = norm.indexOf("key");
  const idxCategory = norm.indexOf("분류"); // 확정 구조

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
    langIndex[h] = i; // ko-kr, en-us, th-th ...
  }

  if (langIndex["ko-kr"] == null) {
    throw new Error("헤더에 ko-KR이 없습니다. 언어 컬럼 헤더가 'ko-KR'인지 확인하세요.");
  }

  const entries = rows.map((r, rowIdx) => {
    const key = String(r[idxKey] ?? "").trim();
    const category = String(r[idxCategory] ?? "").trim();

    const translations = {};
    for (const [langKey, colIdx] of Object.entries(langIndex)) {
      const v = String(r[colIdx] ?? "").trim();
      if (v) translations[langKey] = v; // 값 있는 것만 저장(메모리)
    }

    return {
      _rowIndex: rowIdx + 2,
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
  };
}

// ---------------- Index Build (Preserve duplicates) ----------------
/**
 * Map<categoryLower, Map<sourceLangKey, Map<sourceText, entry[]>>>
 */
function buildIndexBySourcePreserveDuplicates(entries, sourceLangKeys = ["ko-kr", "en-us"]) {
  const byCategoryBySource = new Map();

  for (const e of entries) {
    const cat = String(e.category ?? "").trim().toLowerCase();
    if (!cat) continue;

    if (!byCategoryBySource.has(cat)) byCategoryBySource.set(cat, new Map());
    const bySource = byCategoryBySource.get(cat);

    for (const src of sourceLangKeys) {
      const sourceText = String(e.translations?.[src] ?? "").trim();
      if (!sourceText) continue;

      if (!bySource.has(src)) bySource.set(src, new Map());
      const textMap = bySource.get(src);

      if (!textMap.has(sourceText)) textMap.set(sourceText, []);
      textMap.get(sourceText).push(e); // ✅ 중복 보존
    }
  }

  return byCategoryBySource;
}

// ---------------- Replace Logic (Phase 1 + Logs) ----------------
function replaceByGlossaryWithLogs({ text, sourceLangKey, targetLangKey, sourceTextMap }) {
  if (typeof text !== "string") text = String(text ?? "");
  if (!text) return { out: "", replacedTotal: 0, logs: [] };

  // ✅ 긴 문자열 우선
  const terms = Array.from(sourceTextMap.keys()).sort((a, b) => b.length - a.length);

  let out = text;
  let replacedTotal = 0;
  const logs = [];

  for (const term of terms) {
    const candidates = sourceTextMap.get(term) || [];

    // 결정적 선택: targetLang 값이 존재하는 첫 후보
    let chosen = null;
    let target = "";
    for (const c of candidates) {
      const v = c?.translations?.[targetLangKey];
      if (v && String(v).trim()) {
        chosen = c;
        target = String(v).trim();
        break;
      }
    }
    if (!chosen || !target) continue;

    const re = new RegExp(escapeRegExp(term), "g");
    let localCount = 0;
    out = out.replace(re, () => {
      localCount += 1;
      return target;
    });

    if (localCount > 0) {
      replacedTotal += localCount;
      logs.push({
        sourceLang: sourceLangKey,
        targetLang: targetLangKey,
        from: term,
        to: target,
        count: localCount,
        chosen: {
          key: chosen.key || undefined,
          rowIndex: chosen._rowIndex,
        },
      });
    }
  }

  return { out, replacedTotal, logs };
}

// ---------------- REST Session Cache ----------------
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
  sourceLang: z.string().min(1), // ko-KR | en-US
  targetLang: z.string().min(1),
});

const ReplaceSchema = z.object({
  sessionId: z.string().min(1),
  texts: z.array(z.string()).min(1),
  includeLogs: z.boolean().optional(), // default true
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
 * - 세션당 1회 로드 → 세션 캐시 고정
 */
app.post("/v1/session/init", async (req, res) => {
  try {
    const { category, sourceLang, targetLang } = InitSchema.parse(req.body);

    const categoryKey = String(category).trim().toLowerCase();
    const sourceLangKey = normalizeLang(sourceLang);
    const targetLangKey = normalizeLang(targetLang);

    assertAllowedSourceLang(sourceLangKey);

    const loaded = await loadGlossaryAll();
    if (sourceLangKey === "en-us" && loaded.langIndex["en-us"] == null) {
      return res.status(400).json({
        ok: false,
        error: "Header does not include en-US. Cannot use sourceLang=en-US.",
      });
    }

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
        entries: loaded.entries,
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
 * - Phase 1 치환 + 로그 반환
 */
app.post("/v1/translate/replace", async (req, res) => {
  try {
    const { sessionId, texts, includeLogs } = ReplaceSchema.parse(req.body);
    const s = getSessionOrThrow(sessionId);

    const bySource = s.glossary.byCategoryBySource.get(s.categoryKey);
    const sourceTextMap = bySource?.get(s.sourceLangKey);
    if (!sourceTextMap) {
      return res.status(400).json({
        ok: false,
        error: `Source index missing for category='${s.categoryKey}', sourceLang='${s.sourceLangKey}'`,
      });
    }

    const wantLogs = includeLogs ?? true;

    const outTexts = [];
    const perLineLogs = [];
    let replacedTotalAll = 0;
    let matchedTermsAll = 0;

    for (let i = 0; i < texts.length; i++) {
      const input = texts[i];
      const { out, replacedTotal, logs } = replaceByGlossaryWithLogs({
        text: input,
        sourceLangKey: s.sourceLangKey,
        targetLangKey: s.targetLangKey,
        sourceTextMap,
      });

      outTexts.push(out);
      replacedTotalAll += replacedTotal;
      matchedTermsAll += logs.length;

      if (wantLogs) {
        perLineLogs.push({ index: i, replacedTotal, logs });
      }
    }

    return res.status(200).json({
      ok: true,
      sessionId,
      category: s.categoryKey,
      sourceLang: s.sourceLangKey,
      targetLang: s.targetLangKey,
      texts: outTexts,
      summary: {
        lines: texts.length,
        replacedTotal: replacedTotalAll,
        matchedTerms: matchedTermsAll,
        glossaryLoadedAt: s.glossary.loadedAt,
        rawRowCount: s.glossary.rawRowCount,
      },
      logs: wantLogs ? perLineLogs : undefined,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * POST /v1/glossary/update
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

// ---------------- MCP ----------------
const mcp = new McpServer({
  name: "sheets-glossary-mcp",
  version: "2.3.0",
});

/**
 * MCP 캐시(프로세스 단위)
 */
let mcpCache = null;
/**
 * mcpCache = { loadedAt, header, rawRows, entries, rawRowCount, langIndex, byCategoryBySource }
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
 * MCP: get_glossary (페이지네이션/필터)
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
 * MCP: lookup_text (단건 정확 일치)
 */
mcp.tool(
  "lookup_text",
  {
    text: z.string(),
    sourceLang: z.string(), // ko-KR | en-US
    targetLang: z.string().optional(),
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

    const results = [];

    const scanCategory = (cat) => {
      const bySource = cache.byCategoryBySource.get(cat);
      const map = bySource?.get(sourceLangKey);
      const candidates = map?.get(needle) || [];
      for (const e of candidates) {
        results.push({
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
    };

    if (catKey) scanCategory(catKey);
    else for (const cat of cache.byCategoryBySource.keys()) scanCategory(cat);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ found: results.length > 0, count: results.length, results }, null, 2),
        },
      ],
    };
  }
);

/**
 * MCP: lookup_texts (배치 정확 일치)
 */
mcp.tool(
  "lookup_texts",
  {
    texts: z.array(z.string()).min(1).max(2000),
    sourceLang: z.string(), // ko-KR | en-US
    targetLang: z.string().optional(),
    category: z.string().optional(),
    forceReload: z.boolean().optional(),
  },
  async ({ texts, sourceLang, targetLang, category, forceReload }) => {
    const cache = await ensureMcpLoaded(Boolean(forceReload));

    const sourceLangKey = normalizeLang(sourceLang);
    assertAllowedSourceLang(sourceLangKey);

    const targetLangKey = targetLang ? normalizeLang(targetLang) : "";
    const catKey = category ? String(category).trim().toLowerCase() : "";
    const categories = catKey ? [catKey] : Array.from(cache.byCategoryBySource.keys());

    const out = [];
    for (const rawText of texts) {
      const needle = String(rawText ?? "").trim();
      if (!needle) {
        out.push({ text: rawText, found: false, count: 0, matches: [] });
        continue;
      }

      const matches = [];
      for (const cat of categories) {
        const bySource = cache.byCategoryBySource.get(cat);
        const map = bySource?.get(sourceLangKey);
        const candidates = map?.get(needle) || [];
        for (const e of candidates) {
          matches.push({
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

      out.push({ text: needle, found: matches.length > 0, count: matches.length, matches });
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ count: out.length, results: out }, null, 2) }],
    };
  }
);

/**
 * MCP: read_sheet_rows (원본 row 읽기)
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
  console.log(`REST: /v1/session/init, /v1/translate/replace(+logs), /v1/glossary/update, /v1/glossary/raw`);
  console.log(`MCP: /mcp (get_glossary, lookup_text, lookup_texts, read_sheet_rows)`);
});
