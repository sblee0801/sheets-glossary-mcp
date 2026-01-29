/**
 * src/http/routes.mjs
 * - REST endpoints (sheet-aware)
 *
 * FIX package:
 * 1) Prevent duplicate pending rows after WRITE:
 *    - Server-side recent-applied rowIndex TTL gate (dedupe)
 *    - Force reload cache after WRITE
 * 2) Support client-provided pending skip list:
 *    - PendingNextSchema.excludeRowIndexes
 */

import {
  normalizeLang,
  assertAllowedSourceLang,
  newSessionId,
  nowIso,
  getParsedBody,
} from "../utils/common.mjs";

import { ensureGlossaryLoaded, ensureRulesLoaded } from "../cache/global.mjs";
import { mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { replaceByGlossaryWithLogs, buildRuleLogs } from "../replace/replace.mjs";
import { colIndexToA1, batchUpdateValuesA1 } from "../google/sheets.mjs";

import {
  InitSchema,
  ReplaceSchema,
  UpdateSchema,
  PendingNextSchema,
  ApplySchema,
  GlossaryQaNextSchema,
  MaskSchema,
  MaskApplySchema, // WRITE
} from "./schemas.mjs";

// ---------------- In-memory sessions (lightweight) ----------------
const _sessions = new Map(); // sessionId -> { sheet, category, sourceLangKey, targetLangKey, createdAt }

// ---------------- Recent-applied rowIndex gate (NEW) ----------------
// 목적: WRITE 직후 캐시/시트 반영 지연으로 동일 rowIndex가 pendingNext에 재등장하는 현상 차단
// 동작: glossaryApply 성공 rowIndex를 sheet별로 TTL 동안 기억하고 pendingNext에서 제외
const _recentAppliedBySheet = new Map(); // sheet -> Map<rowIndex:number, expiresAtMs:number>
const RECENT_APPLIED_TTL_MS = Number(process.env.RECENT_APPLIED_TTL_MS ?? 10 * 60 * 1000); // default 10m

function _nowMs() {
  return Date.now();
}

function _getSheetKey(sheet) {
  return String(sheet ?? "Glossary").trim() || "Glossary";
}

function _pruneRecent(sheetKey) {
  const m = _recentAppliedBySheet.get(sheetKey);
  if (!m) return;
  const now = _nowMs();
  for (const [rowIndex, exp] of m.entries()) {
    if (!exp || exp <= now) m.delete(rowIndex);
  }
  if (m.size === 0) _recentAppliedBySheet.delete(sheetKey);
}

function _markRecentApplied(sheetKey, rowIndexes) {
  if (!RECENT_APPLIED_TTL_MS || RECENT_APPLIED_TTL_MS <= 0) return;
  const key = _getSheetKey(sheetKey);
  _pruneRecent(key);

  let m = _recentAppliedBySheet.get(key);
  if (!m) {
    m = new Map();
    _recentAppliedBySheet.set(key, m);
  }

  const exp = _nowMs() + RECENT_APPLIED_TTL_MS;
  for (const ri of rowIndexes) {
    const n = Number(ri);
    if (!Number.isFinite(n) || n < 2) continue;
    m.set(n, exp);
  }
}

function _isRecentApplied(sheetKey, rowIndex) {
  const key = _getSheetKey(sheetKey);
  _pruneRecent(key);

  const m = _recentAppliedBySheet.get(key);
  if (!m) return false;

  const n = Number(rowIndex);
  if (!Number.isFinite(n)) return false;

  const exp = m.get(n);
  return Boolean(exp && exp > _nowMs());
}

// ---------------- Common helpers ----------------
function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

function toJson(res, status, payload) {
  res.status(status).json(payload);
}

function handleErr(res, e) {
  const status = Number(e?.status) || 500;
  toJson(res, status, {
    ok: false,
    error: String(e?.message ?? e),
    extra: e?.extra,
  });
}

function pickSheet(v) {
  return _getSheetKey(v?.sheet ?? "Glossary");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeToken(style, id) {
  if (style === "braces") return `{mask:${id}}`;
  return `{mask:${id}}`;
}

/**
 * Build deterministic masks:
 * ✅ FIX: 실제로 "매칭되는 term"에 대해서만 maskId를 할당한다.
 */
function maskOneText({
  text,
  terms,
  termToMaskId,
  masksById,
  maskStyle,
  caseSensitive,
  wordBoundary,
}) {
  let out = String(text ?? "");
  if (!out || !terms.length) return out;

  for (const t of terms) {
    if (!t) continue;

    // word boundary handling (best-effort)
    const startsWord = /^[A-Za-z0-9_]/.test(t);
    const endsWord = /[A-Za-z0-9_]$/.test(t);

    let pattern = escapeRegex(t);
    if (wordBoundary && startsWord && endsWord) {
      pattern = `\\b${pattern}\\b`;
    }

    const re = new RegExp(pattern, caseSensitive ? "g" : "gi");

    // ✅ 핵심: 실제로 매칭되는 경우에만 id 할당/치환
    if (!re.test(out)) continue;
    re.lastIndex = 0;

    const existingId = termToMaskId.get(t);
    const id = existingId ?? (masksById.size + 1);

    if (!existingId) {
      termToMaskId.set(t, id);
      if (!masksById.has(id)) masksById.set(id, null);
    }

    const token = makeToken(maskStyle, id);
    out = out.replace(re, token);
  }

  return out;
}

// ---------------- Endpoint registration ----------------
export function registerRoutes(app) {
  // basic routes
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/", (_req, res) => res.status(200).send("ok"));

  /**
   * Session init (optional)
   * POST /v1/session/init
   */
  app.post("/v1/session/init", async (req, res) => {
    try {
      const body = getParsedBody(req);
      const v = InitSchema.parse(body);

      const sheet = pickSheet(v);
      const sourceLangKey = normalizeLang(v.sourceLang);
      const targetLangKey = normalizeLang(v.targetLang);
      const category = String(v.category ?? "").trim();

      assertAllowedSourceLang(sourceLangKey);

      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: false,
      });

      if (sourceLangKey === "en-us" && cache.langIndex["en-us"] == null) {
        throw httpError(
          400,
          `Sheet '${sheet}' does not include en-US column; cannot init with sourceLang=en-US.`
        );
      }

      const sessionId = newSessionId();
      _sessions.set(sessionId, {
        sheet,
        category,
        sourceLangKey,
        targetLangKey,
        createdAt: nowIso(),
      });

      toJson(res, 200, {
        ok: true,
        sessionId,
        sheet,
        category,
        sourceLang: sourceLangKey,
        targetLang: targetLangKey,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * replaceGlossaryTerms
   * POST /v1/translate/replace
   */
  app.post("/v1/translate/replace", async (req, res) => {
    try {
      const body = getParsedBody(req);
      const v = ReplaceSchema.parse(body);

      const sheet = pickSheet(v);

      let cfg = null;
      if (v.sessionId) {
        cfg = _sessions.get(v.sessionId) || null;
        if (!cfg) throw httpError(400, `Unknown sessionId: ${v.sessionId}`);
      }

      const category = String(v.category ?? cfg?.category ?? "").trim();
      const sourceLangKey = normalizeLang(v.sourceLang ?? cfg?.sourceLangKey ?? "");
      const targetLangKey = normalizeLang(v.targetLang ?? cfg?.targetLangKey ?? "");

      if (!sourceLangKey || !targetLangKey) {
        throw httpError(400, "sourceLang and targetLang are required (or provide sessionId).");
      }

      assertAllowedSourceLang(sourceLangKey);

      const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: false });

      if (sourceLangKey === "en-us" && cache.langIndex["en-us"] == null) {
        throw httpError(
          400,
          `Sheet '${sheet}' does not include en-US column; cannot use sourceLang=en-US.`
        );
      }

      let categories = [];
      if (category && String(category).trim()) {
        const catKey = String(category).trim().toLowerCase();
        if (!cache.byCategoryBySource.has(catKey)) {
          throw httpError(400, `Category not found: ${category}`, { sheet });
        }
        categories = [catKey];
      } else {
        categories = Array.from(cache.byCategoryBySource.keys());
      }

      const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);
      if (!sourceTextMap || sourceTextMap.size === 0) {
        throw httpError(
          400,
          `No source texts found for sheet='${sheet}', sourceLang='${sourceLangKey}', category='${category || "ALL"}'.`
        );
      }

      const wantLogs = v.includeLogs ?? true;

      const rulesCache = await ensureRulesLoaded({ forceReload: false });
      const categoryKey = category ? String(category).trim().toLowerCase() : categories[0] || "";

      const outTexts = [];
      const perLineLogs = [];
      const perLineRuleLogs = [];

      let replacedTotalAll = 0;
      let matchedTermsAll = 0;
      let matchedRulesAll = 0;

      for (let i = 0; i < v.texts.length; i++) {
        const input = v.texts[i];

        const { out, replacedTotal, logs } = replaceByGlossaryWithLogs({
          text: input,
          sourceLangKey,
          targetLangKey,
          sourceTextMap,
        });

        const ruleLogs = buildRuleLogs({
          text: out,
          categoryKey: String(categoryKey || "").toLowerCase(),
          targetLangKey,
          rulesCache,
        });

        outTexts.push(out);
        replacedTotalAll += replacedTotal;
        matchedTermsAll += logs.length;
        matchedRulesAll += ruleLogs.length;

        if (wantLogs) {
          perLineLogs.push({ index: i, replacedTotal, logs });
          perLineRuleLogs.push({ index: i, ruleLogs });
        }
      }

      toJson(res, 200, {
        ok: true,
        sheet: cache.sheetName,
        category: category ? String(category).trim().toLowerCase() : "ALL",
        sourceLang: sourceLangKey,
        targetLang: targetLangKey,
        texts: outTexts,
        summary: {
          lines: v.texts.length,
          replacedTotal: replacedTotalAll,
          matchedTerms: matchedTermsAll,
          matchedRules: matchedRulesAll,
          glossaryLoadedAt: cache.loadedAt,
          rawRowCount: cache.rawRowCount,
          categoriesUsedCount: categories.length,
          uniqueTermsInIndex: sourceTextMap.size,
        },
        logs: wantLogs ? perLineLogs : undefined,
        ruleLogs: wantLogs ? perLineRuleLogs : undefined,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * maskGlossaryTermsForTranslation (read-only/processing)
   * POST /v1/translate/mask
   */
  app.post("/v1/translate/mask", async (req, res) => {
    try {
      const body = getParsedBody(req);
      const v = MaskSchema.parse(body);

      const operatingSheet = pickSheet(v); // 보고용
      const glossarySheet = String(v.glossarySheet ?? "Glossary").trim() || "Glossary";

      const sourceLangKey = normalizeLang(v.sourceLang);
      if (sourceLangKey !== "en-us" && sourceLangKey !== "ko-kr") {
        throw httpError(400, "mask sourceLang must be en-US or ko-KR.");
      }

      const targetLangKey = normalizeLang(v.targetLang);
      if (!targetLangKey) throw httpError(400, "mask targetLang is required.");

      const cache = await ensureGlossaryLoaded({
        sheetName: glossarySheet,
        forceReload: Boolean(v.forceReload),
      });

      const srcCol = cache.langIndex[sourceLangKey];
      if (srcCol == null) {
        throw httpError(
          400,
          `Glossary sheet '${glossarySheet}' does not include source language column: ${sourceLangKey}`
        );
      }

      const tgtCol = cache.langIndex[targetLangKey];
      if (tgtCol == null) {
        throw httpError(
          400,
          `Glossary sheet '${glossarySheet}' does not include target language column: ${targetLangKey}`
        );
      }

      // categories
      let categories = [];
      if (v.category && String(v.category).trim()) {
        const catKey = String(v.category).trim().toLowerCase();
        if (!cache.byCategoryBySource.has(catKey)) {
          throw httpError(400, `Category not found: ${v.category}`, { sheet: glossarySheet });
        }
        categories = [catKey];
      } else {
        categories = Array.from(cache.byCategoryBySource.keys());
      }

      const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);
      if (!sourceTextMap || sourceTextMap.size === 0) {
        throw httpError(
          400,
          `No source texts found for glossarySheet='${glossarySheet}', sourceLang='${sourceLangKey}', category='${v.category || "ALL"}'.`
        );
      }

      // Build unique term list (anchors)
      const anchors = Array.from(sourceTextMap.keys())
        .map((s) => String(s ?? "").trim())
        .filter(Boolean);

      // Sort by length desc to prefer longer phrases
      anchors.sort((a, b) => b.length - a.length);

      const termToMaskId = new Map(); // anchor -> id
      const masksById = new Map(); // id -> {id, anchor, restore, rowIndex?}

      function computeRestore(anchor) {
        const hits = sourceTextMap.get(anchor) || [];
        if (!hits.length) return { restore: anchor, rowIndex: null };

        let chosen = hits[0];
        for (const h of hits) {
          if (Number(h?._rowIndex) < Number(chosen?._rowIndex)) chosen = h;
        }
        const rowIndex = Number(chosen?._rowIndex);

        const rawRow = cache.rawRows[rowIndex - 2] || [];
        const targetVal = String(rawRow[tgtCol] ?? "").trim();

        if (v.restoreStrategy === "glossaryTarget") {
          return { restore: targetVal || anchor, rowIndex };
        }
        return { restore: anchor, rowIndex };
      }

      // Mask each text
      const textsMasked = [];
      for (const original of v.texts) {
        const masked = maskOneText({
          text: String(original ?? ""),
          terms: anchors,
          termToMaskId,
          masksById,
          maskStyle: v.maskStyle,
          caseSensitive: Boolean(v.caseSensitive),
          wordBoundary: Boolean(v.wordBoundary),
        });
        textsMasked.push(masked);
      }

      // Fill masksById only for allocated ids
      for (const [anchor, id] of termToMaskId.entries()) {
        if (masksById.get(id)) continue;
        const { restore, rowIndex } = computeRestore(anchor);
        masksById.set(id, { id, anchor, restore, glossaryRowIndex: rowIndex || undefined });
      }

      // Count used ids
      const tokenRe = /\{mask:(\d+)\}/g;
      const usedIds = new Set();
      for (const t of textsMasked) {
        let m;
        while ((m = tokenRe.exec(String(t))) != null) usedIds.add(Number(m[1]));
      }

      const masks = Array.from(masksById.values())
        .filter(Boolean)
        .filter((x) => usedIds.has(Number(x.id)))
        .sort((a, b) => a.id - b.id);

      toJson(res, 200, {
        ok: true,
        sheet: operatingSheet,
        glossarySheet,
        category:
          v.category && String(v.category).trim()
            ? String(v.category).trim().toLowerCase()
            : "ALL",
        sourceLang: sourceLangKey === "en-us" ? "en-US" : "ko-KR",
        targetLang: v.targetLang,
        maskStyle: v.maskStyle,
        restoreStrategy: v.restoreStrategy,
        textsMasked,
        masks,
        meta: {
          glossaryLoadedAt: cache.loadedAt,
          rawRowCount: cache.rawRowCount,
          categoriesUsedCount: categories.length,
          uniqueTermsInIndex: anchors.length,
          matchedMaskIds: usedIds.size,
        },
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * maskApply (WRITE)
   * POST /v1/translate/mask/apply
   *
   * - <targetLang>-Masking 컬럼에 rowIndex 기반 업로드
   */
  app.post("/v1/translate/mask/apply", async (req, res) => {
    try {
      const body = getParsedBody(req);
      const v = MaskApplySchema.parse(body);

      const sheet = String(v.sheet).trim();
      const maskingHeader = `${v.targetLang}-Masking`;

      const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: false });

      const header = cache.header;
      if (!Array.isArray(header) || header.length === 0) {
        throw httpError(400, `Sheet '${sheet}' header is empty.`, { sheet });
      }

      const colIdx = header.findIndex((h) => String(h ?? "").trim() === maskingHeader);
      if (colIdx < 0) {
        throw httpError(400, `Masking column not found: '${maskingHeader}'`, { sheet });
      }

      const updates = [];
      const touchedRowIndexes = [];
      for (const it of v.entries) {
        const rowIndex = Number(it.rowIndex);
        const maskedText = String(it.maskedText ?? "").trim();
        if (!maskedText) continue;

        updates.push({
          range: `${sheet}!${colIndexToA1(colIdx)}${rowIndex}`,
          values: [[maskedText]],
        });
        touchedRowIndexes.push(rowIndex);
      }

      if (updates.length === 0) {
        return toJson(res, 200, {
          ok: true,
          sheet,
          maskingHeader,
          plannedUpdates: 0,
          updatedCells: 0,
          updatedRanges: [],
        });
      }

      const writeRes = await batchUpdateValuesA1(updates);

      // ✅ after WRITE, force reload cache (helps reduce stale reads)
      await ensureGlossaryLoaded({ sheetName: sheet, forceReload: true });

      toJson(res, 200, {
        ok: true,
        sheet,
        maskingHeader,
        plannedUpdates: updates.length,
        updatedCells: writeRes.updatedCells,
        updatedRanges: writeRes.updatedRanges,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * updateGlossary
   * POST /v1/glossary/update
   */
  app.post("/v1/glossary/update", async (req, res) => {
    try {
      const body = getParsedBody(req);
      const v = UpdateSchema.parse(body);

      const sheet = pickSheet(v);
      const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: true });

      toJson(res, 200, {
        ok: true,
        sheet: cache.sheetName,
        glossaryLoadedAt: cache.loadedAt,
        rawRowCount: cache.rawRowCount,
        categoriesCount: cache.byCategoryBySource.size,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * glossaryPendingNext
   * POST /v1/glossary/pending/next
   */
  app.post("/v1/glossary/pending/next", async (req, res) => {
    try {
      const body = getParsedBody(req);
      const v = PendingNextSchema.parse(body);

      const sheet = pickSheet(v);
      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: Boolean(v.forceReload),
      });

      const sourceLangKey = normalizeLang(v.sourceLang);
      if (sourceLangKey !== "en-us" && sourceLangKey !== "ko-kr") {
        throw httpError(400, "pending/next sourceLang must be en-US or ko-KR.");
      }

      const targetLangKeys = (v.targetLangs || []).map(normalizeLang).filter(Boolean);
      if (!targetLangKeys.length)
        throw httpError(400, "targetLangs must have at least 1 language.");

      for (const lk of targetLangKeys) {
        if (cache.langIndex[lk] == null) {
          throw httpError(400, `Sheet '${sheet}' does not include target language column: ${lk}`);
        }
      }

      const srcCol = cache.langIndex[sourceLangKey];
      if (srcCol == null) {
        throw httpError(
          400,
          `Sheet '${sheet}' does not include source language column: ${sourceLangKey}`
        );
      }

      const limit = Number(v.limit || 100);
      const out = [];

      // ✅ NEW: client-provided excludeRowIndexes
      const exclude = new Set(
        Array.isArray(v.excludeRowIndexes) ? v.excludeRowIndexes.map((n) => Number(n)) : []
      );

      // ✅ prune server-side recent applied gate
      _pruneRecent(sheet);

      for (let i = 0; i < cache.rawRows.length; i++) {
        const row = cache.rawRows[i];
        const rowIndex = i + 2;

        const srcText = String(row[srcCol] ?? "").trim();
        if (!srcText) continue;

        // category filter
        if (v.category && String(v.category).trim()) {
          const catKey = String(v.category).trim().toLowerCase();
          const e = cache.entries[i];
          const eCat = String(e?.category ?? "").trim().toLowerCase();
          if (eCat !== catKey) continue;
        }

        // ✅ skip if client asked to exclude
        if (exclude.has(rowIndex)) continue;

        // ✅ skip if recently applied (server dedupe gate)
        if (_isRecentApplied(sheet, rowIndex)) continue;

        let isPending = false;
        const missing = [];

        for (const lk of targetLangKeys) {
          const col = cache.langIndex[lk];
          const cur = String(row[col] ?? "").trim();
          if (!cur) {
            isPending = true;
            missing.push(lk);
          }
        }

        if (!isPending) continue;

        out.push({ rowIndex, sourceText: srcText, missingLangs: missing });
        if (out.length >= limit) break;
      }

      toJson(res, 200, {
        ok: true,
        sheet: cache.sheetName,
        sourceLang: sourceLangKey === "en-us" ? "en-US" : "ko-KR",
        targetLangs: v.targetLangs,
        limit,
        count: out.length,
        items: out,
        meta: {
          glossaryLoadedAt: cache.loadedAt,
          rawRowCount: cache.rawRowCount,
          recentAppliedTtlMs: RECENT_APPLIED_TTL_MS,
          excludeRowIndexesCount: exclude.size,
        },
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * glossaryQaNext (read-only)
   * POST /v1/glossary/qa/next
   */
  app.post("/v1/glossary/qa/next", async (req, res) => {
    try {
      const body = getParsedBody(req);
      const v = GlossaryQaNextSchema.parse(body);

      const sheet = pickSheet(v);

      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: Boolean(v.forceReload),
      });

      const sourceLangKey = normalizeLang(v.sourceLang);
      if (sourceLangKey !== "en-us" && sourceLangKey !== "ko-kr") {
        throw httpError(400, "qa/next sourceLang must be en-US or ko-KR.");
      }

      const targetLangKey = normalizeLang(v.targetLang);
      if (!targetLangKey) throw httpError(400, "qa/next targetLang is required.");

      const srcCol = cache.langIndex[sourceLangKey];
      if (srcCol == null) {
        throw httpError(
          400,
          `Sheet '${sheet}' does not include source language column: ${sourceLangKey}`
        );
      }

      const tgtCol = cache.langIndex[targetLangKey];
      if (tgtCol == null) {
        throw httpError(
          400,
          `Sheet '${sheet}' does not include target language column: ${targetLangKey}`
        );
      }

      const categoryKey =
        v.category && String(v.category).trim()
          ? String(v.category).trim().toLowerCase()
          : null;

      const limit = Number(v.limit || 100);

      let start = 0;
      if (v.cursor && String(v.cursor).trim()) {
        const n = Number(String(v.cursor).trim());
        if (!Number.isFinite(n) || n < 0) {
          throw httpError(400, "cursor must be a non-negative integer string.");
        }
        start = Math.floor(n);
      }

      const items = [];
      let i = start;

      for (; i < cache.entries.length; i++) {
        const entry = cache.entries[i];
        const row = cache.rawRows[i] || [];
        const rowIndex = i + 2;

        if (categoryKey) {
          const eCat = String(entry?.category ?? "").trim().toLowerCase();
          if (eCat !== categoryKey) continue;
        }

        const sourceText = String(row[srcCol] ?? "").trim();
        if (!sourceText) continue;

        const targetText = String(row[tgtCol] ?? "").trim();
        if (!targetText) continue;

        items.push({ rowIndex, sourceText, targetText });

        if (items.length >= limit) {
          i += 1;
          break;
        }
      }

      const cursorNext = i < cache.entries.length ? String(i) : null;

      toJson(res, 200, {
        ok: true,
        sheet: cache.sheetName,
        category: categoryKey || "ALL",
        sourceLang: sourceLangKey === "en-us" ? "en-US" : "ko-KR",
        targetLang: v.targetLang,
        limit,
        count: items.length,
        cursor: String(start),
        cursorNext,
        items,
        meta: {
          glossaryLoadedAt: cache.loadedAt,
          rawRowCount: cache.rawRowCount,
        },
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * glossaryApply
   * POST /v1/glossary/apply
   */
  app.post("/v1/glossary/apply", async (req, res) => {
    try {
      const body = getParsedBody(req);
      const v = ApplySchema.parse(body);

      const sheet = pickSheet(v);
      const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: false });

      const sourceLangKey = normalizeLang(v.sourceLang);
      if (sourceLangKey !== "en-us" && sourceLangKey !== "ko-kr") {
        throw httpError(400, "apply sourceLang must be en-US or ko-KR.");
      }

      const srcCol = cache.langIndex[sourceLangKey];
      if (srcCol == null) {
        throw httpError(
          400,
          `Sheet '${sheet}' does not include source language column: ${sourceLangKey}`
        );
      }

      let categories = null;
      let categoryKey = null;
      if (v.category && String(v.category).trim()) {
        categoryKey = String(v.category).trim().toLowerCase();
        if (!cache.byCategoryBySource.has(categoryKey)) {
          throw httpError(400, `Category not found: ${v.category}`, { sheet });
        }
        categories = [categoryKey];
      } else {
        categories = Array.from(cache.byCategoryBySource.keys());
      }

      const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);

      const fillOnlyEmpty = Boolean(v.fillOnlyEmpty);
      const allowAnchorUpdate = Boolean(v.allowAnchorUpdate);

      const updates = [];
      const results = [];

      // We'll mark these as "recent applied" only if we actually plan to update some cells for that row
      const plannedRowIndexes = new Set();

      for (const entry of v.entries) {
        const sourceText = String(entry?.sourceText ?? "").trim();
        if (!sourceText) {
          results.push({ sourceText: "", status: "skipped", reason: "empty sourceText" });
          continue;
        }

        const hasRowIndex = entry?.rowIndex != null && Number.isFinite(Number(entry.rowIndex));
        let chosen = null;

        if (hasRowIndex) {
          const rowIndex = Number(entry.rowIndex);

          if (rowIndex < 2 || rowIndex > cache.rawRows.length + 1) {
            results.push({
              sourceText,
              status: "skipped",
              reason: `rowIndex_out_of_range(${rowIndex})`,
            });
            continue;
          }

          const rowArrIdx = rowIndex - 2;
          const chosenEntry = cache.entries[rowArrIdx];
          const rawRow = cache.rawRows[rowArrIdx] || [];

          if (categoryKey) {
            const eCat = String(chosenEntry?.category ?? "").trim().toLowerCase();
            if (eCat !== categoryKey) {
              results.push({
                sourceText,
                status: "skipped",
                reason: `row_category_mismatch(${rowIndex})`,
              });
              continue;
            }
          }

          const actualSrc = String(rawRow[srcCol] ?? "").trim();
          if (actualSrc !== sourceText) {
            results.push({
              sourceText,
              status: "skipped",
              reason: `row_source_mismatch(rowIndex=${rowIndex})`,
            });
            continue;
          }

          chosen = { _rowIndex: rowIndex, key: chosenEntry?.key };
        } else {
          const hits = sourceTextMap.get(sourceText) || [];
          if (!hits.length) {
            results.push({ sourceText, status: "skipped", reason: "not_found" });
            continue;
          }

          chosen = hits[0];
          for (const h of hits) {
            if (Number(h?._rowIndex) < Number(chosen?._rowIndex)) chosen = h;
          }
        }

        const rowIndex = Number(chosen._rowIndex);
        const rawRow = cache.rawRows[rowIndex - 2] || [];

        let updated = 0;
        let skipped = 0;
        const conflicts = [];

        for (const [rawLang, rawVal] of Object.entries(entry.translations || {})) {
          const langKey = normalizeLang(rawLang);
          const val = String(rawVal ?? "").trim();
          if (!langKey || !val) continue;

          if (langKey === "en-us" && !allowAnchorUpdate) {
            skipped += 1;
            continue;
          }

          const colIdx = cache.langIndex[langKey];
          if (colIdx == null) {
            skipped += 1;
            conflicts.push({ lang: langKey, reason: "missing_column" });
            continue;
          }

          const cur = String(rawRow[colIdx] ?? "").trim();
          if (fillOnlyEmpty && cur) {
            skipped += 1;
            continue;
          }

          const cellA1 = `${sheet}!${colIndexToA1(colIdx)}${rowIndex}`;
          updates.push({ range: cellA1, values: [[val]] });
          updated += 1;
        }

        // Mark for recent-applied skip only if we actually plan any update
        if (updated > 0) plannedRowIndexes.add(rowIndex);

        let status = "no_op";
        if (updated > 0 && skipped > 0) status = "partial_success";
        else if (updated > 0) status = "success";

        results.push({
          sourceText,
          chosen: { rowIndex, key: chosen.key || undefined },
          updatedCellsPlanned: updated,
          skippedCells: skipped,
          conflicts,
          status,
        });
      }

      const writeRes = await batchUpdateValuesA1(updates);

      // ✅ NEW: Mark recent applied rows to prevent immediate re-pending due to cache/sheet propagation delays
      _markRecentApplied(sheet, Array.from(plannedRowIndexes));

      // ✅ after WRITE, force reload cache (best-effort)
      await ensureGlossaryLoaded({ sheetName: sheet, forceReload: true });

      toJson(res, 200, {
        ok: true,
        sheet,
        fillOnlyEmpty,
        allowAnchorUpdate,
        plannedUpdates: updates.length,
        updatedCells: writeRes.updatedCells,
        updatedRanges: writeRes.updatedRanges,
        results,
        meta: {
          recentAppliedCount: plannedRowIndexes.size,
          recentAppliedTtlMs: RECENT_APPLIED_TTL_MS,
        },
      });
    } catch (e) {
      handleErr(res, e);
    }
  });
}
