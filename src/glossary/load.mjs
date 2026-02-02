// src/glossary/load.mjs
// - Glossary-like 시트를 로드해서 entries 구조로 변환
// - "언어 컬럼 인덱스(langIndex)"를 자동 구성

import { DEFAULT_SHEET_NAME, buildSheetRange } from "../config/env.mjs";
import { readSheetRange } from "../google/sheets.mjs";
import { normalizeHeader, nowIso } from "../utils/common.mjs";

function normSheetCategory(sheetName) {
  return String(sheetName ?? "").trim().toLowerCase();
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

  // ✅ key 컬럼: "key" 우선, 없으면 "id" 사용, 둘 다 없으면 -1 허용
  const idxKey = norm.indexOf("key") >= 0 ? norm.indexOf("key") : norm.indexOf("id");

  // ✅ category 컬럼: "분류" 또는 "category" 사용, 없으면 -1 허용 (Trans형)
  const idxCategory =
    norm.indexOf("분류") >= 0 ? norm.indexOf("분류") : norm.indexOf("category");

  // 언어 컬럼으로 보지 않을 헤더들
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

  // langIndex: { "ko-kr": <colIdx>, "en-us": <colIdx>, ... }
  const langIndex = {};
  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    if (!h) continue;
    if (excluded.has(h)) continue;
    langIndex[h] = i;
  }

  // 최소 요구: ko-KR 존재
  if (langIndex["ko-kr"] == null) {
    throw new Error(
      `Sheet '${sheetName}' header must include 'ko-KR' (language column header must be 'ko-KR').`
    );
  }

  const fallbackCategory = normSheetCategory(sheetName) || "default";

  const entries = rows.map((r, rowIdx) => {
    const rowIndex = rowIdx + 2; // sheet row index (1-based + header)

    const key =
      idxKey >= 0 ? String(r[idxKey] ?? "").trim() : `row:${rowIndex}`;

    const category =
      idxCategory >= 0
        ? String(r[idxCategory] ?? "").trim() || fallbackCategory
        : fallbackCategory;

    const translations = {};
    for (const [langKey, colIdx] of Object.entries(langIndex)) {
      const v = String(r[colIdx] ?? "").trim();
      if (v) translations[langKey] = v;
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
