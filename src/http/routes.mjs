// src/http/routes.mjs
// FINAL: Server-side QA engine (Full preserved version)
// - QA sheet and Glossary sheet separated
// - Anchor reverse validation
// - finalize includes sourceText (Apply compatible)
// - All original routes preserved

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
  const cache = await ensureGlossaryLoaded({ sheetName: sheet });

  const sourceLangKey = normalizeLang(v.sourceLang);
  const srcCol = cache.langIndex[sourceLangKey];
  if (srcCol == null) throw httpError(400, "Missing sourceLang column");

  const updates = [];
  const results = [];

  for (const entry of v.entries) {
    const rowIndex = Number(entry.rowIndex);
    const sourceText = strip(entry.sourceText);

    const rowArrIdx = rowIndex - 2;
    if (rowArrIdx < 0 || rowArrIdx >= cache.rawRows.length) {
      results.push({ rowIndex, status: "skipped", reason: "rowIndex_out_of_range" });
      continue;
    }

    const rawRow = cache.rawRows[rowArrIdx] || [];
    const actualSrc = strip(rawRow[srcCol]);

    if (actualSrc !== sourceText) {
      results.push({ rowIndex, status: "skipped", reason: "source_mismatch" });
      continue;
    }

    let updated = 0;

    for (const [lang, valRaw] of Object.entries(entry.translations || {})) {
      const langKey = normalizeLang(lang);
      const val = strip(valRaw);
      if (!langKey || !val) continue;

      const colIdx = cache.langIndex[langKey];
      if (colIdx == null) continue;

      const a1 = `${sheet}!${colIndexToA1(colIdx)}${rowIndex}`;
      updates.push({ range: a1, values: [[val]] });
      updated += 1;
    }

    results.push({
      rowIndex,
      updatedCellsPlanned: updated,
      status: updated ? "success" : "no_op",
    });
  }

  const writeRes = await batchUpdateValuesA1(updates);
  await ensureGlossaryLoaded({ sheetName: sheet, forceReload: true });

  toJson(res, 200, {
    ok: true,
    sheet,
    plannedUpdates: updates.length,
    updatedCells: writeRes.updatedCells,
    updatedRanges: writeRes.updatedRanges,
    results,
  });
}

/* ---------------- Routes ---------------- */

export function registerRoutes(app) {

  app.get("/health", (_req, res) => {
    toJson(res, 200, { ok: true });
  });

  /* =========================================================
     🔥 FULL QA ENGINE (FIXED + APPLY COMPATIBLE)
  ========================================================= */

  app.post("/v1/qa/run", async (req, res) => {
    try {
      const body = getParsedBody(req) || {};

      const qaSheet = String(body.sheet ?? "").trim();
      const sourceLangKey = normalizeLang(body.sourceLang);
      const targetLangKey = normalizeLang(body.targetLang);
      const limit = Number(body.limit ?? 50);
      const cursor = Number(body.cursor ?? 0);

      if (!qaSheet) throw httpError(400, "sheet is required.");
      if (!sourceLangKey) throw httpError(400, "sourceLang is required.");
      if (!targetLangKey) throw httpError(400, "targetLang is required.");

      const qaCache = await ensureGlossaryLoaded({ sheetName: qaSheet });
      const glossaryCache = await ensureGlossaryLoaded({ sheetName: "Glossary" });

      const qaSrcCol = qaCache.langIndex[sourceLangKey];
      const qaTgtCol = qaCache.langIndex[targetLangKey];

      if (qaSrcCol == null) throw httpError(400, "Missing sourceLang column in QA sheet");
      if (qaTgtCol == null) throw httpError(400, "Missing targetLang column in QA sheet");

      /* ---------- QA 대상 수집 ---------- */

      const items = [];
      let nextCursor = cursor;

      for (let i = cursor; i < qaCache.entries.length; i++) {
        const row = qaCache.rawRows[i] || [];
        const rowIndex = i + 2;

        const sourceText = strip(row[qaSrcCol]);
        const targetText = strip(row[qaTgtCol]);

        if (!sourceText || !targetText) continue;

        items.push({ rowIndex, sourceText, targetText });

        if (items.length >= limit) {
          nextCursor = i + 1;
          break;
        }
      }

      /* ---------- Glossary reverseMap 생성 ---------- */

      const categories = Array.from(glossaryCache.byCategoryBySource.keys());
      const sourceTextMap = mergeSourceTextMapsFromCache(
        glossaryCache,
        glossaryCache.langIndex[sourceLangKey] != null ? sourceLangKey : "ko-kr",
        categories
      );

      const reverseMap = Object.create(null);

      for (const entries of sourceTextMap.values()) {
        for (const e of entries || []) {
          const translations = e?.translations || {};
          const correct = strip(translations[targetLangKey] ?? "");
          if (!correct) continue;

          for (const [langKeyRaw, valRaw] of Object.entries(translations)) {
            const langKey = normalizeLang(langKeyRaw);
            const val = strip(valRaw);
            if (!val) continue;

            if (!reverseMap[val]) {
              reverseMap[val] = { correct, lang: langKey };
            }
          }
        }
      }

      /* ---------- Anchor 강제 검증 ---------- */

      const finalize = [];
      const maskSummary = [];
      const anchorRegex = /«T:([^»]+)»/g;

      for (const item of items) {
        let modified = item.targetText;
        const applied = [];

        const matches = [...modified.matchAll(anchorRegex)];
        if (!matches.length) continue;

        let rebuilt = "";
        let lastIndex = 0;

        for (const m of matches) {
          const full = m[0];
          const inner = strip(m[1]);
          const idx = Number(m.index ?? 0);

          rebuilt += modified.slice(lastIndex, idx);

          const info = reverseMap[inner];

          if (info && info.lang !== targetLangKey) {
            rebuilt += `«T:${info.correct}»`;
            applied.push({
              source: `${inner} (${info.lang})`,
              target: info.correct,
            });
          } else {
            rebuilt += full;
          }

          lastIndex = idx + full.length;
        }

        rebuilt += modified.slice(lastIndex);

        if (applied.length) {
          maskSummary.push({
            rowIndex: item.rowIndex,
            applied,
          });
        }

        if (rebuilt !== item.targetText) {
          finalize.push({
            rowIndex: item.rowIndex,
            sourceText: item.sourceText,   // 🔥 Apply 호환 핵심
            translation: rebuilt,
          });
        }
      }

      toJson(res, 200, {
        ok: true,
        cursorNext: nextCursor < qaCache.entries.length ? String(nextCursor) : null,
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
