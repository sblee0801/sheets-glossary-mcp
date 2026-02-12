// src/glossary/index.mjs
// - Build indexes for replace/search
// - Preserve duplicates: Map -> entry[]
// ✅ Fix: glossary term에도 invisible 문자 정규화 적용
// ✅ Fix: 빈 category 방어(default)

function stripInvisible(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ") // NBSP
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "") // ZW + BOM
    .trim();
}

function normCategory(cat) {
  const c = String(cat ?? "").trim().toLowerCase();
  return c || "default";
}

/**
 * Map<categoryLower, Map<sourceLangKey, Map<sourceText, entry[]>>>
 */
export function buildIndexBySourcePreserveDuplicates(entries, sourceLangKeys = ["ko-kr", "en-us"]) {
  const byCategoryBySource = new Map();

  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    const cat = normCategory(e?.category);

    let bySource = byCategoryBySource.get(cat);
    if (!bySource) {
      bySource = new Map();
      byCategoryBySource.set(cat, bySource);
    }

    for (const src of sourceLangKeys) {
      const sourceText = stripInvisible(e?.translations?.[src]);
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

  const slk = String(sourceLangKey ?? "").trim().toLowerCase();

  for (const catRaw of cats) {
    const cat = String(catRaw ?? "").trim().toLowerCase();
    const bySource = cache.byCategoryBySource?.get?.(cat);
    const map = bySource?.get?.(slk);
    if (!map) continue;

    for (const [term, entries] of map.entries()) {
      if (!merged.has(term)) merged.set(term, []);
      merged.get(term).push(...entries);
    }
  }

  return merged;
}
