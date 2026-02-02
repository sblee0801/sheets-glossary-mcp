/**
 * src/http/routes.mjs
 * - REST endpoints (sheet-aware)
 *
 * 최종 통합:
 * - connector/custom GPT body 방어 정규화(category/sheet/texts)
 * - replace 최적화: compiled replace plan cache 사용 + includeLogs=false면 ruleLogs 스킵
 * - mask 최적화: precompiled mask regex plan cache 사용 (텍스트 처리 중 RegExp 생성 0)
 * - pending dedupe: 최근 apply rowIndex TTL gate + excludeRowIndexes
 * - /v1/translate/auto: 서버가 GPT-4.1로 Phase2 번역 수행
 * - ✅ AutoTranslateSchema로 /auto 입력 검증 강화
 */

import {
  normalizeLang,
  assertAllowedSourceLang,
  newSessionId,
  nowIso,
  getParsedBody,
} from "../utils/common.mjs";

import {
  ensureGlossaryLoaded,
  ensureRulesLoaded,
  getReplacePlanFromCache,
  getMaskAnchorsFromCache,
  getMaskRegexPlanFromCache,
} from "../cache/global.mjs";

import { mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { replaceByGlossaryWithLogs, buildRuleLogs } from "../replace/replace.mjs";
import { colIndexToA1, batchUpdateValuesA1 } from "../google/sheets.mjs";

import { translateItemsWithGpt41 } from "../translate/openaiTranslate.mjs";

import {
  InitSchema,
  ReplaceSchema,
  UpdateSchema,
  PendingNextSchema,
  ApplySchema,
  GlossaryQaNextSchema,
  MaskSchema,
  MaskApplySchema,
  AutoTranslateSchema, // ✅ NEW
} from "./schemas.mjs";

// ---------------- In-memory sessions (lightweight) ----------------
const _sessions = new Map(); // sessionId -> { sheet, category, sourceLangKey, targetLangKey, createdAt }

// ---------------- Recent-applied rowIndex gate ----------------
const _recentAppliedBySheet = new Map(); // sheet -> Map<rowIndex:number, expiresAtMs:number>
const RECENT_APPLIED_TTL_MS = Number(process.env.RECENT_APPLIED_TTL_MS ?? 10 * 60 * 1000); // default 10m

function _nowMs() {
  return Date.now();
}

function _getSheetKey(sheet) {
  return String(sheet ?? "Glossary").trim() || "Glossary";
}

function _pruneRecent(sheetKey) {
  const key = _getSheetKey(sheetKey);
  const m = _recentAppliedBySheet.get(key);
  if (!m) return;
  const now = _nowMs();
  for (const [rowIndex, exp] of m.entries()) {
    if (!exp || exp <= now) m.delete(rowIndex);
  }
  if (m.size === 0) _recentAppliedBySheet.delete(key);
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

/**
 * ✅ IMPORTANT:
 * - Zod parse 에러(issues)가 status 없이 throw 되면 기존 로직에선 500이 됨
 * - 이제 issues가 있으면 400 + details로 내려서 원인 추적 가능
 */
function handleErr(res, e) {
  if (e && Array.isArray(e.issues)) {
    return toJson(res, 400, {
      ok: false,
      error: "InvalidRequest",
      details: e.issues,
    });
  }

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

function makeToken(style, id) {
  if (style === "braces") return `{mask:${id}}`;
  return `{mask:${id}}`;
}

/**
 * ✅ connector/custom GPT 방어용 body 정규화
 * - category 누락(undefined)/null => "" 로 강제
 * - sheet/glossarySheet 기본값
 * - texts 단일 문자열 방어(필요 시 배열화)
 */
function normalizeBodyForConnector(body, { ensureTextsArray = false } = {}) {
  const b = body && typeof body === "object" ? body : {};

  if (b.category === undefined || b.category === null) b.category = "";

  if (b.sheet === undefined || b.sheet === null) b.sheet = "Glossary";
  if (b.glossarySheet === undefined || b.glossarySheet === null) b.glossarySheet = "Glossary";

  if (ensureTextsArray) {
    if (typeof b.texts === "string") b.texts = [b.texts];
    if (b.texts == null) b.texts = [];
  }
  return b;
}

/**
 * ✅ Mask with precompiled regex plan
 */
function maskOneTextWithPlan({ text, regexPlan, termToMaskId, masksById, maskStyle }) {
  let out = String(text ?? "");
  if (!out || !regexPlan.length) return out;

  for (const { term, re } of regexPlan) {
    if (!term || !(re instanceof RegExp)) continue;

    if (!re.test(out)) continue;
    re.lastIndex = 0;

    let id = termToMaskId.get(term);
    if (!id) {
      id = masksById.size + 1;
      termToMaskId.set(term, id);
      masksById.set(id, null);
    }

    const token = makeToken(maskStyle, id);
    out = out.replace(re, token);
  }

  return out;
}

// ---------------- Endpoint registration ----------------
export function registerRoutes(app) {
  /**
   * ✅ Health routes: CustomGPT/Connector 방어
   * - 일부 클라이언트가 HEAD/OPTIONS 또는 trailing slash(/healthz/)로 호출하는 케이스가 있어
   *   GET만 열어두면 404처럼 보일 수 있음.
   * - 또한 어떤 환경은 /v1 prefix를 붙여 호출하는 케이스도 있어 alias를 둠.
   */
  const healthJson = (_req, res) => res.status(200).json({ ok: true });
  const rootOk = (_req, res) => res.status(200).send("ok");

  app.all("/health", healthJson);
  app.all("/health/", healthJson);
  app.all("/healthz", healthJson);
  app.all("/healthz/", healthJson);

  // optional aliases (defensive)
  app.all("/v1/health", healthJson);
  app.all("/v1/healthz", healthJson);

  app.all("/", rootOk);

  /**
   * Session init (optional)
   * POST /v1/session/init
   */
  app.post("/v1/session/init", async (req, res) => {
    try {
      const raw = getParsedBody(req);
      const body = normalizeBodyForConnector(raw);
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
      const raw = getParsedBody(req);
      const body = normalizeBodyForConnector(raw, { ensureTextsArray: true });
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

      const replacePlan = getReplacePlanFromCache({
        cache,
        sheetName: sheet,
        sourceLangKey,
        categories,
        targetLangKey,
      });

      const rulesCache = wantLogs ? await ensureRulesLoaded({ forceReload: false }) : null;
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
          replacePlan,
        });

        outTexts.push(out);
        replacedTotalAll += replacedTotal;
        matchedTermsAll += logs.length;

        if (wantLogs) {
          const ruleLogs = buildRuleLogs({
            text: out,
            categoryKey: String(categoryKey || "").toLowerCase(),
            targetLangKey,
            rulesCache,
          });

          matchedRulesAll += ruleLogs.length;

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
   * maskGlossaryTermsForTranslation
   * POST /v1/translate/mask
   */
  app.post("/v1/translate/mask", async (req, res) => {
    try {
      const raw = getParsedBody(req);
      const body = normalizeBodyForConnector(raw, { ensureTextsArray: true });
      const v = MaskSchema.parse(body);

      const operatingSheet = pickSheet(v);
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

      const regexPlan = getMaskRegexPlanFromCache({
        cache,
        sheetName: glossarySheet,
        sourceLangKey,
        categories,
        caseSensitive: Boolean(v.caseSensitive),
        wordBoundary: Boolean(v.wordBoundary),
      });

      const termToMaskId = new Map();
      const masksById = new Map();

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

      const textsMasked = [];
      for (const original of v.texts) {
        const masked = maskOneTextWithPlan({
          text: String(original ?? ""),
          regexPlan,
          termToMaskId,
          masksById,
          maskStyle: v.maskStyle,
        });
        textsMasked.push(masked);
      }

      for (const [anchor, id] of termToMaskId.entries()) {
        if (masksById.get(id)) continue;
        const { restore, rowIndex } = computeRestore(anchor);
        masksById.set(id, { id, anchor, restore, glossaryRowIndex: rowIndex || undefined });
      }

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

      const anchors = getMaskAnchorsFromCache({
        cache,
        sheetName: glossarySheet,
        sourceLangKey,
        categories,
      });

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
   * ✅ /v1/translate/auto
   * - AutoTranslateSchema로 입력 검증
   */
  app.post("/v1/translate/auto", async (req, res) => {
    try {
      const raw = getParsedBody(req);

      // 스키마가 category 등을 normalize하지만, sheet 기본값 방어는 routes에서도 한번 더 보정
      const normalized = normalizeBodyForConnector(raw);
      const v = AutoTranslateSchema.parse(normalized);

      const sheet = pickSheet(v);
      const category = String(v.category ?? "").trim();
      const mode = String(v.mode ?? "mask").trim().toLowerCase(); // replace | mask

      const sourceLangKey = normalizeLang(v.sourceLang ?? "en-US");
      const targetLangKey = normalizeLang(v.targetLang);

      if (!targetLangKey) throw httpError(400, "targetLang is required.");
      assertAllowedSourceLang(sourceLangKey);

      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: Boolean(v.forceReload),
      });

      let categories = [];
      if (category) {
        const ck = category.toLowerCase();
        if (!cache.byCategoryBySource.has(ck)) throw httpError(400, `Category not found: ${category}`);
        categories = [ck];
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

      const replacePlan =
        mode === "replace"
          ? getReplacePlanFromCache({
              cache,
              sheetName: sheet,
              sourceLangKey,
              categories,
              targetLangKey,
            })
          : null;

      const processed = [];
      for (const it of v.items) {
        const rowIndex = Number(it?.rowIndex);
        const sourceText = String(it?.sourceText ?? "").trim();
        if (!Number.isFinite(rowIndex) || rowIndex < 2) continue;
        if (!sourceText) continue;

        let processedText = sourceText;

        if (mode === "replace") {
          const r = replaceByGlossaryWithLogs({
            text: sourceText,
            sourceLangKey,
            targetLangKey,
            sourceTextMap,
            replacePlan,
          });
          processedText = r.out;
        } else {
          // mask 모드: client가 /mask로 만든 textsMasked를 textProcessed로 넘기면 그대로 사용
          if (it?.textProcessed != null) processedText = String(it.textProcessed);
        }

        processed.push({ rowIndex, sourceText, processedText });
      }

      if (!processed.length) throw httpError(400, "No valid items to process.");

      /**
       * ✅ CRITICAL FIX:
       * translateItemsWithGpt41 expects items[].textForTranslate
       */
      const tRes = await translateItemsWithGpt41({
        items: processed.map((x) => ({
          rowIndex: x.rowIndex,
          sourceText: x.sourceText,
          textForTranslate: x.processedText,
        })),
        sourceLang: sourceLangKey,
        targetLang: targetLangKey,
        chunkSize: v.chunkSize,
      });

      const byRow = new Map();
      for (const r of tRes.results) byRow.set(Number(r.rowIndex), String(r.translatedText ?? ""));

      const entries = [];
      for (const p of processed) {
        const translatedText = byRow.get(p.rowIndex) || "";
        if (!translatedText.trim()) continue;

        entries.push({
          rowIndex: p.rowIndex,
          sourceText: p.sourceText,
          translations: { [targetLangKey]: translatedText },
        });
      }

      toJson(res, 200, {
        ok: true,
        sheet,
        category: category || "ALL",
        sourceLang: sourceLangKey,
        targetLang: targetLangKey,
        mode,
        results: entries.map((e) => ({
          rowIndex: e.rowIndex,
          sourceText: e.sourceText,
          translatedText: e.translations[targetLangKey],
        })),
        applyDraft: {
          sheet,
          category,
          sourceLang: sourceLangKey,
          entries,
          fillOnlyEmpty: true,
          allowAnchorUpdate: false,
        },
        meta: tRes.meta,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * maskApply (WRITE)
   * POST /v1/translate/mask/apply
   */
  app.post("/v1/translate/mask/apply", async (req, res) => {
    try {
      const raw = getParsedBody(req);
      const body = normalizeBodyForConnector(raw);
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
      for (const it of v.entries) {
        const rowIndex = Number(it.rowIndex);
        const maskedText = String(it.maskedText ?? "").trim();
        if (!maskedText) continue;

        updates.push({
          range: `${sheet}!${colIndexToA1(colIdx)}${rowIndex}`,
          values: [[maskedText]],
        });
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
      const raw = getParsedBody(req);
      const body = normalizeBodyForConnector(raw);
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
      const raw = getParsedBody(req);
      const body = normalizeBodyForConnector(raw);
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

      const exclude = new Set(
        Array.isArray(v.excludeRowIndexes) ? v.excludeRowIndexes.map((n) => Number(n)) : []
      );

      _pruneRecent(sheet);

      for (let i = 0; i < cache.rawRows.length; i++) {
        const row = cache.rawRows[i];
        const rowIndex = i + 2;

        const srcText = String(row[srcCol] ?? "").trim();
        if (!srcText) continue;

        if (v.category && String(v.category).trim()) {
          const catKey = String(v.category).trim().toLowerCase();
          const e = cache.entries[i];
          const eCat = String(e?.category ?? "").trim().toLowerCase();
          if (eCat !== catKey) continue;
        }

        if (exclude.has(rowIndex)) continue;
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
      const raw = getParsedBody(req);
      const body = normalizeBodyForConnector(raw);
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
   * glossaryApply (WRITE)
   * POST /v1/glossary/apply
   */
  app.post("/v1/glossary/apply", async (req, res) => {
    try {
      const raw = getParsedBody(req);
      const body = normalizeBodyForConnector(raw);
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

      _markRecentApplied(sheet, Array.from(plannedRowIndexes));
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
