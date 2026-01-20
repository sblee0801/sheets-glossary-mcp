/**
 * src/glossary/load.mjs
 * - Glossary 시트를 로드해서 entries 구조로 변환
 * - "언어 컬럼 인덱스(langIndex)"를 자동 구성
 *
 * 정책:
 * - TERM(V열)은 무시하고 A:U 범위를 읽는 전제를 유지 (SHEET_RANGE로 제어)
 * - KEY(A열), 분류(I열)는 필수
 */

import { SHEET_RANGE } from "../config/env.mjs";
import { readSheetRange } from "../google/sheets.mjs";
import { normalizeHeader, nowIso } from "../utils/common.mjs";

export async function loadGlossaryAll() {
  const { header, rows } = await readSheetRange(SHEET_RANGE);
  const loadedAt = nowIso();

  if (!header.length) {
    return {
      loadedAt,
      header: [],
      rawRows: [],
      entries: [],
      rawRowCount: 0,
      langIndex: {},
      idx: {},
    };
  }

  const norm = header.map(normalizeHeader);

  const idxKey = norm.indexOf("key");
  const idxCategory = norm.indexOf("분류"); // 확정 구조

  if (idxKey < 0) {
    throw new Error("헤더에 KEY가 없습니다. A열 헤더가 'KEY'인지 확인하세요.");
  }
  if (idxCategory < 0) {
    throw new Error("헤더에 분류가 없습니다. I열 헤더가 '분류'인지 확인하세요.");
  }

  // 언어 컬럼으로 보지 않을 헤더들
  const excluded = new Set([
    "key",
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

  if (langIndex["ko-kr"] == null) {
    throw new Error("헤더에 ko-KR이 없습니다. 언어 컬럼 헤더가 'ko-KR'인지 확인하세요.");
  }

  const entries = rows.map((r, rowIdx) => {
    const key = String(r[idxKey] ?? "").trim();
    const category = String(r[idxCategory] ?? "").trim();

    const translations = {};
    for (const [langKey, colIdx] of Object.entries(langIndex)) {
      const v = String(r[colIdx] ?? "").trim();
      if (v) translations[langKey] = v;
    }

    return {
      _rowIndex: rowIdx + 2, // sheet row index (1-based + header)
      key,
      category,
      translations,
    };
  });

  return {
    loadedAt,
    header,
    rawRows: rows,
    entries,
    rawRowCount: rows.length,
    langIndex,
    idx: { key: idxKey, category: idxCategory },
  };
}
