// src/glossary/load.mjs
// - Load glossary sheet into normalized entries
// - Auto-detect language columns

import { DEFAULT_SHEET_NAME, buildSheetRange } from "../config/env.mjs";
import { readSheetRange } from "../google/sheets.mjs";
import { normalizeHeader, nowIso } from "../utils/common.mjs";

function normCategoryFallback(sheetName) {
  return String(sheetName ?? "").trim().toLowerCase() || "default";
}

export async function loadGlossaryAll(opts = {}) {
  const sheetName = String(opts.sheetName ?? "").trim() || DEFAULT_SHEET_NAME;
  const range = buildSheetRange(sheetName);

  const { header, rows } = await readSheetRange(range);
  const loadedAt = nowIso();

  if (!header.length) {
    return {
      loadedAt,
      sheetName,
      range,
      header: [],
      rawRows: [],
      entries: [],
      rawRowCount: 0,
      langIndex: {},
      idx: { key: -1, category: -1 },
    };
  }

  const norm = header.map(normalizeHeader);

  // key / category column
  const idxKey = norm.indexOf("key") >= 0 ? norm.indexOf("key") : norm.indexOf("id");
  const idxCategory =
    norm.indexOf("분류") >= 0 ? norm.indexOf("분류") : norm.indexOf("category");

  // non-language headers
  const excluded = new Set([
    "key",
    "id",
    "분류",
    "category",
    "term",
    "len",
    "length",
    "note",
    "notes",
    "번역메모",
    "클리펀트",
    "우선순위",
    "priority",
    "src_lang",
    "match_type",
  ]);

  // language columns
  const langIndex = {};
  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    if (!h || excluded.has(h)) continue;
    langIndex[h] = i;
  }

  // ko-KR is mandatory anchor language
  if (langIndex["ko-kr"] == null) {
    throw new Error(`Sheet '${sheetName}' must include 'ko-KR' language column.`);
  }

  const fallbackCategory = normCategoryFallback(sheetName);

  const entries = rows.map((r, i) => {
    const rowIndex = i + 2;

    const key =
      idxKey >= 0 ? String(r[idxKey] ?? "").trim() : `row:${rowIndex}`;

    const category =
      idxCategory >= 0
        ? String(r[idxCategory] ?? "").trim() || fallbackCategory
        : fallbackCategory;

    const translations = {};
    for (const [lang, colIdx] of Object.entries(langIndex)) {
      const v = String(r[colIdx] ?? "").trim();
      if (v) translations[lang] = v;
    }

    return {
      _rowIndex: rowIndex,
      key,
      category,
      translations,
    };
  });

  return {
    loadedAt,
    sheetName,
    range,
    header,
    rawRows: rows,
    entries,
    rawRowCount: rows.length,
    langIndex,
    idx: { key: idxKey, category: idxCategory },
  };
}
