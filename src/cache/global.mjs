// src/cache/global.mjs
import { loadGlossaryAll } from "../glossary/load.mjs";
import { buildIndexBySourcePreserveDuplicates, mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { loadRulesAll } from "../rules/load.mjs";
import { compileReplacePlan } from "../replace/replace.mjs";
import { escapeRegExp } from "../utils/common.mjs";

let _rulesCache = null;

// ✅ CHANGE: sheetName별 glossary cache
// key: normalized sheetName(lower/trim) -> cache object
const _glossaryCacheBySheet = new Map();

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
export function getReplacePlanFromCache({ cache, sheetName, sourceLangKey, categories, targetLangKey }) {
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
 * Get compiled mask regex plan (avoid per-text RegExp creation).
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

  const key = `mrp@@${sheet}@@${loadedAt}@@${slk}@@${catsKey}@@cs=${cs ? 1 : 0}@@wb=${wb ? 1 : 0}`;

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
      // ignore invalid regex construction
    }
  }

  _maskRegexPlanCache.set(key, plan);
  _bumpCacheSize(_maskRegexPlanCache);

  return plan;
}

/** ---------------- Glossary cache (sheet-scoped) ---------------- **/

export async function ensureGlossaryLoaded(opts = {}) {
  const forceReload = Boolean(opts.forceReload);

  const sheetNameRaw = String(opts.sheetName ?? "").trim() || "Glossary";
  const sheetKey = _normKeyPart(sheetNameRaw);

  const hit = _glossaryCacheBySheet.get(sheetKey);
  if (hit && !forceReload) return hit;

  // Always pass sheetName through so loadGlossaryAll reads the intended sheet
  const loaded = await loadGlossaryAll({ ...opts, sheetName: sheetNameRaw });

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

  // ✅ Easiest safe invalidation: clear derived caches (keys include loadedAt anyway)
  // (If you want, we can optimize later to clear only keys for this sheet.)
  _replacePlanCache.clear();
  _maskAnchorsCache.clear();
  _maskRegexPlanCache.clear();

  return cache;
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

  try {
    if (!mt || mt === "exact") entry._compiledRe = new RegExp(`^${escapeRegExp(ko)}$`, "m");
    else if (mt === "contains") entry._compiledRe = new RegExp(escapeRegExp(ko), "m");
    else if (mt === "word") entry._compiledRe = new RegExp(`\\b${escapeRegExp(ko)}\\b`, "m");
    else if (mt === "regex") entry._compiledRe = new RegExp(ko, "m");
    else if (mt === "pattern") entry._compiledRe = new RegExp(tokenizePatternToRegex(ko), "m");
  } catch {
    // ignore invalid regex compile
  }

  return entry;
}

export async function ensureRulesLoaded(opts = {}) {
  const forceReload = Boolean(opts.forceReload);
  if (_rulesCache && !forceReload) return _rulesCache;

  const loaded = await loadRulesAll();

  // 기존 호환 유지: entries 전체를 들고 있고, 필요한 곳에서 category별로 선택
  const entries = Array.isArray(loaded.entries) ? loaded.entries.map(precompileRule) : [];

  _rulesCache = freezeShallow({
    loadedAt: loaded.loadedAt || nowIso(),
    header: loaded.header,
    rawRows: loaded.rawRows,
    entries,
    rawRowCount: loaded.rawRowCount,
    langIndex: loaded.langIndex,
  });

  return _rulesCache;
}
