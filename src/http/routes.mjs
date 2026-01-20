/**
 * src/http/routes.mjs
 * - REST endpoints only
 * - Server is the single source of truth
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

// ---------------- Session Cache ----------------
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

// ---------------- Routes ----------------
export function registerRoutes(app) {
  // Health
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

      if (!cache.byCategoryBySource.has(categoryKey)) {
        return res.status(400).json({
          ok: false,
          error: `Category not found: ${categoryKey}`,
        });
      }

      const bySource = cache.byCategoryBySource.get(categoryKey);
      const sourceTextMap = bySource?.get(sourceLangKey);
      if (!sourceTextMap || sourceTextMap.size === 0) {
        return res.status(400).json({
          ok: false,
          error: `No source texts for category=${categoryKey}, sourceLang=${sourceLangKey}`,
        });
      }

      const sessionId = newSessionId();
      sessions.set(sessionId, {
        sessionId,
        categoryKey,
        sourceLangKey,
        targetLangKey,
        glossary: cache,
      });

      return res.status(200).json({
        ok: true,
        sessionId,
        category: categoryKey,
        sourceLang: sourceLangKey,
        targetLang: targetLangKey,
        glossaryLoadedAt: cache.loadedAt,
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/translate/replace
   */
  app.post("/v1/translate/replace", async (req, res) => {
    try {
      const body = ReplaceSchema.parse(req.body);
      const wantLogs = body.includeLogs ?? true;

      const sourceLangKey = normalizeLang(body.sourceLang);
      const targetLangKey = normalizeLang(body.targetLang);
      assertAllowedSourceLang(sourceLangKey);

      const cache = await ensureGlossaryLoaded({ forceReload: false });

      const categories = body.category
        ? [String(body.category).trim().toLowerCase()]
        : Array.from(cache.byCategoryBySource.keys());

      const sourceTextMap = mergeSourceTextMapsFromCache(
        cache,
        sourceLangKey,
        categories
      );

      const rulesCache = await ensureRulesLoaded({ forceReload: false });

      const outTexts = [];
      const perLineLogs = [];
      const ruleLogs = [];

      for (let i = 0; i < body.texts.length; i++) {
        const { out, logs } = replaceByGlossaryWithLogs({
          text: body.texts[i],
          sourceLangKey,
          targetLangKey,
          sourceTextMap,
        });

        outTexts.push(out);
        if (wantLogs) perLineLogs.push({ index: i, logs });

        const rLogs = buildRuleLogs({
          text: out,
          categoryKey: body.category ?? "ALL",
          targetLangKey,
          rulesCache,
        });
        ruleLogs.push({ index: i, logs: rLogs });
      }

      return res.status(200).json({
        ok: true,
        mode: "stateless",
        category: body.category ?? "ALL",
        sourceLang: sourceLangKey,
        targetLang: targetLangKey,
        texts: outTexts,
        logs: wantLogs ? perLineLogs : undefined,
        ruleLogs,
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/glossary/candidates/batch
   */
  app.post("/v1/glossary/candidates/batch", async (req, res) => {
    try {
      const body = CandidatesBatchSchema.parse(req.body);
      const out = await runCandidatesBatch(body);
      return res.status(200).json(out);
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/glossary/apply
   * - FULL STABLE VERSION (partial success / conflict-safe)
   */
  app.post("/v1/glossary/apply", async (req, res) => {
    try {
      const body = ApplySchema.parse(req.body ?? {});
      const sourceLangKey = normalizeLang(body.sourceLang ?? "en-US");

      if (!["en-us", "ko-kr"].includes(sourceLangKey)) {
        return res.status(400).json({
          ok: false,
          error: "sourceLang must be en-US or ko-KR for apply.",
        });
      }

      const cache = await ensureGlossaryLoaded({ forceReload: true });

      const categoryKey =
        body.category && String(body.category).trim()
          ? String(body.category).trim().toLowerCase()
          : null;

      const categories = categoryKey
        ? [categoryKey]
        : Array.from(cache.byCategoryBySource.keys());

      const sourceTextMap = mergeSourceTextMapsFromCache(
        cache,
        sourceLangKey,
        categories
      );

      const updates = [];
      const skipped = [];
      const notFound = [];
      const conflicts = [];

      let updatedPlanned = 0;

      const pickLowestRow = (entries) =>
        entries.reduce(
          (min, e) =>
            !min || e._rowIndex < min._rowIndex ? e : min,
          null
        );

      for (const item of body.entries) {
        const sourceText = String(item.sourceText ?? "").trim();
        const matches = sourceTextMap.get(sourceText);

        if (!matches || matches.length === 0) {
          notFound.push({ sourceText });
          continue;
        }

        const entry =
          matches.length === 1 ? matches[0] : pickLowestRow(matches);

        if (matches.length > 1) {
          conflicts.push({
            sourceText,
            rowIndices: matches.map((m) => m._rowIndex),
            appliedRowIndex: entry._rowIndex,
          });
        }

        for (const [langRaw, valRaw] of Object.entries(item.translations || {})) {
          const langKey = normalizeLang(langRaw);
          if (!langKey) continue;

          if (langKey === "en-us" && !body.allowAnchorUpdate) {
            skipped.push({ sourceText, lang: langKey, reason: "anchor_update_blocked" });
            continue;
          }

          const colIdx = cache.langIndex[langKey];
          if (colIdx == null) continue;

          const existing = String(entry.translations?.[langKey] ?? "").trim();
          if (body.fillOnlyEmpty && existing) {
            skipped.push({ sourceText, lang: langKey, reason: "cell_already_has_value" });
            continue;
          }

          const val = String(valRaw ?? "").trim();
          if (!val) continue;

          const a1 = `${SHEET_NAME}!${colIndexToA1(colIdx)}${entry._rowIndex}`;
          updates.push({ range: a1, values: [[val]] });
          updatedPlanned += 1;
        }
      }

      const { updatedCells } = await batchUpdateValuesA1(updates);
      await ensureGlossaryLoaded({ forceReload: true });

      const status =
        updatedCells > 0
          ? skipped.length || conflicts.length
            ? "partial_success"
            : "success"
          : "no_op";

      return res.status(200).json({
        ok: true,
        status,
        category: categoryKey ?? "ALL",
        sourceLang: sourceLangKey === "ko-kr" ? "ko-KR" : "en-US",
        fillOnlyEmpty: Boolean(body.fillOnlyEmpty),
        allowAnchorUpdate: Boolean(body.allowAnchorUpdate),
        writePlan: { intendedUpdates: updatedPlanned },
        result: { updatedCells },
        notFound,
        skipped,
        conflicts,
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });
}
