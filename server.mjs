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

// Phase 1.5 Rules sheet (separate from Glossary)
const RULE_SHEET_NAME = process.env.RULE_SHEET_NAME || "Rules";
const RULE_SHEET_RANGE = process.env.RULE_SHEET_RANGE || `${RULE_SHEET_NAME}!A:U`;

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
function isLikelyEnglish(s) {
  const t = String(s ?? "").trim();
  if (!t) return false;
  const ascii = t.replace(/[^\x00-\x7F]/g, "");
  const ratio = ascii.length / Math.max(1, t.length);
  return ratio > 0.95;
}

function colIndexToA1(colIndex0) {
  // 0 -> A, 1 -> B ...
  let n = Number(colIndex0) + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------- Google Sheets Client (Read/Write) ----------------
let _sheetsClient = null;

function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    // ✅ Write 지원 스코프
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  _sheetsClient = sheets;
  return sheets;
}

// ---------------- Google Sheets Read (Generic) ----------------
async function readSheetRange(range) {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = res.data.values || [];
  if (values.length < 1) return { header: [], rows: [] };

  const header = (values[0] || []).map((h) => String(h ?? "").trim());
  const rows = values.slice(1);

  return { header, rows };
}

async function batchUpdateValuesA1(updates) {
  // updates: [{ range: "Glossary!K12", values: [[...]] }]
  const sheets = getSheetsClient();

  if (!updates || updates.length === 0) {
    return { updatedCells: 0, updatedRanges: [] };
  }

  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: updates,
    },
  });

  const totalUpdatedCells = res.data.totalUpdatedCells ?? 0;
  const updatedRanges = (res.data.responses || []).map((r) => r.updatedRange).filter(Boolean);

  return { updatedCells: totalUpdatedCells, updatedRanges };
}

/**
 * Glossary 전체 로드 (온전히)
 */
