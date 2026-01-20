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
 * - sourceLang(en-US | ko-KR) 기준으로 기존 행을 찾고
 * - 번역 컬럼만 채워 넣는다
 * - 기본: 빈 셀만 채움(fillOnlyEmpty=true)
 *
 * 안정화 정책:
 * - 중복 매칭(동일 sourceText가 여러 row에 존재) 시, rowIndex가 가장 낮은 row만 적용하고 conflicts에 기록
 * - 대상 셀이 이미 값이 있으면 덮어쓰지 않고 skipped에 기록, 작업은 계속 진행
 * - 부분 성공(partial_success) / no_op를 status로 반환
 */
app.post("/v1/glossary/apply", async (req, res) => {
  try {
    const body = ApplySchema.parse(req.body ?? {});

    const categoryKey =
      body.category && String(body.category).trim()
        ? String(body.category).trim().toLowerCase()
        : null; // null => ALL

    const sourceLangKey = normalizeLang(body.sourceLang ?? "en-US");
    if (sourceLangKey !== "en-us" && sourceLangKey !== "ko-kr") {
      return res.status(400).json({
        ok: false,
        error: "sourceLang must be en-US or ko-KR for apply.",
      });
    }

    const fillOnlyEmpty = Boolean(body.fillOnlyEmpty);
    const allowAnchorUpdate = Boolean(body.allowAnchorUpdate);

    // 최신 Glossary 로드(쓰기 반영은 최신 기준이 안전)
    const cache = await ensureGlossaryLoaded({ forceReload: true });

    // category 범위 결정
    const categoriesToSearch = categoryKey
      ? [categoryKey]
      : Array.from(cache.byCategoryBySource.keys());

    // sourceLang 기준 term -> entry[] merged map 구성
    // (중복 보존: 동일 term이 여러 entry로 들어올 수 있음)
    const sourceTextMap = mergeSourceTextMapsFromCache(
      cache,
      sourceLangKey,
      categoriesToSearch
    );

    const targetLangAllow = body.targetLangs
      ? new Set(body.targetLangs.map(normalizeLang))
      : null;

    const updates = [];

    // 기존 필드 호환 유지용
    const notFound = [];
    const skipped = [];

    // 개선 포맷용
    const resultsApplied = [];
    const resultsSkipped = [];
    const resultsConflicts = [];
    const resultsNotFound = [];

    let matchedRows = 0;
    let updatedCellsPlanned = 0;
    let skippedCellsCount = 0;
    let conflictAnchorsCount = 0;

    // helper: 가장 낮은 row entry 선택
    function pickLowestRowEntry(entries) {
      let best = null;
      for (const e of entries || []) {
        const ri = Number(e?._rowIndex);
        if (!Number.isFinite(ri)) continue;
        if (!best || ri < Number(best._rowIndex)) best = e;
      }
      return best;
    }

    for (const item of body.entries) {
      const sourceText = String(item.sourceText ?? "").trim();
      if (!sourceText) continue;

      const candidates = sourceTextMap.get(sourceText);

      if (!candidates || candidates.length === 0) {
        const nf = {
          sourceText,
          reason: `Row not found by ${sourceLangKey} within ${
            categoryKey ? categoryKey : "ALL categories"
          }`,
        };
        notFound.push(nf);
        resultsNotFound.push(nf);
        continue;
      }

      matchedRows += 1;

      // 중복 처리: 가장 낮은 row만 적용
      let chosen = candidates;
      let chosenEntry = null;

      if (candidates.length === 1) {
        chosenEntry = candidates[0];
      } else {
        chosenEntry = pickLowestRowEntry(candidates);
        conflictAnchorsCount += 1;

        const rowIndices = candidates
          .map((e) => Number(e?._rowIndex))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b);

        resultsConflicts.push({
          sourceText,
          rowIndices,
          resolution: "lowest_row_applied",
          appliedRowIndex: chosenEntry?._rowIndex ?? null,
        });
      }

      if (!chosenEntry) {
        const nf = {
          sourceText,
          reason: "Row candidates exist but no valid rowIndex found.",
        };
        notFound.push(nf);
        resultsNotFound.push(nf);
        continue;
      }

      const rowIndex = chosenEntry._rowIndex;

      // 번역 업데이트 계획 생성
      const updatedLangs = [];
      const skippedLangs = [];

      for (const [langRaw, textRaw] of Object.entries(item.translations || {})) {
        const langKey = normalizeLang(langRaw);
        if (!langKey) continue;

        if (targetLangAllow && !targetLangAllow.has(langKey)) continue;

        const newText = String(textRaw ?? "").trim();
        if (!newText) continue;

        // en-US 컬럼 업데이트는 allowAnchorUpdate=true일 때만 허용
        if (langKey === "en-us" && !allowAnchorUpdate) {
          // 그냥 스킵 처리(명확히 기록)
          const sk = {
            sourceText,
            rowIndex,
            lang: langKey,
            reason: "en-US update blocked (allowAnchorUpdate=false)",
          };
          skipped.push({ sourceText, lang: langKey, reason: sk.reason });
          resultsSkipped.push(sk);
          skippedCellsCount += 1;
          skippedLangs.push(langKey);
          continue;
        }

        // 헤더에 해당 언어 컬럼이 있는지
        const colIdx = cache.langIndex[langKey];
        if (colIdx == null) {
          const sk = {
            sourceText,
            rowIndex,
            lang: langKey,
            reason: "Language column not found in header",
          };
          skipped.push({ sourceText, lang: langKey, reason: sk.reason });
          resultsSkipped.push(sk);
          skippedCellsCount += 1;
          skippedLangs.push(langKey);
          continue;
        }

        // fillOnlyEmpty=true면, 기존 값이 있으면 스킵
        if (fillOnlyEmpty) {
          const existing = String(chosenEntry.translations?.[langKey] ?? "").trim();
          if (existing) {
            const sk = {
              sourceText,
              rowIndex,
              lang: langKey,
              reason: "cell_already_has_value",
            };
            skipped.push({ sourceText, lang: langKey, reason: "Cell already has value (fillOnlyEmpty=true)" });
            resultsSkipped.push(sk);
            skippedCellsCount += 1;
            skippedLangs.push(langKey);
            continue;
          }
        }

        const colA1 = colIndexToA1(colIdx);
        const a1 = `${SHEET_NAME}!${colA1}${rowIndex}`;
        updates.push({ range: a1, values: [[newText]] });
        updatedCellsPlanned += 1;
        updatedLangs.push(langKey);
      }

      // applied 기록(“계획” 기준; 실제 updatedCells는 Google 응답으로 확정)
      resultsApplied.push({
        sourceText,
        rowIndex,
        updatedLangs,
        skippedLangs,
        reason: candidates.length > 1 ? "applied_to_lowest_row" : "applied",
      });
    }

    // 실제 반영
    const { updatedCells, updatedRanges } = await batchUpdateValuesA1(updates);

    // 캐시 갱신(반영 후 최신화)
    await ensureGlossaryLoaded({ forceReload: true });

    // status 계산
    let status = "success";
    if (updatedCells === 0) {
      // 아무 것도 안 써졌으면, 스킵/충돌/미발견 여부로 구분
      if (resultsNotFound.length > 0 || resultsConflicts.length > 0) status = "partial_success";
      else status = "no_op";
    } else {
      if (resultsNotFound.length > 0 || resultsConflicts.length > 0 || resultsSkipped.length > 0) {
        status = "partial_success";
      }
    }

    return res.status(200).json({
      // ===== 기존 응답 호환 필드 =====
      ok: true,
      category: categoryKey ? categoryKey : "ALL",
      sourceLang: sourceLangKey === "ko-kr" ? "ko-KR" : "en-US",
      fillOnlyEmpty,
      allowAnchorUpdate,
      inputCount: body.entries.length,
      matchedRows,
      writePlan: { intendedUpdates: updates.length },
      result: {
        updatedCells,
        updatedRangesCount: updatedRanges.length,
      },
      notFound,
      skipped,

      // ===== 개선 포맷(추가) =====
      status,
      anchorLang: "en-US",
      summary: {
        inputEntries: body.entries.length,
        matchedAnchors: matchedRows,
        processedRows: resultsApplied.length,
        updatedCells,
        skippedCells: skippedCellsCount,
        conflictAnchors: conflictAnchorsCount,
      },
      results: {
        applied: resultsApplied,
        skipped: resultsSkipped,
        conflicts: resultsConflicts,
        notFound: resultsNotFound,
      },
      notes: [
        "Apply supports partial success: already-filled cells are preserved (fillOnlyEmpty).",
        "If duplicate rows match the same sourceText, the lowest rowIndex is applied and recorded in conflicts.",
      ],
      warnings: resultsConflicts.length
        ? ["Duplicate anchors detected. Data cleanup is recommended."]
        : [],
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

