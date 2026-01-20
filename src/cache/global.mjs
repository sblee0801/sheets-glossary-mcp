/**
 * src/cache/global.mjs
 * - 프로세스 전역 캐시(Glossary / Rules)
 * - 강제 리로드 지원
 * - server.mjs(REST/MCP)가 공통으로 사용
 *
 * 의도:
 * - server.mjs의 줄 수를 줄이기 위해, "캐시 관리"를 별도 모듈로 분리한다.
 * - 실제 로딩 로직은 glossary/load.mjs, rules/load.mjs로 위임한다.
 */

import { loadGlossaryAll } from "../glossary/load.mjs";
import { buildIndexBySourcePreserveDuplicates } from "../glossary/index.mjs";
import { loadRulesAll } from "../rules/load.mjs";

let _glossaryCache = null;
let _rulesCache = null;

function nowIso() {
  return new Date().toISOString();
}

function freezeShallow(obj) {
  return Object.freeze(obj);
}

/**
 * Glossary 캐시 로드/갱신
 * @param {object} opts
 * @param {boolean} [opts.forceReload=false]
 */
export async function ensureGlossaryLoaded(opts = {}) {
  const forceReload = Boolean(opts.forceReload);

  if (_glossaryCache && !forceReload) return _glossaryCache;

  const loaded = await loadGlossaryAll();

  const byCategoryBySource = buildIndexBySourcePreserveDuplicates(
    loaded.entries,
    ["ko-kr", "en-us"]
  );

  _glossaryCache = freezeShallow({
    loadedAt: loaded.loadedAt || nowIso(),
    header: loaded.header,
    rawRows: loaded.rawRows,
    entries: loaded.entries,
    rawRowCount: loaded.rawRowCount,
    langIndex: loaded.langIndex,
    byCategoryBySource,
    idx: loaded.idx,
  });

  return _glossaryCache;
}

/**
 * Rules 캐시 로드/갱신
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
  _glossaryCache = null;
  _rulesCache = null;
}

/**
 * 상태 확인(health/diagnostics 용)
 */
export function getGlobalCacheStatus() {
  return {
    glossary: _glossaryCache
      ? {
          loadedAt: _glossaryCache.loadedAt,
          rawRowCount: _glossaryCache.rawRowCount,
          categoriesCount: _glossaryCache.byCategoryBySource?.size ?? 0,
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
