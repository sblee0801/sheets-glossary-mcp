/**
 * src/cache/global.mjs
 * - 프로세스 전역 캐시(Glossary / Rules)
 * - Glossary는 sheetName별 캐시로 확장
 * - 강제 리로드 지원
 *
 * 의도:
 * - "시트 선택형 Glossary" 지원 (Glossary + Trans1~5)
 */

import { DEFAULT_SHEET_NAME } from "../config/env.mjs";
import { loadGlossaryAll } from "../glossary/load.mjs";
import { buildIndexBySourcePreserveDuplicates } from "../glossary/index.mjs";
import { loadRulesAll } from "../rules/load.mjs";

const _glossaryCaches = new Map(); // Map<sheetName, cache>
let _rulesCache = null;

function nowIso() {
  return new Date().toISOString();
}

function freezeShallow(obj) {
  return Object.freeze(obj);
}

function normSheetName(sheetName) {
  return String(sheetName ?? "").trim() || DEFAULT_SHEET_NAME;
}

/**
 * Glossary 캐시 로드/갱신 (sheetName별)
 * @param {object} opts
 * @param {string} [opts.sheetName]
 * @param {boolean} [opts.forceReload=false]
 */
export async function ensureGlossaryLoaded(opts = {}) {
  const sheetName = normSheetName(opts.sheetName);
  const forceReload = Boolean(opts.forceReload);

  const existing = _glossaryCaches.get(sheetName);
  if (existing && !forceReload) return existing;

  const loaded = await loadGlossaryAll({ sheetName });

  const byCategoryBySource = buildIndexBySourcePreserveDuplicates(
    loaded.entries,
    ["ko-kr", "en-us"]
  );

  const cache = freezeShallow({
    loadedAt: loaded.loadedAt || nowIso(),
    sheetName: loaded.sheetName,
    range: loaded.range,
    header: loaded.header,
    rawRows: loaded.rawRows,
    entries: loaded.entries,
    rawRowCount: loaded.rawRowCount,
    langIndex: loaded.langIndex,
    byCategoryBySource,
    idx: loaded.idx,
  });

  _glossaryCaches.set(sheetName, cache);
  return cache;
}

/**
 * Rules 캐시 로드/갱신 (기존 그대로)
 * @param {object} opts
 * @param {boolean} [opts.forceReload=false]
 */
export async function ensureRulesLoaded(opts = {}) {
  const forceReload = Boolean(opts.forceReload);

  if (_rulesCache && !forceReload) return _rulesCache;

  const loaded = await loadRulesAll();

  const itemEntries = loaded.entries.filter((e) => {
    if (String(e.category ?? "").trim().toLowerCase() !== "item") return false;
    const ko = String(e.translations?.["ko-kr"] ?? "").trim();
    return Boolean(ko);
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

/**
 * 캐시 강제 초기화(디버깅/테스트 용)
 */
export function resetGlobalCaches() {
  _glossaryCaches.clear();
  _rulesCache = null;
}

/**
 * 상태 확인(health/diagnostics 용)
 */
export function getGlobalCacheStatus() {
  const glossarySheets = [];
  for (const [sheetName, cache] of _glossaryCaches.entries()) {
    glossarySheets.push({
      sheetName,
      loadedAt: cache.loadedAt,
      rawRowCount: cache.rawRowCount,
      categoriesCount: cache.byCategoryBySource?.size ?? 0,
    });
  }

  return {
    glossary: glossarySheets.length ? glossarySheets : null,
    rules: _rulesCache
      ? {
          loadedAt: _rulesCache.loadedAt,
          rawRowCount: _rulesCache.rawRowCount,
          itemRulesCount: _rulesCache.itemEntries?.length ?? 0,
        }
      : null,
  };
}
