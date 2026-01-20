/**
 * src/http/routes.mjs
 * - REST endpoints 등록만 담당
 * - 내부에서 세션(Map) 유지 (기존 server.mjs와 동일 정책)
 */

import { SHEET_NAME } from "../config/env.mjs";
import {
  normalizeLang,
  assertAllowedSourceLang,
  isLikelyEnglish,
  newSessionId,
} from "../utils/common.mjs";

import {
  ensureGlossaryLoaded,
  ensureRulesLoaded,
} from "../cache/global.mjs";

import {
  InitSchema,
  ReplaceSchema,
  UpdateSchema,
  SuggestSchema,
  CandidatesSchema,
  CandidatesBatchSchema,
  ApplySchema,
} from "./schemas.mjs";

import {
  mergeSourceTextMapsFromCache,
} from "../glossary/index.mjs";

import {
  replaceByGlossaryWithLogs,
  buildRuleLogs,
} from "../replace/replace.mjs";

import {
  batchUpdateValuesA1,
  colIndexToA1,
} from "../google/sheets.mjs";

import { runCandidatesBatch } from "../candidates/batch.mjs";

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

/**
 * 공통 컨텍스트 해결:
 * - sessionId가 있으면 세션 기반
 * - 없으면 stateless 기반 (category optional)
 */
async function resolveReplaceContext({
  sessionId,
  category,
  sourceLang,
  targetLang,
}) {
  // rules는 replace마다 로드(캐시) 사용
  const rulesCache = await ensureRulesLoaded({ forceReload: false });

  // 1) session 기반
  if (sessionId) {
    const s = getSessionOrThrow(sessionId);

    const bySource = s.glossary.byCategoryBySource.get(s.categoryKey);
    const sourceTextMap = bySource?.get(s.sourceLangKey);
    if (!sourceTextMap) {
      const err = new Error(
        `Source index missing for category='${s.categoryKey}', sourceLang='${s.sourceLangKey}'`
      );
      err.status = 400;
      throw err;
    }

    return {
      mode: "session",
      sessionId,
      categoryKey: s.categoryKey,
      sourceLangKey: s.sourceLangKey,
      targetLangKey: s.targetLangKey,
      sourceTextMap,
      rulesCache,
      rulesCategoryKey: s.categoryKey,
      glossaryLoadedAt: s.glossary.loadedAt,
      glossaryRawRowCount: s.glossary.rawRowCount,
      categoriesUsedCount: 1,
      uniqueTermsInIndex: sourceTextMap.size,
    };
  }

  // 2) stateless 기반
  const sourceLangKey = normalizeLang(sourceLang);
  const targetLangKey = normalizeLang(targetLang);
  assertAllowedSourceLang(sourceLangKey);

  const cache = await ensureGlossaryLoaded({ forceReload: false });

  if (sourceLangKey === "en-us" && cache.langIndex["en-us"] == null) {
    const err = new Error("Header does not include en-US. Cannot use sourceLang=en-US.");
    err.status = 400;
    throw err;
  }

  let categories = [];
  let rulesCategoryKey = "ALL";

  if (category && String(category).trim()) {
    const catKey = String(category).trim().toLowerCase();
    if (!cache.byCategoryBySource.has(catKey)) {
      const err = new Error(`Category not found: ${category}`);
      err.status = 400;
      throw err;
    }
    categories = [catKey];
    rulesCategoryKey = catKey;
  } else {
    categories = Array.from(cache.byCategoryBySource.keys());
    rulesCategoryKey = "ALL";
  }

  const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);
  if (!sourceTextMap || sourceTextMap.size === 0) {
    const err = new Error(
      `No source texts found for sourceLang='${sourceLangKey}' (category=${
        category ? String(category) : "ALL"
      }).`
    );
    err.status = 400;
    throw err;
  }

  return {
    mode: "stateless",
    sessionId: null,
    categoryKey: category && String(category).trim() ? String(category).trim().toLowerCase() : "ALL",
    sourceLangKey,
    targetLangKey,
    sourceTextMap,
    rulesCache,
    rulesCategoryKey,
    glossaryLoadedAt: cache.loadedAt,
    glossaryRawRowCount: cache.rawRowCount,
    categoriesUsedCount: categories.length,
    uniqueTermsInIndex: sourceTextMap.size,
  };
}

