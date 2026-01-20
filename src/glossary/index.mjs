/**
 * src/glossary/index.mjs
 * - Glossary entries로부터 치환/검색을 위한 인덱스를 생성
 * - 중복 sourceText(동일 ko/en)가 있을 수 있으므로 entry[]를 보존한다.
 */

function normCategory(cat) {
  return String(cat ?? "").trim().toLowerCase();
}

/**
 * Map<categoryLower, Map<sourceLangKey, Map<sourceText, entry[]>>>
 *
 * @param {Array} entries glossary entries
 * @param {string[]} sourceLangKeys ex) ["ko-kr","en-us"]
 */
export function buildIndexBySourcePreserveDuplicates(entries, sourceLangKeys = ["ko-kr", "en-us"]) {
  const byCategoryBySource = new Map();

  for (const e of entries) {
    const cat = normCategory(e.category);
    if (!cat) continue;

    if (!byCategoryBySource.has(cat)) byCategoryBySource.set(cat, new Map());
    const bySource = byCategoryBySource.get(cat);

    for (const src of sourceLangKeys) {
      const sourceText = String(e.translations?.[src] ?? "").trim();
      if (!sourceText) continue;

      if (!bySource.has(src)) bySource.set(src, new Map());
      const textMap = bySource.get(src);

      if (!textMap.has(sourceText)) textMap.set(sourceText, []);
      textMap.get(sourceText).push(e);
    }
  }

  return byCategoryBySource;
}

/**
 * category가 없을 때: 여러 카테고리의 sourceTextMap을 하나로 머지
 * Map<sourceText, entry[]>
 *
 * @param {object} cache ensureGlossaryLoaded()가 반환한 cache
 * @param {string} sourceLangKey "ko-kr" | "en-us"
 * @param {string[]} categories categoryKey(lower) 목록
 */
export function mergeSourceTextMapsFromCache(cache, sourceLangKey, categories) {
  const merged = new Map();

  for (const cat of categories) {
    const bySource = cache.byCategoryBySource.get(cat);
    const map = bySource?.get(sourceLangKey);
    if (!map) continue;

    for (const [term, entries] of map.entries()) {
      if (!merged.has(term)) merged.set(term, []);
      merged.get(term).push(...entries);
    }
  }

  return merged;
}
