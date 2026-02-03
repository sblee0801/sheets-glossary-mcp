/**
 * src/http/routesV2.mjs
 * - v2 batch pipeline endpoints
 *   POST /v2/batch/run
 *   GET  /v2/batch/:id/anomalies
 *
 * ✅ 개선(이번 단계)
 * - planned=0일 때도 "왜 0인지" 진단 데이터 반환
 * - effectively-empty 처리(공백/NBSP/ZW/BOM + sentinel) 강화
 * - debug:true 요청 시 sample rows 정보 제공
 */

import { getParsedBody, normalizeLang, nowIso, escapeRegExp } from "../utils/common.mjs";

import { ensureGlossaryLoaded, ensureRulesLoaded, getReplacePlanFromCache } from "../cache/global.mjs";
import { mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { replaceByGlossaryWithLogs } from "../replace/replace.mjs";
import { colIndexToA1, batchUpdateValuesA1 } from "../google/sheets.mjs";
import { translateItemsWithGpt41 } from "../translate/openaiTranslate.mjs";

import { BatchRunSchema, BatchAnomaliesQuerySchema } from "./schemas.mjs";

// ---------------- In-memory batch storage ----------------
const _batchStore = new Map();
const _BATCH_TTL_MS = Number(process.env.BATCH_TTL_MS ?? 60 * 60 * 1000); // 1h

function _nowMs() {
  return Date.now();
}

function _newBatchId() {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function _pruneBatches() {
  const now = _nowMs();
  for (const [id, v] of _batchStore.entries()) {
    if (!v?.createdAt) {
      _batchStore.delete(id);
      continue;
    }
    if (now - v.createdAt > _BATCH_TTL_MS) _batchStore.delete(id);
  }
}

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

function toJson(res, status, payload) {
  res.status(status).json(payload);
}

function handleErr(req, res, e) {
  const status = Number(e?.status) || 500;
  console.error(`[ERR] ${req.method} ${req.originalUrl}`, e?.message || e, e?.extra || "");
  toJson(res, status, {
    ok: false,
    error: String(e?.message ?? e),
    method: req.method,
    path: req.originalUrl,
    extra: e?.extra,
  });
}

function pickSheet(v) {
  const s = String(v?.sheet ?? "Glossary").trim();
  return s || "Glossary";
}

function normalizeBodyForConnector(body) {
  const b = body && typeof body === "object" ? body : {};
  if (b.category === undefined || b.category === null) b.category = "";
  if (b.sheet === undefined || b.sheet === null) b.sheet = "Glossary";
  return b;
}

// ---------------- Empty normalization ----------------
const _sentinels = String(process.env.PENDING_EMPTY_SENTINELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function _stripInvisible(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ") // NBSP -> space
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "") // zero-width + BOM
    .trim();
}

function isEffectivelyEmpty(v) {
  const s = _stripInvisible(v);
  if (!s) return true;
  if (_sentinels.length && _sentinels.includes(s)) return true;
  return false;
}

// ---------- Rules engine (category selectable) ----------
function tokenizePatternToRegex(pattern) {
  const escaped = escapeRegExp(pattern);
  return escaped
    .replace(/\\\{N\\\}/g, "(\\d+)")
    .replace(/\\\{X\\\}/g, "(\\d+)")
    .replace(/\\\{T\\\}/g, "(\\d+)")
    .replace(/\\\{V\\\}/g, "([^\\r\\n]+)");
}

function compileRuleRegex(entry) {
  const ko = String(entry?.translations?.["ko-kr"] ?? "").trim();
  if (!ko) return null;

  const mt = String(entry?.matchType ?? "").trim().toLowerCase();

  try {
    if (!mt || mt === "exact") return new RegExp(`^${escapeRegExp(ko)}$`, "m");
    if (mt === "contains") return new RegExp(escapeRegExp(ko), "m");
    if (mt === "word") return new RegExp(`\\b${escapeRegExp(ko)}\\b`, "m");
    if (mt === "regex") return new RegExp(ko, "m");
    if (mt === "pattern") return new RegExp(tokenizePatternToRegex(ko), "m");
  } catch {
    return null;
  }
  return null;
}

function getRulesForRowCategory(rulesCache, rowCategoryKey) {
  const all = Array.isArray(rulesCache?.entries) ? rulesCache.entries : [];
  if (!all.length) return [];

  const cat = String(rowCategoryKey ?? "").trim().toLowerCase();

  // rules 시트 category가 비어있으면 ALL 규칙
  const picked = all.filter((e) => {
    const c = String(e?.category ?? "").trim().toLowerCase();
    const ko = String(e?.translations?.["ko-kr"] ?? "").trim();
    if (!ko) return false;
    if (!c) return true; // ALL
    return c === cat;
  });

  picked.sort((a, b) => {
    const pa = Number(a?.priority ?? 0);
    const pb = Number(b?.priority ?? 0);
    if (pb !== pa) return pb - pa;
    return Number(a?._rowIndex ?? 0) - Number(b?._rowIndex ?? 0);
  });

  return picked;
}

function applyRulesToText({ text, rowCategoryKey, targetLangKey, rulesCache }) {
  let out = String(text ?? "");
  if (!out) return { out, hits: 0, matched: [] };

  const rules = getRulesForRowCategory(rulesCache, rowCategoryKey);
  if (!rules.length) return { out, hits: 0, matched: [] };

  const tlk = String(targetLangKey ?? "").trim().toLowerCase();
  let hits = 0;
  const matched = [];

  for (const r of rules) {
    const to = String(r?.translations?.[tlk] ?? "").trim();
    if (!to) continue;

    const re = r?._compiledRe instanceof RegExp ? r._compiledRe : compileRuleRegex(r);
    if (!(re instanceof RegExp)) continue;

    if (!re.test(out)) {
      re.lastIndex = 0;
      continue;
    }
    re.lastIndex = 0;

    const before = out;
    out = out.replace(re, to);
    if (out !== before) {
      hits += 1;
      matched.push({
        key: r?.key ?? null,
        rowIndex: r?._rowIndex ?? null,
        category: r?.category ?? "",
        matchType: r?.matchType ?? "",
        priority: r?.priority ?? 0,
      });
    }
  }

  return { out, hits, matched };
}

// ---------- Anomaly helpers ----------
function ratio(a, b) {
  const x = Math.max(0, Number(a ?? 0));
  const y = Math.max(0, Number(b ?? 0));
  if (y === 0) return x === 0 ? 1 : 999;
  return x / y;
}

function makeAnomaly({ type, rowIndex, sourceText, processedText, translatedText, meta }) {
  return {
    type,
    rowIndex,
    sourceText: String(sourceText ?? ""),
    processedText: String(processedText ?? ""),
    translatedText: String(translatedText ?? ""),
    meta: meta ?? {},
  };
}

function buildDiagnostics({ cache, srcCol, tgtCol, reqCategory, fillOnlyEmpty, limitSample = 8 }) {
  const rawRows = Array.isArray(cache.rawRows) ? cache.rawRows : [];
  let totalRows = rawRows.length;

  let categoryMatched = 0;
  let sourceNonEmpty = 0;
  let targetEmpty = 0;
  let pendingEligible = 0;

  const samples = [];

  for (let i = 0; i < rawRows.length; i++) {
    const rowIndex = i + 2;
    const entry = cache.entries?.[i];
    const rowCat = String(entry?.category ?? "").trim().toLowerCase();

    if (reqCategory && rowCat !== reqCategory) continue;
    categoryMatched += 1;

    const srcRaw = rawRows[i]?.[srcCol];
    const tgtRaw = rawRows[i]?.[tgtCol];

    const srcEmpty = isEffectivelyEmpty(srcRaw);
    const tgtEmptyFlag = isEffectivelyEmpty(tgtRaw);

    if (!srcEmpty) sourceNonEmpty += 1;

    if (tgtEmptyFlag) targetEmpty += 1;

    const eligible = !srcEmpty && (!fillOnlyEmpty || tgtEmptyFlag);
    if (eligible) pendingEligible += 1;

    if (samples.length < limitSample) {
      samples.push({
        rowIndex,
        category: rowCat,
        sourceEmpty: srcEmpty,
        targetEmpty: tgtEmptyFlag,
        sourcePreview: _stripInvisible(srcRaw).slice(0, 60),
        targetPreview: _stripInvisible(tgtRaw).slice(0, 60),
      });
    }
  }

  return {
    totalRows,
    categoryFilter: reqCategory || "ALL",
    categoryMatched,
    sourceNonEmpty,
    targetEmpty,
    fillOnlyEmpty,
    pendingEligible,
    samples,
  };
}

// ---------------- Routes ----------------
export function registerRoutesV2(app) {
  /**
   * POST /v2/batch/run
   */
  app.post("/v2/batch/run", async (req, res) => {
    try {
      _pruneBatches();

      const raw = getParsedBody(req);
      const body = normalizeBodyForConnector(raw);
      const v = BatchRunSchema.parse(body);

      const debug = Boolean(body.debug); // ✅ schema 밖이지만 허용됨 (zod strict 아님)
      const sheet = pickSheet(v);

      const reqCategory = String(v.category ?? "").trim().toLowerCase(); // "" => ALL
      const sourceLangKey = normalizeLang(v.sourceLang);
      const targetLangKey = normalizeLang(v.targetLang);

      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: Boolean(v.forceReload),
      });

      const srcCol = cache.langIndex[sourceLangKey];
      if (srcCol == null) throw httpError(400, `Missing sourceLang column: ${sourceLangKey}`, { sheet });

      const tgtCol = cache.langIndex[targetLangKey];
      if (tgtCol == null) throw httpError(400, `Missing targetLang column: ${targetLangKey}`, { sheet });

      // categories scope for glossary index
      let categories = null;
      if (reqCategory) {
        if (!cache.byCategoryBySource?.has(reqCategory)) {
          throw httpError(400, `Category not found: ${reqCategory}`, { sheet });
        }
        categories = [reqCategory];
      } else {
        categories = Array.from(cache.byCategoryBySource?.keys?.() ?? []);
      }

      const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);
      const replacePlan = getReplacePlanFromCache({
        cache,
        sheetName: sheet,
        sourceLangKey,
        categories,
        targetLangKey,
      });

      const rulesCache = await ensureRulesLoaded({ forceReload: false });

      const limit = Number(v.limit ?? 200);
      const fillOnlyEmpty = Boolean(v.fillOnlyEmpty);
      const upload = Boolean(v.upload);

      const exclude = new Set(
        Array.isArray(v.excludeRowIndexes) ? v.excludeRowIndexes.map((n) => Number(n)) : []
      );

      // 1) pending rows pick
      const planned = [];
      const rawRows = Array.isArray(cache.rawRows) ? cache.rawRows : [];

      for (let i = 0; i < rawRows.length; i++) {
        const rowIndex = i + 2;
        if (exclude.has(rowIndex)) continue;

        const entry = cache.entries?.[i];
        const rowCat = String(entry?.category ?? "").trim().toLowerCase();
        if (reqCategory && rowCat !== reqCategory) continue;

        const srcRaw = rawRows[i]?.[srcCol];
        if (isEffectivelyEmpty(srcRaw)) continue;

        const tgtRaw = rawRows[i]?.[tgtCol];
        if (fillOnlyEmpty && !isEffectivelyEmpty(tgtRaw)) continue;

        planned.push({
          rowIndex,
          rowCategoryKey: rowCat,
          sourceText: _stripInvisible(srcRaw),
        });

        if (planned.length >= limit) break;
      }

      // planned=0 -> return diagnostics (this is the key improvement)
      if (planned.length === 0) {
        const batchId = _newBatchId();
        const finishedAt = nowIso();

        const diagnostics = buildDiagnostics({
          cache,
          srcCol,
          tgtCol,
          reqCategory,
          fillOnlyEmpty,
          limitSample: debug ? 20 : 8,
        });

        const summary = {
          ok: true,
          batchId,
          sheet,
          category: reqCategory || "ALL",
          sourceLang: v.sourceLang,
          targetLang: v.targetLang,
          planned: 0,
          translated: 0,
          uploaded: 0,
          anomalies: 0,
          finishedAt,
          meta: {
            glossaryLoadedAt: cache.loadedAt,
            rawRowCount: cache.rawRowCount,
            pendingEmptySentinels: _sentinels,
          },
        };

        _batchStore.set(batchId, {
          createdAt: _nowMs(),
          request: { ...v, sheet },
          summary,
          anomalies: [],
        });

        return toJson(res, 200, {
          ok: true,
          batchId,
          summary,
          anomalies: { count: 0, sample: [] },
          message: "No pending rows matched the criteria.",
          diagnostics,
        });
      }

      // 2) glossary replace + rules replace => translate items
      const translateItems = [];
      const prepMeta = [];

      for (const p of planned) {
        const { rowIndex, sourceText, rowCategoryKey } = p;

        const g = replaceByGlossaryWithLogs({
          text: sourceText,
          sourceLangKey,
          targetLangKey,
          sourceTextMap,
          plan: replacePlan,
        });

        const afterGlossary = String(g?.textOut ?? g?.out ?? sourceText);

        const rr = applyRulesToText({
          text: afterGlossary,
          rowCategoryKey,
          targetLangKey,
          rulesCache,
        });

        const afterRules = String(rr.out ?? afterGlossary);

        translateItems.push({
          rowIndex,
          sourceText,
          textForTranslate: afterRules,
        });

        prepMeta.push({
          rowIndex,
          rowCategoryKey,
          sourceText,
          afterGlossary,
          afterRules,
          ruleHits: rr.hits,
          matchedRules: rr.matched,
        });
      }

      // 3) translate (LLM)
      const chunkSize = Number(v.chunkSize ?? 25);
      const model = v.model || undefined;

      const t0 = _nowMs();
      const { results: trResults, meta: trMeta } = await translateItemsWithGpt41({
        sourceLang: v.sourceLang,
        targetLang: v.targetLang,
        items: translateItems,
        chunkSize,
        model,
      });
      const elapsedMs = _nowMs() - t0;

      const trMap = new Map(trResults.map((r) => [Number(r.rowIndex), r]));

      // 4) anomalies + upload data
      const anomalies = [];
      const updates = [];
      let translatedCount = 0;

      for (const m of prepMeta) {
        const r = trMap.get(Number(m.rowIndex));
        const translatedTextRaw = String(r?.translatedText ?? "");
        let translatedText = _stripInvisible(translatedTextRaw);

        const processed = String(m.afterRules ?? "");
        const src = String(m.sourceText ?? "");

        if (!translatedText) {
          translatedText = processed;
          anomalies.push(
            makeAnomaly({
              type: "empty_translation_fallback",
              rowIndex: m.rowIndex,
              sourceText: src,
              processedText: processed,
              translatedText,
              meta: { reason: "LLM returned empty", model: trMeta?.model ?? null },
            })
          );
        }

        translatedCount += 1;

        const rr = ratio(translatedText.length, Math.max(1, processed.length));
        if (rr >= 2.6 || rr <= 0.35) {
          anomalies.push(
            makeAnomaly({
              type: "length_ratio_suspicious",
              rowIndex: m.rowIndex,
              sourceText: src,
              processedText: processed,
              translatedText,
              meta: { ratio: rr, processedLen: processed.length, translatedLen: translatedText.length },
            })
          );
        }

        if (_stripInvisible(translatedText) === _stripInvisible(processed)) {
          anomalies.push(
            makeAnomaly({
              type: "same_as_processed",
              rowIndex: m.rowIndex,
              sourceText: src,
              processedText: processed,
              translatedText,
              meta: { note: "Translated text equals processed text." },
            })
          );
        }

        if (m.ruleHits > 0) {
          anomalies.push(
            makeAnomaly({
              type: "rule_applied",
              rowIndex: m.rowIndex,
              sourceText: src,
              processedText: processed,
              translatedText,
              meta: { ruleHits: m.ruleHits, matchedRules: m.matchedRules.slice(0, 10) },
            })
          );
        }

        if (upload) {
          const a1 = `${colIndexToA1(tgtCol)}${m.rowIndex}`;
          updates.push({ range: `${sheet}!${a1}`, values: [[translatedText]] });
        }
      }

      // 5) upload
      let writeRes = { updatedCells: 0, updatedRanges: [] };
      let uploadedCount = 0;

      if (upload && updates.length > 0) {
        writeRes = await batchUpdateValuesA1(updates);
        uploadedCount = updates.length;
      }

      // store batch
      const batchId = _newBatchId();
      const finishedAt = nowIso();

      const summary = {
        ok: true,
        batchId,
        sheet,
        category: reqCategory || "ALL",
        sourceLang: v.sourceLang,
        targetLang: v.targetLang,
        planned: planned.length,
        translated: translatedCount,
        uploaded: uploadedCount,
        anomalies: anomalies.length,
        finishedAt,
        meta: {
          model: trMeta?.model ?? null,
          chunks: trMeta?.chunks ?? null,
          chunkSize: trMeta?.chunkSize ?? chunkSize,
          elapsedMs,
          updatedCells: writeRes.updatedCells ?? 0,
        },
      };

      _batchStore.set(batchId, {
        createdAt: _nowMs(),
        request: { ...v, sheet },
        summary,
        anomalies,
      });

      return toJson(res, 200, {
        ok: true,
        batchId,
        summary,
        write: upload
          ? {
              updatedCells: writeRes.updatedCells ?? 0,
              updatedRanges: (writeRes.updatedRanges ?? []).slice(0, 50),
            }
          : { dryRun: true },
        anomalies: { count: anomalies.length, sample: anomalies.slice(0, 20) },
        meta: {
          glossaryLoadedAt: cache.loadedAt,
          rawRowCount: cache.rawRowCount,
          pendingEmptySentinels: _sentinels,
          storedTtlMs: _BATCH_TTL_MS,
        },
      });
    } catch (e) {
      handleErr(req, res, e);
    }
  });

  /**
   * GET /v2/batch/:id/anomalies
   */
  app.get("/v2/batch/:id/anomalies", async (req, res) => {
    try {
      _pruneBatches();

      const id = String(req.params.id ?? "").trim();
      if (!id) throw httpError(400, "batchId is required.");

      const q = BatchAnomaliesQuerySchema.parse({
        offset: req.query.offset ? Number(req.query.offset) : 0,
        limit: req.query.limit ? Number(req.query.limit) : 200,
      });

      const data = _batchStore.get(id);
      if (!data) throw httpError(404, "Batch not found (expired or invalid batchId).", { id });

      const anomalies = Array.isArray(data.anomalies) ? data.anomalies : [];
      const slice = anomalies.slice(q.offset, q.offset + q.limit);

      return toJson(res, 200, {
        ok: true,
        batchId: id,
        total: anomalies.length,
        offset: q.offset,
        limit: q.limit,
        items: slice,
        summary: data.summary ?? null,
      });
    } catch (e) {
      handleErr(req, res, e);
    }
  });
}
