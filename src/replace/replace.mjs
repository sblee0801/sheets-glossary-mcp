/**
 * src/replace/replace.mjs
 * - Phase 1: Glossary 치환 + 상세 로그
 * - Phase 1.5: Rules 매칭 로그(치환/생성 없음)
 *
 * ✅ Performance upgrades (backward compatible):
 * 1) Add "compiled replace plan" to avoid per-request:
 *    - sorting terms
 *    - creating RegExp objects
 *    - scanning sourceTextMap to pick targets
 * 2) Add fast replace helper (no logs) for bulk processing
 * 3) Rule logs: support precompiled rule regex/pattern if provided in rulesCache entries
 *
 * 원칙:
 * - 기존 API와 호환 유지 (replaceByGlossaryWithLogs 시그니처 유지)
 * - 호출자가 compileReplacePlan() 결과를 넘기면 성능 크게 개선
 */

import { escapeRegExp } from "../utils/common.mjs";

// ---------------- Replace Plan Compilation ----------------

/**
 * Compile a replace plan for a given (sourceTextMap, targetLangKey).
 * - Picks the first available translation per term (existing policy)
 * - Sorts terms by length desc (existing policy)
 * - Pre-builds RegExp objects once
 *
 * @param {object} params
 * @param {string} params.targetLangKey
 * @param {Map<string, Array>} params.sourceTextMap Map<sourceText, entry[]>
 * @returns {{ targetLangKey: string, items: Array<{term:string, re:RegExp, target:string, chosen:{key?:string,rowIndex?:number}}>, termCount:number }}
 */
export function compileReplacePlan({ targetLangKey, sourceTextMap }) {
  const tlk = String(targetLangKey ?? "").trim().toLowerCase();
  if (!tlk) {
    return { targetLangKey: "", items: [], termCount: 0 };
  }

  if (!sourceTextMap || typeof sourceTextMap.get !== "function") {
    return { targetLangKey: tlk, items: [], termCount: 0 };
  }

  // 1) Collect terms
  const terms = Array.from(sourceTextMap.keys())
    .map((s) => String(s ?? "").trim())
    .filter(Boolean);

  // 2) Sort by length desc (same as previous behavior)
  terms.sort((a, b) => b.length - a.length);

  const items = [];

  for (const term of terms) {
    const candidates = sourceTextMap.get(term) || [];

    let chosen = null;
    let target = "";

    // existing rule: pick first candidate that has targetLang translation
    for (const c of candidates) {
      const v = c?.translations?.[tlk];
      if (v && String(v).trim()) {
        chosen = c;
        target = String(v).trim();
        break;
      }
    }
    if (!chosen || !target) continue;

    // Prebuild regex once
    const re = new RegExp(escapeRegExp(term), "g");

    items.push({
      term,
      re,
      target,
      chosen: {
        key: chosen.key || undefined,
        rowIndex: chosen._rowIndex,
      },
    });
  }

  return {
    targetLangKey: tlk,
    items,
    termCount: terms.length,
  };
}

/**
 * Fast replace with a compiled plan (no logs, no counts).
 * Best for high-throughput usage.
 *
 * @param {object} params
 * @param {string} params.text
 * @param {{items:Array<{re:RegExp,target:string}>}} params.plan
 */
export function replaceByGlossaryFast({ text, plan }) {
  if (typeof text !== "string") text = String(text ?? "");
  if (!text) return "";

  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (items.length === 0) return text;

  let out = text;
  for (const it of items) {
    out = out.replace(it.re, it.target);
  }
  return out;
}

// ---------------- Replace Logic (Phase 1 + Logs) ----------------

/**
 * Backward compatible function.
 *
 * New optional param:
 * - replacePlan: output of compileReplacePlan()
 *
 * @param {object} params
 * @param {string} params.text
 * @param {string} params.sourceLangKey  ex) "ko-kr" | "en-us"
 * @param {string} params.targetLangKey  ex) "en-us" | "ko-kr" | "de-de" ...
 * @param {Map<string, Array>} params.sourceTextMap Map<sourceText, entry[]>
 * @param {object} [params.replacePlan] compiled plan
 */
