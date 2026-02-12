// src/http/routes.mjs

import {
  normalizeLang,
  getParsedBody,
  escapeRegExp,
} from "../utils/common.mjs";

import {
  ensureGlossaryLoaded,
} from "../cache/global.mjs";

import {
  mergeSourceTextMapsFromCache,
} from "../glossary/index.mjs";

import {
  colIndexToA1,
  batchUpdateValuesA1,
} from "../google/sheets.mjs";

import {
  GlossaryQaNextSchema,
  ApplySchema,
  UpdateSchema,
} from "./schemas.mjs";

/* ---------------- Helpers ---------------- */

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra;
  return e;
}

function toJson(res, status, payload) {
  res.status(status).json(payload);
}

function handleErr(res, e) {
  toJson(res, Number(e?.status) || 500, {
    ok: false,
    error: String(e?.message ?? e),
    extra: e?.extra,
  });
}

function pickSheet(v) {
  return String(v?.sheet ?? "Glossary").trim() || "Glossary";
}

function normalizeBody(body) {
  const b = body && typeof body === "object" ? body : {};
  if (b.category == null) b.category = "";
  if (b.sheet == null) b.sheet = "Glossary";
  return b;
}

function strip(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
    .trim();
}

/* ---------------- Apply Logic ---------------- */

async function handleApply(req, res) {
  const body = normalizeBody(getParsedBody(req));
  const v = ApplySchema.parse(body);

  const sheet = pickSheet(v);
  const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: false });

  const sourceLangKey = normalizeLang(v.sourceLang);
  const srcCol = cache.langIndex[sourceLangKey];
  if (srcCol == null) throw httpError(400, "Missing sourceLang column");

  const updates = [];
  const results = [];

  for (const entry of v.entries) {
    const rowIndex = Number(entry.rowIndex);
    const sourceText = strip(entry.sourceText);

    const rowArrIdx = rowIndex - 2;
    if (rowArrIdx < 0 || rowArrIdx >= cache.rawRows.length) continue;

    const rawRow = cache.rawRows[rowArrIdx] || [];
    const actualSrc = strip(rawRow[srcCol]);

    if (actualSrc !== sourceText) continue;

    for (const [lang, valRaw] of Object.entries(entry.translations || {})) {
      const langKey = normalizeLang(lang);
      const val = strip(valRaw);
      if (!langKey || !val) continue;

      const colIdx = cache.langIndex[langKey];
      if (colIdx == null) continue;

      const a1 = `${sheet}!${colIndexToA1(colIdx)}${rowIndex}`;
      updates.push({ range: a1, values: [[val]] });
    }

    results.push({ rowIndex, status: "success" });
  }

  const writeRes = await batchUpdateValuesA1(updates);
  await ensureGlossaryLoaded({ sheetName: sheet, forceReload: true });

  toJson(res, 200, {
    ok: true,
    updatedCells: writeRes.updatedCells,
    results,
  });
}

/* =========================================================
   ROUTES
========================================================= */

