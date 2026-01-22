/**
 * src/http/routes.mjs
 * - REST endpoints (sheet-aware)
 * - Targets: replaceGlossaryTerms, glossaryPendingNext, updateGlossary, glossaryApply
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
} from "./schemas.mjs";

// ---------------- In-memory sessions (lightweight) ----------------
const _sessions = new Map(); // sessionId -> { sheet, category, sourceLangKey, targetLangKey, createdAt }

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
  return String(v?.sheet ?? "Glossary").trim() || "Glossary";
}

// ---------------- Endpoint registration ----------------
export function registerRoutes(app) {
  // ✅ basic routes (원본과 동일하게 복구)
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/", (_req, res) => res.status(200).send("ok"));

  /**
   * Session init (optional but kept for compatibility)
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

      // Ensure cache exists for that sheet (validates headers)
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

      // Resolve config either from session or from request
      let cfg = null;
      if (v.sessionId) {
        cfg = _sessions.get(v.sessionId) || null;
        if (!cfg) throw httpError(400, `Unknown sessionId: ${v.sessionId}`);
      }

      const category = String(v.category ?? cfg?.category ?? "").trim();
      const sourceLangKey = normalizeLang(v.sourceLang ?? cfg?.sourceLangKey ?? "");
      const targetLangKey = normalizeLang(v.targetLang ?? cfg?.targetLangKey ?? "");

      if (!sourceLangKey || !targetLangKey) {
        throw httpError(
          400,
          "sourceLang and targetLang are required (or provide sessionId)."
        );
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
      const categoryKey = category
        ? String(category).trim().toLowerCase()
        : categories[0] || "";

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
      if (!targetLangKeys.length) throw httpError(400, "targetLangs must have at least 1 language.");

      for (const lk of targetLangKeys) {
        if (cache.langIndex[lk] == null) {
          throw httpError(400, `Sheet '${sheet}' does not include target language column: ${lk}`);
        }
      }

      const srcCol = cache.langIndex[sourceLangKey];
      if (srcCol == null) {
        throw httpError(400, `Sheet '${sheet}' does not include source language column: ${sourceLangKey}`);
      }

      const limit = Number(v.limit || 100);
      const out = [];

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
        throw httpError(400, `Sheet '${sheet}' does not include source language column: ${sourceLangKey}`);
      }

      let categories = null;
      if (v.category && String(v.category).trim()) {
        const catKey = String(v.category).trim().toLowerCase();
        if (!cache.byCategoryBySource.has(catKey)) {
          throw httpError(400, `Category not found: ${v.category}`, { sheet });
        }
        categories = [catKey];
      } else {
        categories = Array.from(cache.byCategoryBySource.keys());
      }

      const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);

      const fillOnlyEmpty = Boolean(v.fillOnlyEmpty);
      const allowAnchorUpdate = Boolean(v.allowAnchorUpdate);

      const updates = [];
      const results = [];

      for (const entry of v.entries) {
        const sourceText = String(entry?.sourceText ?? "").trim();
        if (!sourceText) {
          results.push({ sourceText: "", status: "skipped", reason: "empty sourceText" });
          continue;
        }

        const hits = sourceTextMap.get(sourceText) || [];
        if (!hits.length) {
          results.push({ sourceText, status: "skipped", reason: "not_found" });
          continue;
        }

        let chosen = hits[0];
        for (const h of hits) {
          if (Number(h?._rowIndex) < Number(chosen?._rowIndex)) chosen = h;
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

      toJson(res, 200, {
        ok: true,
        sheet,
        fillOnlyEmpty,
        allowAnchorUpdate,
        plannedUpdates: updates.length,
        updatedCells: writeRes.updatedCells,
        updatedRanges: writeRes.updatedRanges,
        results,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });
}