export function replaceByGlossaryWithLogs({
  text,
  sourceLangKey,
  targetLangKey,
  sourceTextMap,
  replacePlan,
}) {
  if (typeof text !== "string") text = String(text ?? "");
  if (!text) return { out: "", replacedTotal: 0, logs: [] };

  const tlk = String(targetLangKey ?? "").trim().toLowerCase();
  if (!tlk) return { out: text, replacedTotal: 0, logs: [] };

  // Use compiled plan if provided (fast path)
  let plan = replacePlan;
  if (!plan || !Array.isArray(plan.items) || plan.targetLangKey !== tlk) {
    plan = compileReplacePlan({ targetLangKey: tlk, sourceTextMap });
  }

  const items = plan.items || [];
  if (items.length === 0) return { out: text, replacedTotal: 0, logs: [] };

  let out = text;
  let replacedTotal = 0;
  const logs = [];

  for (const it of items) {
    const re = it.re;
    const target = it.target;

    let localCount = 0;

    // Replace + count
    out = out.replace(re, () => {
      localCount += 1;
      return target;
    });

    if (localCount > 0) {
      replacedTotal += localCount;
      logs.push({
        sourceLang: sourceLangKey,
        targetLang: tlk,
        from: it.term,
        to: target,
        count: localCount,
        chosen: {
          key: it?.chosen?.key,
          rowIndex: it?.chosen?.rowIndex,
        },
      });
    }
  }

  return { out, replacedTotal, logs };
}

// ---------------- Phase 1.5 Rule Match + Logs ----------------
function tokenizePatternToRegex(pattern) {
  const escaped = escapeRegExp(pattern);
  return escaped
    .replace(/\\\{N\\\}/g, "(\\d+)")
    .replace(/\\\{X\\\}/g, "(\\d+)")
    .replace(/\\\{T\\\}/g, "(\\d+)")
    .replace(/\\\{V\\\}/g, "([^\\r\\n]+)");
}

function ruleMatchesText(ruleKo, matchType, text, compiledRe) {
  const ko = String(ruleKo ?? "").trim();
  if (!ko) return false;

  const mt = String(matchType ?? "").trim().toLowerCase();

  // ✅ If precompiled regex is provided, use it (performance)
  if (compiledRe && compiledRe instanceof RegExp) {
    try {
      return compiledRe.test(text);
    } catch {
      return false;
    }
  }

  if (!mt || mt === "exact") {
    return text.includes(ko);
  }

  if (mt === "regex") {
    try {
      const re = new RegExp(ko, "m");
      return re.test(text);
    } catch {
      return false;
    }
  }

  if (mt === "pattern") {
    try {
      const reSrc = tokenizePatternToRegex(ko);
      const re = new RegExp(reSrc, "m");
      return re.test(text);
    } catch {
      return false;
    }
  }

  return text.includes(ko);
}

/**
 * Rules는 현재 category=item만 적용(기존 정책 유지)
 * - 치환 없음, "매칭 로그"만 생성
 *
 * ✅ Perf: if rulesCache entries include `_compiledRe`, it will be used.
 *
 * @param {object} params
 * @param {string} params.text Phase1 결과 텍스트
 * @param {string} params.categoryKey lower
 * @param {string} params.targetLangKey
 * @param {object} params.rulesCache ensureRulesLoaded() 결과
 */
export function buildRuleLogs({ text, categoryKey, targetLangKey, rulesCache }) {
  const out = [];
  if (!text) return out;
  if (categoryKey !== "item") return out;

  const rules = rulesCache?.itemEntries ?? [];
  if (!rules.length) return out;

  for (const r of rules) {
    const from = String(r.translations?.["ko-kr"] ?? "").trim();
    if (!from) continue;

    const compiledRe = r?._compiledRe instanceof RegExp ? r._compiledRe : null;

    const matched = ruleMatchesText(from, r.matchType, text, compiledRe);
    if (!matched) continue;

    const to = String(r.translations?.[String(targetLangKey ?? "").toLowerCase()] ?? "").trim();

    out.push({
      ruleKey: r.key || `row:${r._rowIndex}`,
      from,
      to: to || "",
    });
  }

  // dedupe
  const uniq = [];
  const seen = new Set();
  for (const x of out) {
    const k = `${x.ruleKey}@@${x.from}@@${x.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(x);
  }
  return uniq;
}
