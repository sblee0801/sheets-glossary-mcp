// src/glossary/index.mjs
// - Build indexes for replace/search
// - Preserve duplicates: Map -> entry[]

function normCategory(cat) {
  return String(cat ?? "").trim().toLowerCase();
}

/**
 * Map<categoryLower, Map<sourceLangKey, Map<sourceText, entry[]>>>
 */
export function buildIndexBySourcePreserveDuplicates(entries, sourceLangKeys = ["ko-kr", "en-us"]) {
  const byCategoryBySource = new Map();

  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    const cat = normCategory(e?.category);
    if (!cat) continue;

    let bySource = byCategoryBySource.get(cat);
    if (!bySource) {
      bySource = new Map();
      byCategoryBySource.set(cat, bySource);
    }

    for (const src of sourceLangKeys) {
      const sourceText = String(e?.translations?.[src] ?? "").trim();
      if (!sourceText) continue;

      let textMap = bySource.get(src);
      if (!textMap) {
        textMap = new Map();
        bySource.set(src, textMap);
      }

      if (!textMap.has(sourceText)) textMap.set(sourceText, []);
      textMap.get(sourceText).push(e);
    }
  }

  return byCategoryBySource;
}

/**
 * Merge multiple categories into one sourceTextMap
 * Map<sourceText, entry[]>
 */
export function mergeSourceTextMapsFromCache(cache, sourceLangKey, categories) {
  const merged = new Map();
  const cats = Array.isArray(categories) ? categories : [];

  for (const cat of cats) {
    const bySource = cache.byCategoryBySource?.get?.(cat);
    const map = bySource?.get?.(sourceLangKey);
    if (!map) continue;

    for (const [term, entries] of map.entries()) {
      if (!merged.has(term)) merged.set(term, []);
      merged.get(term).push(...entries);
    }
  }

  return merged;
}