async function loadGlossaryAll() {
  const { header, rows } = await readSheetRange(SHEET_RANGE);
  const loadedAt = new Date().toISOString();

  if (!header.length) {
    return {
      loadedAt,
      header: [],
      rawRows: [],
      entries: [],
      rawRowCount: 0,
      langIndex: {},
      idx: {},
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
      if (v) translations[langKey] = v;
    }

    return {
      _rowIndex: rowIdx + 2, // sheet row index (1-based + header)
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

// ---------------- Phase 1.5 Rules Load (with translations) ----------------
async function loadRulesAll() {
  const { header, rows } = await readSheetRange(RULE_SHEET_RANGE);
  const loadedAt = new Date().toISOString();

  if (!header.length) {
    return { loadedAt, header: [], rawRows: [], entries: [], rawRowCount: 0, langIndex: {} };
  }

  const norm = header.map(normalizeHeader);

  const idxKey = norm.indexOf("key");
  const idxCategory = norm.indexOf("분류");
  const idxMatchType = norm.indexOf("match_type");
  const idxPriority = norm.indexOf("priority");
  const idxNote = norm.indexOf("note");

  if (idxKey < 0) throw new Error("Rules 시트 헤더에 KEY가 없습니다.");
  if (idxCategory < 0) throw new Error("Rules 시트 헤더에 분류가 없습니다.");

  const excluded = new Set(["key", "분류", "category", "term", "note", "notes", "priority", "match_type"]);
  const langIndex = {};
  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    if (!h) continue;
    if (excluded.has(h)) continue;
    langIndex[h] = i;
  }

  if (langIndex["ko-kr"] == null) {
    throw new Error("Rules 시트 헤더에 ko-KR이 없습니다. 언어 컬럼 헤더가 'ko-KR'인지 확인하세요.");
  }

  const entries = rows.map((r, rowIdx) => {
    const key = String(r[idxKey] ?? "").trim();
    const category = String(r[idxCategory] ?? "").trim().toLowerCase();

    const translations = {};
    for (const [langKey, colIdx] of Object.entries(langIndex)) {
      const v = String(r[colIdx] ?? "").trim();
      if (v) translations[langKey] = v;
    }

    const matchType = idxMatchType >= 0 ? String(r[idxMatchType] ?? "").trim().toLowerCase() : "";
    const priority = idxPriority >= 0 ? Number(String(r[idxPriority] ?? "").trim() || "0") : 0;
    const note = idxNote >= 0 ? String(r[idxNote] ?? "").trim() : "";

    return {
      _rowIndex: rowIdx + 2,
      key,
      category,
      translations,
      matchType,
      priority,
      note,
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
      textMap.get(sourceText).push(e);
    }
  }

  return byCategoryBySource;
}

// ---------------- Replace Logic (Phase 1 + Logs) ----------------
function replaceByGlossaryWithLogs({ text, sourceLangKey, targetLangKey, sourceTextMap }) {
  if (typeof text !== "string") text = String(text ?? "");
  if (!text) return { out: "", replacedTotal: 0, logs: [] };

  const terms = Array.from(sourceTextMap.keys()).sort((a, b) => b.length - a.length);

  let out = text;
  let replacedTotal = 0;
  const logs = [];

  for (const term of terms) {
    const candidates = sourceTextMap.get(term) || [];

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

// ---------------- Phase 1.5 Rule Match + Logs ----------------
function tokenizePatternToRegex(pattern) {
  const escaped = escapeRegExp(pattern);
  return escaped
    .replace(/\\\{N\\\}/g, "(\\d+)")
    .replace(/\\\{X\\\}/g, "(\\d+)")
    .replace(/\\\{T\\\}/g, "(\\d+)")
    .replace(/\\\{V\\\}/g, "([^\\r\\n]+)");
}

function ruleMatchesText(ruleKo, matchType, text) {
  const ko = String(ruleKo ?? "").trim();
  if (!ko) return false;

  const mt = String(matchType ?? "").trim().toLowerCase();

  if (!mt || mt === "exact") {
    return text.includes(ko);
  }

  if (mt === "regex") {
    try {
      const re = new RegExp(ko, "m");
      return re.test(text);
    } catch {
      return false;
    }
  }

  if (mt === "pattern") {
    try {
      const reSrc = tokenizePatternToRegex(ko);
      const re = new RegExp(reSrc, "m");
      return re.test(text);
    } catch {
      return false;
    }
  }

  return text.includes(ko);
}

function buildRuleLogs({ text, categoryKey, targetLangKey, rulesCache }) {
  const out = [];
  if (!text) return out;
  if (categoryKey !== "item") return out;

  const rules = rulesCache?.itemEntries ?? [];
  if (!rules.length) return out;

  for (const r of rules) {
    const from = String(r.translations?.["ko-kr"] ?? "").trim();
    if (!from) continue;

    const matched = ruleMatchesText(from, r.matchType, text);
    if (!matched) continue;

    const to = String(r.translations?.[targetLangKey] ?? "").trim();

    out.push({
      ruleKey: r.key || `row:${r._rowIndex}`,
      from,
      to: to || "",
    });
  }

  const uniq = [];
  const seen = new Set();
  for (const x of out) {
    const k = `${x.ruleKey}@@${x.from}@@${x.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(x);
  }
  return uniq;
}

// ---------------- Shared Cache (REST + MCP) ----------------
let globalCache = null;

async function ensureGlobalLoaded(forceReload = false) {
  if (globalCache && !forceReload) return globalCache;

  const loaded = await loadGlossaryAll();
  const byCategoryBySource = buildIndexBySourcePreserveDuplicates(loaded.entries, ["ko-kr", "en-us"]);

  globalCache = {
    loadedAt: loaded.loadedAt,
    header: loaded.header,
    rawRows: loaded.rawRows,
    entries: loaded.entries,
    rawRowCount: loaded.rawRowCount,
    langIndex: loaded.langIndex,
    byCategoryBySource,
    idx: loaded.idx,
  };
  return globalCache;
}

// ---------------- Phase 1.5 Rules Cache ----------------
let globalRulesCache = null;

async function ensureRulesLoaded(forceReload = false) {
  if (globalRulesCache && !forceReload) return globalRulesCache;

  const loaded = await loadRulesAll();

  const itemEntries = loaded.entries.filter((e) => {
    if (e.category !== "item") return false;
    const ko = String(e.translations?.["ko-kr"] ?? "").trim();
    return Boolean(ko);
  });

  globalRulesCache = {
    loadedAt: loaded.loadedAt,
    header: loaded.header,
    rawRows: loaded.rawRows,
    entries: loaded.entries,
    rawRowCount: loaded.rawRowCount,
    langIndex: loaded.langIndex,
    itemEntries,
  };

  return globalRulesCache;
}

/**
 * category가 없을 때: 모든 카테고리의 sourceTextMap을 하나로 머지
 * Map<sourceText, entry[]>
 */
function mergeSourceTextMapsFromCache(cache, sourceLangKey, categories) {
  const merged = new Map();

  for (const cat of categories) {
    const bySource = cache.byCategoryBySource.get(cat);
    const map = bySource?.get(sourceLangKey);
    if (!map) continue;

    for (const [term, entries] of map.entries()) {
      if (!merged.has(term)) merged.set(term, []);
      merged.get(term).push(...entries);
    }
  }

  return merged;
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
  sourceLang: z.string().min(1),
  targetLang: z.string().min(1),
});

const ReplaceSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    category: z.string().optional(),
    sourceLang: z.string().min(1).optional(),
    targetLang: z.string().min(1).optional(),
    texts: z.array(z.string()).min(1),
    includeLogs: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    debug: z.boolean().optional(),
  })
  .refine(
    (v) => {
      if (v.sessionId) return true;
      return Boolean(v.sourceLang) && Boolean(v.targetLang);
    },
    { message: "If sessionId is not provided, sourceLang and targetLang are required." }
  );

const UpdateSchema = z.object({
  sessionId: z.string().min(1).optional(),
});

const SuggestSchema = z.object({
  category: z.string().min(1),
  terms: z.array(z.string()).min(1).max(200),
  anchorLang: z.string().optional().default("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
  includeEvidence: z.boolean().optional().default(true),
  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  generateTargets: z.boolean().optional().default(false),
});

// ✅ candidates endpoint schema (MVP 유지)
const CandidatesSchema = z.object({
  category: z.string().min(1),
  sourceText: z.string().min(1),
  sourceLang: z.string().optional().default("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
});

// ✅ NEW: apply endpoint schema (en-US row match -> write only target language columns)
const ApplySchema = z.object({
  category: z.string().min(1),
  sourceLang: z.string().optional().default("en-US"),
  // en-US는 이미 채워져 있으므로, sourceText(en-US)로 행을 찾는다.
  entries: z
    .array(
      z.object({
        sourceText: z.string().min(1), // en-US text
        translations: z.record(z.string().min(1)), // { "ko-KR": "...", "de-DE": "...", ... }
      })
    )
    .min(1)
    .max(500),
  // 기본: 빈 셀만 채움
  fillOnlyEmpty: z.boolean().optional().default(true),
  // 옵션: 특정 언어만 제한하고 싶을 때 (미지정이면 entries.translations의 키를 그대로 사용)
  targetLangs: z.array(z.string().min(1)).optional(),
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
 */
app.post("/v1/session/init", async (req, res) => {
  try {
    const { category, sourceLang, targetLang } = InitSchema.parse(req.body);

    const categoryKey = String(category).trim().toLowerCase();
    const sourceLangKey = normalizeLang(sourceLang);
    const targetLangKey = normalizeLang(targetLang);

    assertAllowedSourceLang(sourceLangKey);

    const cache = await ensureGlobalLoaded(false);

    if (sourceLangKey === "en-us" && cache.langIndex["en-us"] == null) {
      return res.status(400).json({
        ok: false,
        error: "Header does not include en-US. Cannot use sourceLang=en-US.",
      });
    }

    if (!cache.byCategoryBySource.has(categoryKey)) {
      return res.status(400).json({
        ok: false,
        error: `Category not found in glossary index: ${category}`,
      });
    }

    const bySource = cache.byCategoryBySource.get(categoryKey);
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
        loadedAt: cache.loadedAt,
        rawRowCount: cache.rawRowCount,
        header: cache.header,
        rawRows: cache.rawRows,
        entries: cache.entries,
        langIndex: cache.langIndex,
        byCategoryBySource: cache.byCategoryBySource,
      },
    });

    return res.status(200).json({
      ok: true,
      sessionId,
      category: categoryKey,
      sourceLang: sourceLangKey,
      targetLang: targetLangKey,
      glossaryLoadedAt: cache.loadedAt,
      rawRowCount: cache.rawRowCount,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * POST /v1/translate/replace
 * - Phase 1 치환 + 로그 반환
 * - ✅ Phase 1.5 룰 사용 로그(ruleLogs)도 항상 반환(빈 배열 가능)
 */
app.post("/v1/translate/replace", async (req, res) => {
  try {
    const { sessionId, texts, includeLogs, category, sourceLang, targetLang } = ReplaceSchema.parse(req.body);
    const wantLogs = includeLogs ?? true;

    const rulesCache = await ensureRulesLoaded(false);

    // 1) session 기반
    if (sessionId) {
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
      const perLineLogs = [];
      const perLineRuleLogs = [];
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

        if (wantLogs) perLineLogs.push({ index: i, replacedTotal, logs });

        const ruleLogs = buildRuleLogs({
          text: out,
          categoryKey: s.categoryKey,
          targetLangKey: s.targetLangKey,
          rulesCache,
        });
        perLineRuleLogs.push({ index: i, logs: ruleLogs });
      }

      return res.status(200).json({
        ok: true,
        mode: "session",
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
        ruleLogs: perLineRuleLogs,
      });
    }

    // 2) stateless
    const sourceLangKey = normalizeLang(sourceLang);
    const targetLangKey = normalizeLang(targetLang);
    assertAllowedSourceLang(sourceLangKey);

    const cache = await ensureGlobalLoaded(false);

    if (sourceLangKey === "en-us" && cache.langIndex["en-us"] == null) {
      return res.status(400).json({
        ok: false,
        error: "Header does not include en-US. Cannot use sourceLang=en-US.",
      });
    }

    let categories = [];
    let categoryKeyForRules = "ALL";
    if (category && String(category).trim()) {
      const catKey = String(category).trim().toLowerCase();
      if (!cache.byCategoryBySource.has(catKey)) {
        return res.status(400).json({ ok: false, error: `Category not found: ${category}` });
      }
      categories = [catKey];
      categoryKeyForRules = catKey;
    } else {
      categories = Array.from(cache.byCategoryBySource.keys());
      categoryKeyForRules = "ALL";
    }

    const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);
    if (!sourceTextMap || sourceTextMap.size === 0) {
      return res.status(400).json({
        ok: false,
        error: `No source texts found for sourceLang='${sourceLangKey}' (category=${category ? String(category) : "ALL"}).`,
      });
    }

    const outTexts = [];
    const perLineLogs = [];
    const perLineRuleLogs = [];
    let replacedTotalAll = 0;
    let matchedTermsAll = 0;

    for (let i = 0; i < texts.length; i++) {
      const input = texts[i];
      const { out, replacedTotal, logs } = replaceByGlossaryWithLogs({
        text: input,
        sourceLangKey,
        targetLangKey,
        sourceTextMap,
      });

      outTexts.push(out);
      replacedTotalAll += replacedTotal;
      matchedTermsAll += logs.length;

      if (wantLogs) perLineLogs.push({ index: i, replacedTotal, logs });

      const ruleLogs = buildRuleLogs({
        text: out,
        categoryKey: categoryKeyForRules,
        targetLangKey,
        rulesCache,
      });
      perLineRuleLogs.push({ index: i, logs: ruleLogs });
    }

    return res.status(200).json({
      ok: true,
      mode: "stateless",
      sessionId: null,
      category: category ? String(category).trim().toLowerCase() : "ALL",
      sourceLang: sourceLangKey,
      targetLang: targetLangKey,
      texts: outTexts,
      summary: {
        lines: texts.length,
        replacedTotal: replacedTotalAll,
        matchedTerms: matchedTermsAll,
        glossaryLoadedAt: cache.loadedAt,
        rawRowCount: cache.rawRowCount,
        categoriesUsedCount: categories.length,
        uniqueTermsInIndex: sourceTextMap.size,
      },
      logs: wantLogs ? perLineLogs : undefined,
      ruleLogs: perLineRuleLogs,
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
    const { sessionId } = UpdateSchema.parse(req.body ?? {});

    if (!sessionId) {
      const cache = await ensureGlobalLoaded(true);

      let updatedSessions = 0;
      for (const [sid, s] of sessions.entries()) {
        const categoryKey = s.categoryKey;
        const sourceLangKey = s.sourceLangKey;

        if (sourceLangKey === "en-us" && cache.langIndex["en-us"] == null) {
          // keep session
        }

        if (!cache.byCategoryBySource.has(categoryKey)) {
          continue;
        }

        s.glossary = {
          loadedAt: cache.loadedAt,
          rawRowCount: cache.rawRowCount,
          header: cache.header,
          rawRows: cache.rawRows,
          entries: cache.entries,
          langIndex: cache.langIndex,
          byCategoryBySource: cache.byCategoryBySource,
        };
        sessions.set(sid, s);
        updatedSessions += 1;
      }

      return res.status(200).json({
        ok: true,
        mode: "process",
        sessionId: null,
        glossaryLoadedAt: cache.loadedAt,
        rawRowCount: cache.rawRowCount,
        updatedSessions,
      });
    }

    const s = getSessionOrThrow(sessionId);
    const cache = await ensureGlobalLoaded(true);

    if (s.sourceLangKey === "en-us" && cache.langIndex["en-us"] == null) {
      return res.status(400).json({
        ok: false,
        error: "Header does not include en-US. Cannot keep sourceLang=en-US after reload.",
      });
    }

    if (!cache.byCategoryBySource.has(s.categoryKey)) {
      return res.status(400).json({
        ok: false,
        error: `Category not found after reload: ${s.categoryKey}`,
      });
    }

    const bySource = cache.byCategoryBySource.get(s.categoryKey);
    const sourceTextMap = bySource?.get(s.sourceLangKey);
    if (!sourceTextMap || sourceTextMap.size === 0) {
      return res.status(400).json({
        ok: false,
        error: `No source texts found after reload for category='${s.categoryKey}', sourceLang='${s.sourceLangKey}'.`,
      });
    }

    s.glossary = {
      loadedAt: cache.loadedAt,
      rawRowCount: cache.rawRowCount,
      header: cache.header,
      rawRows: cache.rawRows,
      entries: cache.entries,
      langIndex: cache.langIndex,
      byCategoryBySource: cache.byCategoryBySource,
    };
    sessions.set(sessionId, s);

    return res.status(200).json({
      ok: true,
      mode: "session",
      sessionId,
      category: s.categoryKey,
      sourceLang: s.sourceLangKey,
      targetLang: s.targetLangKey,
      glossaryLoadedAt: cache.loadedAt,
      rawRowCount: cache.rawRowCount,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * POST /v1/rules/update
 */
app.post("/v1/rules/update", async (_req, res) => {
  try {
    const cache = await ensureRulesLoaded(true);
    return res.status(200).json({
      ok: true,
      mode: "process",
      rulesLoadedAt: cache.loadedAt,
      rawRowCount: cache.rawRowCount,
      itemRulesCount: cache.itemEntries.length,
      range: RULE_SHEET_RANGE,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * Step G2 (B안 기본): POST /v1/glossary/suggest
 */
app.post("/v1/glossary/suggest", async (req, res) => {
  try {
    const body = SuggestSchema.parse(req.body ?? {});
    const categoryKey = String(body.category).trim().toLowerCase();
    const anchorLangKey = normalizeLang(body.anchorLang || "en-US");
    const targetLangKeys = body.targetLangs.map(normalizeLang);

    if (categoryKey !== "item") {
      return res.status(400).json({ ok: false, error: "Only category='item' is supported in Step G2." });
    }
    if (anchorLangKey !== "en-us") {
      return res.status(400).json({ ok: false, error: "anchorLang must be en-US for now." });
    }

    const includeEvidence = Boolean(body.includeEvidence);

    const results = body.terms.map((termRaw) => {
      const input = String(termRaw ?? "").trim();

      const canonicalText = input;
      const conf = isLikelyEnglish(canonicalText) ? "medium" : "low";

      const candidatesByLang = {};
      for (const t of targetLangKeys) {
        candidatesByLang[t] = [];
      }

      const warnings = [];
      if (!body.generateTargets) {
        warnings.push("Target-language candidates are not generated in Step G2 (suggest-only MVP).");
      } else {
        warnings.push("generateTargets=true is not implemented yet. Candidates are returned as empty arrays.");
      }

      const notes = [];
      if (includeEvidence) notes.push("Evidence collection is not enabled in Step G2.");

      return {
        input,
        canonical: {
          lang: "en-US",
          text: canonicalText,
          confidence: conf,
          matchedSources: [],
        },
        candidatesByLang,
        notes,
        warnings,
      };
    });

    return res.status(200).json({
      ok: true,
      category: categoryKey,
      anchorLang: "en-US",
      targetLangs: body.targetLangs,
      results,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * ✅ Step 3A-1 (MVP): POST /v1/glossary/candidates
 * - 후보 수집은 아직 하지 않음
 * - 언어별 candidates=[], fallbackNeededByLang=true 로 반환
 */
app.post("/v1/glossary/candidates", async (req, res) => {
  try {
    const body = CandidatesSchema.parse(req.body ?? {});
    const categoryKey = String(body.category).trim().toLowerCase();

    if (categoryKey !== "item") {
      return res.status(400).json({ ok: false, error: "Only category='item' is supported for now." });
    }

    const sourceText = String(body.sourceText ?? "").trim();
    const sourceLang = String(body.sourceLang ?? "en-US").trim();

    const targetLangKeys = body.targetLangs.map((l) => normalizeLang(l));
    const candidatesByLang = {};
    const fallbackNeededByLang = {};

    for (const lk of targetLangKeys) {
      candidatesByLang[lk] = [];
      fallbackNeededByLang[lk] = true;
    }

    return res.status(200).json({
      ok: true,
      category: categoryKey,
      sourceText,
      sourceLang,
      candidatesByLang,
      fallbackNeededByLang,
      notes: ["Step 3A-1: candidate lookup not implemented yet. Use GPT fallback where needed."],
      warnings: [],
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * ✅ NEW: POST /v1/glossary/apply
 * - en-US(sourceText) + category 로 기존 행을 찾고
 * - 해당 언어 컬럼만 채워 넣는다
 * - 기본: 빈 셀만 채움(fillOnlyEmpty=true)
 */
app.post("/v1/glossary/apply", async (req, res) => {
  try {
    const body = ApplySchema.parse(req.body ?? {});
    const categoryKey = String(body.category).trim().toLowerCase();

    const sourceLangKey = normalizeLang(body.sourceLang ?? "en-US");
    if (sourceLangKey !== "en-us") {
      return res.status(400).json({ ok: false, error: "sourceLang must be en-US (anchor) for apply." });
    }

    // 최신 Glossary 로드(쓰기 반영은 최신 기준이 안전)
    const cache = await ensureGlobalLoaded(true);

    if (cache.langIndex["en-us"] == null) {
      return res.status(400).json({
        ok: false,
        error: "Header does not include en-US column. Cannot apply by en-US anchor.",
      });
    }

    // category 매칭은 시트의 '분류' 셀 값 기준. 인덱스는 이미 entries.category로 로드됨.
    // targetLangs가 지정되면 그 언어만, 아니면 entries.translations의 키 그대로 사용
    const targetLangAllow = body.targetLangs ? new Set(body.targetLangs.map(normalizeLang)) : null;

    const updates = [];
    const notFound = [];
    const skipped = [];
    let matchedRows = 0;

    // 빠른 검색용: categoryLower + en-us text -> entry
    const mapByCatAndEn = new Map();
    for (const e of cache.entries) {
      const cat = String(e.category ?? "").trim().toLowerCase();
      const en = String(e.translations?.["en-us"] ?? "").trim();
      if (!cat || !en) continue;
      const k = `${cat}@@${en}`;
      if (!mapByCatAndEn.has(k)) mapByCatAndEn.set(k, e);
    }

    for (const item of body.entries) {
      const sourceText = String(item.sourceText ?? "").trim();
      if (!sourceText) continue;

      const key = `${categoryKey}@@${sourceText}`;
      const rowEntry = mapByCatAndEn.get(key);

      if (!rowEntry) {
        notFound.push({ sourceText, reason: "Row not found by category+en-US" });
        continue;
      }

      matchedRows += 1;

      const rowIndex = rowEntry._rowIndex;

      for (const [langRaw, textRaw] of Object.entries(item.translations || {})) {
        const langKey = normalizeLang(langRaw);
        if (!langKey) continue;

        // sourceLang(en-us)은 기준키이므로 쓰지 않는다 (요구사항)
        if (langKey === "en-us") continue;

        if (targetLangAllow && !targetLangAllow.has(langKey)) continue;

        const colIdx = cache.langIndex[langKey];
        if (colIdx == null) {
          skipped.push({ sourceText, lang: langRaw, reason: "Language column not found in header" });
          continue;
        }

        const newText = String(textRaw ?? "").trim();
        if (!newText) continue;

        // fillOnlyEmpty=true면, 기존 값이 있으면 스킵
        if (body.fillOnlyEmpty) {
          const existing = String(rowEntry.translations?.[langKey] ?? "").trim();
          if (existing) {
            skipped.push({ sourceText, lang: langKey, reason: "Cell already has value (fillOnlyEmpty=true)" });
            continue;
          }
        }

        const colA1 = colIndexToA1(colIdx);
        const a1 = `${SHEET_NAME}!${colA1}${rowIndex}`;
        updates.push({ range: a1, values: [[newText]] });
      }
    }

    // 실제 반영
    const { updatedCells, updatedRanges } = await batchUpdateValuesA1(updates);

    // 캐시 갱신(반영 후 최신화)
    await ensureGlobalLoaded(true);

    return res.status(200).json({
      ok: true,
      category: categoryKey,
      sourceLang: "en-US",
      fillOnlyEmpty: Boolean(body.fillOnlyEmpty),
      inputCount: body.entries.length,
      matchedRows,
      writePlan: {
        intendedUpdates: updates.length,
      },
      result: {
        updatedCells,
        updatedRangesCount: updatedRanges.length,
      },
      notFound,
      skipped,
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

// ---------------- MCP (ONLY 2 TOOLS) ----------------
const mcp = new McpServer({
  name: "sheets-glossary-mcp",
  version: "2.4.2",
});

/**
 * MCP Tool #1: replace_texts
 */
mcp.tool(
  "replace_texts",
  {
    texts: z.array(z.string()).min(1).max(2000),
    category: z.string().optional(),

    sourceLang: z.string().min(1),
    targetLang: z.string().min(1),

    includeLogs: z.boolean().optional(),
    forceReload: z.boolean().optional(),
  },
  async ({ texts, category, sourceLang, targetLang, includeLogs, forceReload }) => {
    const cache = await ensureGlobalLoaded(Boolean(forceReload));

    const sourceLangKey = normalizeLang(sourceLang);
    const targetLangKey = normalizeLang(targetLang);

    assertAllowedSourceLang(sourceLangKey);

    if (sourceLangKey === "en-us" && cache.langIndex["en-us"] == null) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: false, error: "Header does not include en-US. Cannot use sourceLang=en-US." },
              null,
              2
            ),
          },
        ],
      };
    }

    let categories = [];
    if (category && String(category).trim()) {
      const catKey = String(category).trim().toLowerCase();
      if (!cache.byCategoryBySource.has(catKey)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: `Category not found: ${category}` }, null, 2),
            },
          ],
        };
      }
      categories = [catKey];
    } else {
      categories = Array.from(cache.byCategoryBySource.keys());
    }

    const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);
    if (!sourceTextMap || sourceTextMap.size === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                error: `No source texts found for sourceLang='${sourceLangKey}' (category=${
                  category ? String(category) : "ALL"
                }).`,
              },
              null,
              2
            ),
          },
        ],
      };
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
        sourceLangKey,
        targetLangKey,
        sourceTextMap,
      });

      outTexts.push(out);
      replacedTotalAll += replacedTotal;
      matchedTermsAll += logs.length;

      if (wantLogs) perLineLogs.push({ index: i, replacedTotal, logs });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              category: category ? String(category).trim().toLowerCase() : "ALL",
              sourceLang: sourceLangKey,
              targetLang: targetLangKey,
              texts: outTexts,
              summary: {
                lines: texts.length,
                replacedTotal: replacedTotalAll,
                matchedTerms: matchedTermsAll,
                glossaryLoadedAt: cache.loadedAt,
                rawRowCount: cache.rawRowCount,
                categoriesUsedCount: categories.length,
                uniqueTermsInIndex: sourceTextMap.size,
              },
              logs: wantLogs ? perLineLogs : undefined,
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
 * MCP Tool #2: glossary_update
 */
mcp.tool(
  "glossary_update",
  {
    forceReload: z.boolean().optional(),
  },
  async ({ forceReload }) => {
    const cache = await ensureGlobalLoaded(forceReload ?? true);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              glossaryLoadedAt: cache.loadedAt,
              rawRowCount: cache.rawRowCount,
              categoriesCount: cache.byCategoryBySource.size,
              range: SHEET_RANGE,
            },
            null,
            2
          ),
        },
      ],
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
  console.log(`Rule range: ${RULE_SHEET_RANGE}`);
  console.log(
    `REST: /v1/session/init, /v1/translate/replace(+logs, stateless ok, +ruleLogs), /v1/glossary/update(session optional), /v1/rules/update, /v1/glossary/suggest, /v1/glossary/candidates, /v1/glossary/apply, /v1/glossary/raw`
  );
  console.log(`MCP: /mcp (replace_texts, glossary_update)`);
});