export function registerRoutes(app) {

  app.get("/health", (_req, res) => {
    toJson(res, 200, { ok: true });
  });

  /* ---------- Glossary Update ---------- */

  app.post("/v1/glossary/update", async (req, res) => {
    try {
      const body = normalizeBody(getParsedBody(req));
      const v = UpdateSchema.parse(body);

      const sheet = pickSheet(v);
      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: true,
      });

      toJson(res, 200, {
        ok: true,
        sheet: cache.sheetName,
        glossaryLoadedAt: cache.loadedAt,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /* ---------- QA Next (기존 유지) ---------- */

  app.post("/v1/glossary/qa/next", async (req, res) => {
    try {
      const body = normalizeBody(getParsedBody(req));
      const v = GlossaryQaNextSchema.parse(body);

      const sheet = pickSheet(v);
      const cache = await ensureGlossaryLoaded({ sheetName: sheet });

      const sourceLangKey = normalizeLang(v.sourceLang);
      const targetLangKey = normalizeLang(v.targetLang);

      const srcCol = cache.langIndex[sourceLangKey];
      const tgtCol = cache.langIndex[targetLangKey];

      const limit = Number(v.limit ?? 50);
      let start = Number(v.cursor ?? 0);

      const items = [];

      for (let i = start; i < cache.entries.length; i++) {
        const row = cache.rawRows[i] || [];
        const rowIndex = i + 2;

        const sourceText = strip(row[srcCol]);
        const targetText = strip(row[tgtCol]);

        if (!sourceText || !targetText) continue;

        items.push({ rowIndex, sourceText, targetText });

        if (items.length >= limit) {
          start = i + 1;
          break;
        }
      }

      toJson(res, 200, {
        ok: true,
        cursorNext: start < cache.entries.length ? String(start) : null,
        items,
      });

    } catch (e) {
      handleErr(res, e);
    }
  });

  /* =========================================================
     🔥 FULL QA ENGINE (강화 버전)
  ========================================================= */

  app.post("/v1/qa/run", async (req, res) => {
    try {
      const body = getParsedBody(req) || {};
      const sheet = String(body.sheet ?? "").trim();
      const sourceLangKey = normalizeLang(body.sourceLang);
      const targetLangKey = normalizeLang(body.targetLang);
      const limit = Number(body.limit ?? 50);
      const cursor = Number(body.cursor ?? 0);

      if (!sheet || !sourceLangKey || !targetLangKey) {
        throw httpError(400, "sheet, sourceLang, targetLang required");
      }

      const cache = await ensureGlossaryLoaded({ sheetName: sheet });

      const srcCol = cache.langIndex[sourceLangKey];
      const tgtCol = cache.langIndex[targetLangKey];

      const items = [];
      let nextCursor = cursor;

      for (let i = cursor; i < cache.entries.length; i++) {
        const row = cache.rawRows[i] || [];
        const rowIndex = i + 2;

        const sourceText = strip(row[srcCol]);
        const targetText = strip(row[tgtCol]);

        if (!sourceText || !targetText) continue;

        items.push({ rowIndex, sourceText, targetText });

        if (items.length >= limit) {
          nextCursor = i + 1;
          break;
        }
      }

      const glossaryMaps = mergeSourceTextMapsFromCache(
        cache,
        sourceLangKey,
        Array.from(cache.byCategoryBySource.keys())
      );

      const glossaryEntries = [];
      for (const arr of glossaryMaps.values()) {
        for (const e of arr || []) glossaryEntries.push(e);
      }

      const finalize = [];
      const maskSummary = [];

      for (const item of items) {
        let modified = item.targetText;
        const applied = [];

        for (const entry of glossaryEntries) {
          const sourceValue = strip(entry?.source ?? "");
          const translations = entry?.translations || {};
          const correctTarget = strip(translations[targetLangKey] ?? "");

          if (!sourceValue || !correctTarget) continue;
          if (!item.sourceText.includes(sourceValue)) continue;

          for (const [langKey, valRaw] of Object.entries(translations)) {
            const val = strip(valRaw);
            if (!val) continue;

            if (langKey !== targetLangKey && modified.includes(val)) {
              modified = modified.replace(
                new RegExp(escapeRegExp(val), "g"),
                correctTarget
              );
              applied.push({
                source: `${val} (${langKey})`,
                target: correctTarget,
              });
            }
          }

          if (modified.includes(sourceValue)) {
            modified = modified.replace(
              new RegExp(escapeRegExp(sourceValue), "g"),
              correctTarget
            );
            applied.push({
              source: `${sourceValue} (${sourceLangKey})`,
              target: correctTarget,
            });
          }
        }

        if (applied.length) {
          maskSummary.push({
            rowIndex: item.rowIndex,
            applied,
          });
        }

        if (modified !== item.targetText) {
          finalize.push({
            rowIndex: item.rowIndex,
            translation: modified,
          });
        }
      }

      toJson(res, 200, {
        ok: true,
        cursorNext:
          nextCursor < cache.entries.length ? String(nextCursor) : null,
        hasFix: finalize.length > 0,
        maskSummary,
        finalize,
      });

    } catch (e) {
      handleErr(res, e);
    }
  });

  /* ---------- Apply ---------- */

  app.post("/run-apply", async (req, res) => {
    try {
      await handleApply(req, res);
    } catch (e) {
      handleErr(res, e);
    }
  });

}
