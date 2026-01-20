/**
 * src/rules/load.mjs
 * - Rules 시트를 로드해서 entries 구조로 변환
 * - match_type / priority / note 포함
 *
 * 주의:
 * - itemEntries 필터링은 cache/global.mjs에서 수행한다.
 */

import { RULE_SHEET_RANGE } from "../config/env.mjs";
import { readSheetRange } from "../google/sheets.mjs";
import { normalizeHeader, nowIso } from "../utils/common.mjs";

export async function loadRulesAll() {
  const { header, rows } = await readSheetRange(RULE_SHEET_RANGE);
  const loadedAt = nowIso();

  if (!header.length) {
    return { loadedAt, header: [], rawRows: [], entries: [], rawRowCount: 0, langIndex: {} };
  }

  const norm = header.map(normalizeHeader);

  const idxKey = norm.indexOf("key");
  const idxCategory = norm.indexOf("분류");
  const idxMatchType = norm.indexOf("match_type");
  const idxPriority = norm.indexOf("priority");
  const idxNote = norm.indexOf("note");

  if (idxKey < 0) throw new Error("Rules 시트 헤더에 KEY가 없습니다.");
  if (idxCategory < 0) throw new Error("Rules 시트 헤더에 분류가 없습니다.");

  const excluded = new Set([
    "key",
    "분류",
    "category",
    "term",
    "note",
    "notes",
    "priority",
    "match_type",
  ]);

  const langIndex = {};
  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    if (!h) continue;
    if (excluded.has(h)) continue;
    langIndex[h] = i;
  }

  if (langIndex["ko-kr"] == null) {
    throw new Error("Rules 시트 헤더에 ko-KR이 없습니다. 언어 컬럼 헤더가 'ko-KR'인지 확인하세요.");
  }

  const entries = rows.map((r, rowIdx) => {
    const key = String(r[idxKey] ?? "").trim();
    const category = String(r[idxCategory] ?? "").trim().toLowerCase();

    const translations = {};
    for (const [langKey, colIdx] of Object.entries(langIndex)) {
      const v = String(r[colIdx] ?? "").trim();
      if (v) translations[langKey] = v;
    }

    const matchType = idxMatchType >= 0 ? String(r[idxMatchType] ?? "").trim().toLowerCase() : "";
    const priority = idxPriority >= 0 ? Number(String(r[idxPriority] ?? "").trim() || "0") : 0;
    const note = idxNote >= 0 ? String(r[idxNote] ?? "").trim() : "";

    return {
      _rowIndex: rowIdx + 2,
      key,
      category,
      translations,
      matchType,
      priority,
      note,
    };
  });

  return {
    loadedAt,
    header,
    rawRows: rows,
    entries,
    rawRowCount: rows.length,
    langIndex,
  };
}
