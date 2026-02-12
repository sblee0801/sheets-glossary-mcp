// src/cache/global.mjs
// - Sheet-scoped glossary cache
// - Derived caches: replace plan
// - Rules cache: ensureRulesLoaded

import { loadGlossaryAll } from "../glossary/load.mjs";
import { buildIndexBySourcePreserveDuplicates, mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { loadRulesAll } from "../rules/load.mjs";
import { compileReplacePlan } from "../replace/replace.mjs";
import { escapeRegExp } from "../utils/common.mjs";

// ---------------- internal caches ----------------
let _rulesCache = null;

// sheetName(lower/trim) -> glossary cache
const _glossaryCacheBySheet = new Map();

// derived cache: compiled replace plan
const _replacePlanCache = new Map();

// soft limit
const MAX_DERIVED_CACHE_KEYS = Number(process.env.MAX_DERIVED_CACHE_KEYS ?? 200);

function nowIso() {
  return new Date().toISOString();
}

function freezeShallow(obj) {
  return Object.freeze(obj);
}

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

// ---------------- Replace plan ----------------
export function getReplacePlanFromCache({ cache, sheetName, sourceLangKey, categories, targetLangKey }) {
  const loadedAt = String(cache?.loadedAt ?? "");
  const sheet = String(sheetName ?? cache?.sheetName ?? "Glossary").trim() || "Glossary";

  const slk = _normKeyPart(sourceLangKey);
  const tlk = _normKeyPart(targetLangKey);
  const catsKey = _makeCategoriesKey(categories);

  // loadedAt를 키에 포함해서 "글로서리 reload" 이후 plan이 섞이지 않게 함
  const key = `rp@@${sheet}@@${loadedAt}@@${slk}@@${catsKey}@@${tlk}`;

  const hit = _replacePlanCache.get(key);
  if (hit) return hit;

  const sourceTextMap = mergeSourceTextMapsFromCache(cache, slk, categories);
  const plan = compileReplacePlan({ targetLangKey: tlk, sourceTextMap });

  _replacePlanCache.set(key, plan);
  _bumpCacheSize(_replacePlanCache);

  return plan;
}

// ---------------- Glossary cache ----------------
export async function ensureGlossaryLoaded(opts = {}) {
  const forceReload = Boolean(opts.forceReload);

  const sheetNameRaw = String(opts.sheetName ?? "").trim() || "Glossary";
  const sheetKey = _normKeyPart(sheetNameRaw);

  const hit = _glossaryCacheBySheet.get(sheetKey);
  if (hit && !forceReload) return hit;

  const loaded = await loadGlossaryAll({ ...opts, sheetName: sheetNameRaw });

  // ✅ sourceLang keys are ko/en only (th removed)
  // - 여기 인덱스는 "어떤 source 컬럼을 기준으로 치환할지"를 위해 사용됨
  // - v2에서 sourceLang은 en/ko만 허용이므로 ko/en만 만들면 충분
  const byCategoryBySource = buildIndexBySourcePreserveDuplicates(loaded.entries, ["ko-kr", "en-us"]);

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

  // safe invalidation: glossary가 바뀌면 derived cache는 전부 초기화
  _replacePlanCache.clear();

  return cache;
}

// ---------------- Rules cache ----------------
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