// ---------------- Routes ----------------
export function registerRoutes(app) {
  // health/basic
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
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

      const cache = await ensureGlossaryLoaded({ forceReload: false });

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
   */
  app.post("/v1/translate/replace", async (req, res) => {
    try {
      const parsed = ReplaceSchema.parse(req.body);
      const wantLogs = parsed.includeLogs ?? true;
      const limit = parsed.limit ?? parsed.texts.length;
      const texts = parsed.texts.slice(0, limit);

      const ctx = await resolveReplaceContext({
        sessionId: parsed.sessionId,
        category: parsed.category,
        sourceLang: parsed.sourceLang,
        targetLang: parsed.targetLang,
      });

      const outTexts = [];
      const perLineLogs = [];
      const perLineRuleLogs = [];
      let replacedTotalAll = 0;
      let matchedTermsAll = 0;

      for (let i = 0; i < texts.length; i++) {
        const input = texts[i];
        const { out, replacedTotal, logs } = replaceByGlossaryWithLogs({
          text: input,
          sourceLangKey: ctx.sourceLangKey,
          targetLangKey: ctx.targetLangKey,
          sourceTextMap: ctx.sourceTextMap,
        });

        outTexts.push(out);
        replacedTotalAll += replacedTotal;
        matchedTermsAll += logs.length;

        if (wantLogs) perLineLogs.push({ index: i, replacedTotal, logs });

        const ruleLogs = buildRuleLogs({
          text: out,
          categoryKey: ctx.rulesCategoryKey,
          targetLangKey: ctx.targetLangKey,
          rulesCache: ctx.rulesCache,
        });
        perLineRuleLogs.push({ index: i, logs: ruleLogs });
      }

      return res.status(200).json({
        ok: true,
        mode: ctx.mode,
        sessionId: ctx.sessionId,
        category: ctx.categoryKey,
        sourceLang: ctx.sourceLangKey,
        targetLang: ctx.targetLangKey,
        texts: outTexts,
        summary: {
          lines: texts.length,
          replacedTotal: replacedTotalAll,
          matchedTerms: matchedTermsAll,
          glossaryLoadedAt: ctx.glossaryLoadedAt,
          rawRowCount: ctx.glossaryRawRowCount,
          categoriesUsedCount: ctx.categoriesUsedCount,
          uniqueTermsInIndex: ctx.uniqueTermsInIndex,
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

      // process-global reload
      if (!sessionId) {
        const cache = await ensureGlossaryLoaded({ forceReload: true });

        let updatedSessions = 0;
        for (const [sid, s] of sessions.entries()) {
          const categoryKey = s.categoryKey;
          const sourceLangKey = s.sourceLangKey;

          if (sourceLangKey === "en-us" && cache.langIndex["en-us"] == null) {
            // keep session but cannot validate further
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

      // session reload
      const s = getSessionOrThrow(sessionId);
      const cache = await ensureGlossaryLoaded({ forceReload: true });

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
      const cache = await ensureRulesLoaded({ forceReload: true });
      return res.status(200).json({
        ok: true,
        mode: "process",
        rulesLoadedAt: cache.loadedAt,
        rawRowCount: cache.rawRowCount,
        itemRulesCount: cache.itemEntries.length,
      });
    } catch (e) {
      const status = e?.status ?? 500;
      return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  /**
   * POST /v1/glossary/suggest
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
        for (const t of targetLangKeys) candidatesByLang[t] = [];

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
   * POST /v1/glossary/candidates
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
   * POST /v1/glossary/candidates/batch
   */
  app.post("/v1/glossary/candidates/batch", async (req, res) => {
    try {
      const body = CandidatesBatchSchema.parse(req.body ?? {});
      const out = await runCandidatesBatch(body);
      return res.status(200).json(out);
    } catch (e) {
      const status = e?.status ?? 500;
      return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  /**
   * POST /v1/glossary/apply
   * - NEW: sourceLang can be en-US or ko-KR
   * - Row match uses sourceLang text (with optional category filter)
   * - Writing en-US column still requires allowAnchorUpdate=true
   */
  app.post("/v1/glossary/apply", async (req, res) => {
    try {
      const body = ApplySchema.parse(req.body ?? {});

      const categoryKey = body.category && String(body.category).trim()
        ? String(body.category).trim().toLowerCase()
        : null; // null => ALL

      const sourceLangKey = normalizeLang(body.sourceLang ?? "en-US");
      if (sourceLangKey !== "en-us" && sourceLangKey !== "ko-kr") {
        return res.status(400).json({ ok: false, error: "sourceLang must be en-US or ko-KR for apply." });
      }

      const allowAnchorUpdate = Boolean(body.allowAnchorUpdate);

      // 최신 Glossary 로드(쓰기 반영은 최신 기준이 안전)
      const cache = await ensureGlossaryLoaded({ forceReload: true });

      // 소스 언어 컬럼 존재 확인
      if (cache.langIndex[sourceLangKey] == null) {
        return res.status(400).json({
          ok: false,
          error: `Header does not include ${body.sourceLang} column. Cannot apply by sourceLang=${body.sourceLang}.`,
        });
      }

      // en-US 컬럼 쓰기 가능 여부
      if (!allowAnchorUpdate && Object.values(body.entries || []).some((e) => e?.translations && e.translations["en-US"])) {
        // 스키마는 통과하지만 정책상 막는다(안전)
        // 실제로는 normalizeLang로 en-us 체크를 아래 write loop에서 하므로,
        // 여기서는 명확한 에러 메시지를 제공하기 위함.
      }

      const targetLangAllow = body.targetLangs ? new Set(body.targetLangs.map(normalizeLang)) : null;

      const updates = [];
      const notFound = [];
      const skipped = [];
      const conflicts = [];
      let matchedRows = 0;

      /**
       * Build lookup:
       * - If categoryKey provided: search only that category
       * - Else: search ALL categories
       * Use cache.byCategoryBySource: Map<cat, Map<srcLangKey, Map<sourceText, entry[]>>>
       */
      const categoriesToSearch = categoryKey
        ? [categoryKey]
        : Array.from(cache.byCategoryBySource.keys());

      // Precheck: category existence if specified
      if (categoryKey && !cache.byCategoryBySource.has(categoryKey)) {
        return res.status(400).json({ ok: false, error: `Category not found: ${body.category}` });
      }

      for (const item of body.entries) {
        const sourceText = String(item.sourceText ?? "").trim();
        if (!sourceText) continue;

        // Collect matched entries across chosen categories
        const matchedEntries = [];
        for (const cat of categoriesToSearch) {
          const bySource = cache.byCategoryBySource.get(cat);
          const map = bySource?.get(sourceLangKey);
          const arr = map?.get(sourceText);
          if (Array.isArray(arr) && arr.length) matchedEntries.push(...arr);
        }

        if (matchedEntries.length === 0) {
          notFound.push({
            sourceText,
            reason: `Row not found by ${sourceLangKey} within ${categoryKey ? "category filter" : "ALL categories"}`,
          });
          continue;
        }

        // Detect conflict: same sourceText matches multiple different rows
        const rowSet = new Set(matchedEntries.map((e) => e?._rowIndex).filter(Boolean));
        if (rowSet.size > 1) {
          conflicts.push({
            sourceText,
            reason: "Multiple rows matched for the same sourceText",
            matchedRowIndexes: Array.from(rowSet).sort((a, b) => a - b),
          });
          continue;
        }

        const rowEntry = matchedEntries[0];
        const rowIndex = rowEntry._rowIndex;
        matchedRows += 1;

        for (const [langRaw, textRaw] of Object.entries(item.translations || {})) {
          const langKey = normalizeLang(langRaw);
          if (!langKey) continue;

          // sourceLang은 '키'일 뿐, 기본적으로는 쓰지 않음.
          // 단 allowAnchorUpdate=true일 때 en-us 쓰기 허용.
          if (langKey === sourceLangKey) {
            // 같은 언어 컬럼에 덮어쓰는 건 기본 금지(정책상)
            skipped.push({ sourceText, lang: langKey, reason: "Skipping update to sourceLang column (identifier field)" });
            continue;
          }

          if (langKey === "en-us" && !allowAnchorUpdate) {
            skipped.push({ sourceText, lang: "en-us", reason: "en-US update blocked (allowAnchorUpdate=false)" });
            continue;
          }

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

      if (conflicts.length > 0) {
        return res.status(409).json({
          ok: false,
          error: "Duplicate sourceText rows found (conflict). Refine with category or resolve duplicates.",
          conflicts,
          notFound,
          skipped,
        });
      }

      const { updatedCells, updatedRanges } = await batchUpdateValuesA1(updates);

      // 캐시 갱신(반영 후 최신화)
      await ensureGlossaryLoaded({ forceReload: true });

      return res.status(200).json({
        ok: true,
        category: categoryKey ?? "ALL",
        sourceLang: body.sourceLang ?? "en-US",
        fillOnlyEmpty: Boolean(body.fillOnlyEmpty),
        allowAnchorUpdate,
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
}
