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

function strip(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
    .trim();
}

/* ---------------- Apply Logic ---------------- */

async function handleApply(req, res) {
  const body = getParsedBody(req) || {};
  const v = ApplySchema.parse(body);

  const sheet = v.sheet;
  const cache = await ensureGlossaryLoaded({ sheetName: sheet });

  const sourceLangKey = normalizeLang(v.sourceLang);
  const srcCol = cache.langIndex[sourceLangKey];
  if (srcCol == null) throw httpError(400, "Missing sourceLang column");

  const updates = [];

  for (const entry of v.entries) {
    const rowIndex = Number(entry.rowIndex);
    const rowArrIdx = rowIndex - 2;
    if (rowArrIdx < 0 || rowArrIdx >= cache.rawRows.length) continue;

    for (const [lang, valRaw] of Object.entries(entry.translations || {})) {
      const langKey = normalizeLang(lang);
      const val = strip(valRaw);
      if (!langKey || !val) continue;

      const colIdx = cache.langIndex[langKey];
      if (colIdx == null) continue;

      const a1 = `${sheet}!${colIndexToA1(colIdx)}${rowIndex}`;
      updates.push({ range: a1, values: [[val]] });
    }
  }

  const writeRes = await batchUpdateValuesA1(updates);
  await ensureGlossaryLoaded({ sheetName: sheet, forceReload: true });

  toJson(res, 200, {
    ok: true,
    updatedCells: writeRes.updatedCells,
  });
}

/* =========================================================
   REGISTER ROUTES
========================================================= */

export function registerRoutes(app) {

  app.get("/health", (_req, res) => {
    toJson(res, 200, { ok: true });
  });

  /* ---------- FULL QA ENGINE ---------- */

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
      if (srcCol == null || tgtCol == null)
        throw httpError(400, "Missing language column");

      /* ---------- 1. QA 대상 수집 ---------- */

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

      /* ---------- 2. Glossary 로드 (항상 source 기준) ---------- */

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

      /* ---------- 3. Anchor 정밀 검사 ---------- */

      for (const item of items) {
        let modified = item.targetText;
        const applied = [];

        const anchorRegex = /«T:([^»]+)»/g;
        const anchors = [...modified.matchAll(anchorRegex)];

        for (const match of anchors) {
          const fullMatch = match[0];          // «T:Cracked Rift»
          const innerValue = strip(match[1]); // Cracked Rift

          for (const entry of glossaryEntries) {
            const sourceValue = strip(entry?.source ?? "");
            const translations = entry?.translations || {};
            const correctTarget = strip(translations[targetLangKey] ?? "");

            if (!sourceValue || !correctTarget) continue;

            // source에 해당 용어가 있어야 검사
            if (!item.sourceText.includes(sourceValue)) continue;

            // 1️⃣ 이미 targetLang이면 정상
            if (innerValue === correctTarget) break;

            // 2️⃣ sourceLang 원문이면 교체
            if (innerValue === sourceValue) {
              modified = modified.replace(
                fullMatch,
                `«T:${correctTarget}»`
              );
              applied.push({
                source: `${sourceValue} (${sourceLangKey})`,
                target: correctTarget,
              });
              break;
            }

            // 3️⃣ 다른 언어 번역이면 교체
            for (const [langKey, valRaw] of Object.entries(translations)) {
              const val = strip(valRaw);
              if (!val) continue;

              if (langKey !== targetLangKey && innerValue === val) {
                modified = modified.replace(
                  fullMatch,
                  `«T:${correctTarget}»`
                );
                applied.push({
                  source: `${val} (${langKey})`,
                  target: correctTarget,
                });
                break;
              }
            }
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
