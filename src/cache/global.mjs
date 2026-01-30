/**
 * src/cache/global.mjs
 * - 프로세스 전역 캐시(Glossary / Rules)
 * - 강제 리로드 지원
 *
 * ✅ Perf upgrades:
 * 1) Replace plan cache (compiled RegExp + target strings)
 * 2) Mask anchors cache (sorted anchors)
 * 3) Mask regex plan cache (compiled RegExp per term, per 옵션 조합)
 * 4) Rules precompile: attach _compiledRe to rule entries
 */

import { loadGlossaryAll } from "../glossary/load.mjs";
import { buildIndexBySourcePreserveDuplicates, mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { loadRulesAll } from "../rules/load.mjs";
import { compileReplacePlan } from "../replace/replace.mjs";
import { escapeRegExp } from "../utils/common.mjs";

let _glossaryCache = null;
let _rulesCache = null;

function nowIso() {
  return new Date().toISOString();
}

function freezeShallow(obj) {
  return Object.freeze(obj);
}

/** ---------------- Replace/Mask derived caches ---------------- **/

// key -> compiled replace plan
const _replacePlanCache = new Map();

// key -> sorted anchors (string[])
const _maskAnchorsCache = new Map();

// key -> compiled mask regex plan [{ term, re }]
const _maskRegexPlanCache = new Map();

// Soft limit to prevent unbounded memory growth (simple LRU-ish)
const MAX_DERIVED_CACHE_KEYS = Number(process.env.MAX_DERIVED_CACHE_KEYS ?? 200);

function _bumpCacheSize(m) {
  if (m.size <= MAX_DERIVED_CACHE_KEYS) return;
  const it = m.keys().next();
  if (!it.done) m.delete(it.value);
}

function _normKeyPart(s) {
  return String(s ?? "").trim().toLowerCase();
}

function _makeCategoriesKey(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return "ALL";
  return categories.map(_normKeyPart).sort().join(",");
}

/**
 * Build/return compiled replace plan from glossary cache.
 */
export function getReplacePlanFromCache({
  cache,
  sheetName,
  sourceLangKey,
  categories,
  targetLangKey,
}) {
  const loadedAt = String(cache?.loadedAt ?? "");
  const sheet = String(sheetName ?? cache?.sheetName ?? "Glossary").trim() || "Glossary";

  const slk = _normKeyPart(sourceLangKey);
  const tlk = _normKeyPart(targetLangKey);
  const catsKey = _makeCategoriesKey(categories);

  const key = `rp@@${sheet}@@${loadedAt}@@${slk}@@${catsKey}@@${tlk}`;

  const hit = _replacePlanCache.get(key);
  if (hit) return hit;

  const sourceTextMap = mergeSourceTextMapsFromCache(cache, slk, categories);
  const plan = compileReplacePlan({ targetLangKey: tlk, sourceTextMap });

  _replacePlanCache.set(key, plan);
  _bumpCacheSize(_replacePlanCache);

  return plan;
}

/**
 * Get sorted anchors for mask (based on sourceTextMap keys).
 */
export function getMaskAnchorsFromCache({ cache, sheetName, sourceLangKey, categories }) {
  const loadedAt = String(cache?.loadedAt ?? "");
  const sheet = String(sheetName ?? cache?.sheetName ?? "Glossary").trim() || "Glossary";

  const slk = _normKeyPart(sourceLangKey);
  const catsKey = _makeCategoriesKey(categories);

  const key = `ma@@${sheet}@@${loadedAt}@@${slk}@@${catsKey}`;

  const hit = _maskAnchorsCache.get(key);
  if (hit) return hit;

  const sourceTextMap = mergeSourceTextMapsFromCache(cache, slk, categories);

  const anchors = Array.from(sourceTextMap.keys())
    .map((s) => String(s ?? "").trim())
    .filter(Boolean);

  anchors.sort((a, b) => b.length - a.length);

  _maskAnchorsCache.set(key, anchors);
  _bumpCacheSize(_maskAnchorsCache);

  return anchors;
}

/**
 * ✅ NEW: Get compiled mask regex plan (avoid per-text RegExp creation).
 *
 * Returns array of:
 *   [{ term, re }]
 *
 * Cache key includes:
 * - sheet, loadedAt, sourceLangKey, categoriesKey
 * - caseSensitive, wordBoundary
 */
export function getMaskRegexPlanFromCache({
  cache,
  sheetName,
  sourceLangKey,
  categories,
  caseSensitive,
  wordBoundary,
}) {
  const loadedAt = String(cache?.loadedAt ?? "");
  const sheet = String(sheetName ?? cache?.sheetName ?? "Glossary").trim() || "Glossary";

  const slk = _normKeyPart(sourceLangKey);
  const catsKey = _makeCategoriesKey(categories);

  const cs = Boolean(caseSensitive);
  const wb = Boolean(wordBoundary);

  const key = `mrp@@${sheet}@@${loadedAt}@@${slk}@@${catsKey}@@cs=${cs ? 1 : 0}@@wb=${
    wb ? 1 : 0
  }`;

  const hit = _maskRegexPlanCache.get(key);
  if (hit) return hit;

  const anchors = getMaskAnchorsFromCache({ cache, sheetName: sheet, sourceLangKey: slk, categories });

  const flags = cs ? "g" : "gi";
  const plan = [];

  for (const t of anchors) {
    if (!t) continue;

    const startsWord = /^[A-Za-z0-9_]/.test(t);
    const endsWord = /[A-Za-z0-9_]$/.test(t);

    let pattern = escapeRegExp(t);
    if (wb && startsWord && endsWord) {
      pattern = `\\b${pattern}\\b`;
    }

    try {
      plan.push({ term: t, re: new RegExp(pattern, flags) });
    } catch {
      // ignore invalid regex construction (should be rare due to escaping)
    }
  }

  _maskRegexPlanCache.set(key, plan);
  _bumpCacheSize(_maskRegexPlanCache);

  return plan;
}

/** ---------------- Glossary cache ---------------- **/

export async function ensureGlossaryLoaded(opts = {}) {
  const forceReload = Boolean(opts.forceReload);

  if (_glossaryCache && !forceReload) return _glossaryCache;

  const loaded = await loadGlossaryAll(opts);

  const byCategoryBySource = buildIndexBySourcePreserveDuplicates(
    loaded.entries,
    ["ko-kr", "en-us"]
  );

  _glossaryCache = freezeShallow({
    sheetName: loaded.sheetName || opts.sheetName || "Glossary",
    loadedAt: loaded.loadedAt || nowIso(),
    header: loaded.header,
    rawRows: loaded.rawRows,
    entries: loaded.entries,
    rawRowCount: loaded.rawRowCount,
    langIndex: loaded.langIndex,
    byCategoryBySource,
    idx: loaded.idx,
  });

  // ✅ Invalidate derived caches on reload
  _replacePlanCache.clear();
  _maskAnchorsCache.clear();
  _maskRegexPlanCache.clear();

  return _glossaryCache;
}

/** ---------------- Rules cache ---------------- **/

function tokenizePatternToRegex(pattern) {
  const escaped = escapeRegExp(pattern);
  return escaped
    .replace(/\\\{N\\\}/g, "(\\d+)")
    .replace(/\\\{X\\\}/g, "(\\d+)")
    .replace(/\\\{T\\\}/g, "(\\d+)")
    .replace(/\\\{V\\\}/g, "([^\\r\\n]+)");
}

function precompileRule(entry) {
  const ko = String(entry?.translations?.["ko-kr"] ?? "").trim();
  if (!ko) return entry;

  const mt = String(entry?.matchType ?? "").trim().toLowerCase();
  if (!mt || mt === "exact") return entry;

  try {
    if (mt === "regex") {
      entry._compiledRe = new RegExp(ko, "m");
      return entry;
    }
    if (mt === "pattern") {
      const src = tokenizePatternToRegex(ko);
      entry._compiledRe = new RegExp(src, "m");
      return entry;
    }
  } catch {
    // ignore; fallback to runtime
  }
  return entry;
}

export async function ensureRulesLoaded(opts = {}) {
  const forceReload = Boolean(opts.forceReload);

  if (_rulesCache && !forceReload) return _rulesCache;

  const loaded = await loadRulesAll(opts);

  const itemEntries = loaded.entries
    .filter((e) => {
      if (String(e.category ?? "").trim().toLowerCase() !== "item") return false;
      const ko = String(e.translations?.["ko-kr"] ?? "").trim();
      return Boolean(ko);
    })
    .map((e) => {
      const x = { ...e };
      return precompileRule(x);
    });

  _rulesCache = freezeShallow({
    loadedAt: loaded.loadedAt || nowIso(),
    header: loaded.header,
    rawRows: loaded.rawRows,
    entries: loaded.entries,
    rawRowCount: loaded.rawRowCount,
    langIndex: loaded.langIndex,
    itemEntries,
  });

  return _rulesCache;
}

export function resetGlobalCaches() {
  _glossaryCache = null;
  _rulesCache = null;
  _replacePlanCache.clear();
  _maskAnchorsCache.clear();
  _maskRegexPlanCache.clear();
}

export function getGlobalCacheStatus() {
  return {
    glossary: _glossaryCache
      ? {
          loadedAt: _glossaryCache.loadedAt,
          rawRowCount: _glossaryCache.rawRowCount,
          categoriesCount: _glossaryCache.byCategoryBySource?.size ?? 0,
          derived: {
            replacePlanKeys: _replacePlanCache.size,
            maskAnchorsKeys: _maskAnchorsCache.size,
            maskRegexPlanKeys: _maskRegexPlanCache.size,
          },
        }
      : null,
    rules: _rulesCache
      ? {
          loadedAt: _rulesCache.loadedAt,
          rawRowCount: _rulesCache.rawRowCount,
          itemRulesCount: _rulesCache.itemEntries?.length ?? 0,
        }
      : null,
  };
}
