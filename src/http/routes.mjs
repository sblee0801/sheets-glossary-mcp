// src/http/routes.mjs
// - QA / Apply / Glossary Update only (minimal)
// - QA default 100 (schema)
// - QA response text length clip via env QA_TEXT_MAX_CHARS
// - APPLY: always overwrite (QA policy)
// - RUN-APPLY: non-consequential wrapper for CustomGPT

import { normalizeLang, getParsedBody } from "../utils/common.mjs";
import { ensureGlossaryLoaded } from "../cache/global.mjs";
import { colIndexToA1, batchUpdateValuesA1 } from "../google/sheets.mjs";
import { GlossaryQaNextSchema, ApplySchema, UpdateSchema } from "./schemas.mjs";

// ---------------- Helpers ----------------
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

// NBSP + zero-width + BOM 제거
function strip(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
    .trim();
}

// QA 응답 텍스트 컷
const QA_TEXT_MAX_CHARS = Number(process.env.QA_TEXT_MAX_CHARS ?? 2000);
function clipForQaResponse(s) {
  const t = strip(s);
  if (!Number.isFinite(QA_TEXT_MAX_CHARS) || QA_TEXT_MAX_CHARS <= 0) return t;
  return t.length > QA_TEXT_MAX_CHARS ? t.slice(0, QA_TEXT_MAX_CHARS) : t;
}

// ---------------- Core Apply Logic (공통) ----------------
async function handleApply(req, res) {
  const body = normalizeBody(getParsedBody(req));
  const v = ApplySchema.parse(body);

  const sheet = pickSheet(v);
  const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: false });

  const sourceLangKey = normalizeLang(v.sourceLang);
  if (sourceLangKey !== "en-us" && sourceLangKey !== "ko-kr") {
    throw httpError(400, "apply sourceLang must be en-US or ko-KR.");
  }

  const srcCol = cache.langIndex[sourceLangKey];
  if (srcCol == null) throw httpError(400, "Missing sourceLang column");

  const updates = [];
  const results = [];

  for (const entry of v.entries) {
    const rowIndex = Number(entry.rowIndex);
    const sourceText = strip(entry.sourceText);

    if (!Number.isFinite(rowIndex) || rowIndex < 2) {
      results.push({ rowIndex: entry.rowIndex, status: "skipped", reason: "invalid_rowIndex" });
      continue;
    }

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

// ---------------- Routes ----------------
export function registerRoutes(app) {
  app.get("/health", (_req, res) => {
    toJson(res, 200, { ok: true });
  });

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
        rawRowCount: cache.rawRowCount,
        categoriesCount: cache.byCategoryBySource.size,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post("/v1/glossary/qa/next", async (req, res) => {
    try {
      const body = normalizeBody(getParsedBody(req));
      const v = GlossaryQaNextSchema.parse(body);

      const sheet = pickSheet(v);
      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: Boolean(v.forceReload),
      });

      const sourceLangKey = normalizeLang(v.sourceLang);
      const targetLangKey = normalizeLang(v.targetLang);

      if (sourceLangKey !== "en-us" && sourceLangKey !== "ko-kr") {
        throw httpError(400, "qa/next sourceLang must be en-US or ko-KR.");
      }

      const srcCol = cache.langIndex[sourceLangKey];
      const tgtCol = cache.langIndex[targetLangKey];
      if (srcCol == null) throw httpError(400, "Missing sourceLang column");
      if (tgtCol == null) throw httpError(400, "Missing targetLang column");

      const categoryKey =
        v.category && String(v.category).trim()
          ? String(v.category).trim().toLowerCase()
          : null;

      const limit = Number(v.limit ?? 100);
      let start = 0;

      if (v.cursor && String(v.cursor).trim()) {
        const n = Number(String(v.cursor).trim());
        if (!Number.isFinite(n) || n < 0)
          throw httpError(400, "cursor must be a non-negative integer string.");
        start = Math.floor(n);
      }

      const items = [];
      let i = start;

      for (; i < cache.entries.length; i++) {
        const entry = cache.entries[i];
        const row = cache.rawRows[i] || [];
        const rowIndex = i + 2;

        if (categoryKey) {
          const c = String(entry?.category ?? "").trim().toLowerCase();
          if (c !== categoryKey) continue;
        }

        const sourceText = strip(row[srcCol]);
        const targetText = strip(row[tgtCol]);
        if (!sourceText || !targetText) continue;

        items.push({
          rowIndex,
          sourceText: clipForQaResponse(sourceText),
          targetText: clipForQaResponse(targetText),
        });

        if (items.length >= limit) {
          i += 1;
          break;
        }
      }

      toJson(res, 200, {
        ok: true,
        sheet: cache.sheetName,
        category: categoryKey || "ALL",
        sourceLang: v.sourceLang,
        targetLang: v.targetLang,
        limit,
        count: items.length,
        cursor: String(start),
        cursorNext: i < cache.entries.length ? String(i) : null,
        items,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  // ✅ NON-CONSEQUENTIAL
  app.post("/run-apply", async (req, res) => {
    try {
      await handleApply(req, res);
    } catch (e) {
      handleErr(res, e);
    }
  });

  // ✅ ORIGINAL WRITE ENDPOINT
  app.post("/v1/glossary/apply", async (req, res) => {
    try {
      await handleApply(req, res);
    } catch (e) {
      handleErr(res, e);
    }
  });
}
