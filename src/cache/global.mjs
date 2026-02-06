// src/cache/global.mjs (PATCHED)
// - ensureGlossaryLoaded builds byCategoryBySource index

import { loadGlossaryAll } from "../glossary/load.mjs";
import { buildIndexBySourcePreserveDuplicates, mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { compileReplacePlan } from "../replace/replace.mjs";

// ... (나머지 동일)

export async function ensureGlossaryLoaded(opts = {}) {
  const forceReload = Boolean(opts.forceReload);
  const sheetNameRaw = String(opts.sheetName ?? "").trim() || "Glossary";
  const sheetKey = normKeyPart(sheetNameRaw);

  const hit = _glossaryCacheBySheet.get(sheetKey);
  if (hit && !forceReload) return hit;

  const loaded = await loadGlossaryAll({ ...opts, sheetName: sheetNameRaw });

  // ✅ build category/source index here
  const byCategoryBySource = buildIndexBySourcePreserveDuplicates(
    loaded.entries,
    ["ko-kr", "en-us", "th-th"]
  );

  const cache = freezeShallow({
    sheetName: loaded.sheetName || sheetNameRaw,
    loadedAt: loaded.loadedAt || nowIso(),
    header: loaded.header,
    rawRows: loaded.rawRows,
    entries: loaded.entries,
    rawRowCount: loaded.rawRowCount,
    langIndex: loaded.langIndex,
    byCategoryBySource,
    idx: loaded.idx,
  });

  _glossaryCacheBySheet.set(sheetKey, cache);
  _replacePlanCache.clear();
  return cache;
}
