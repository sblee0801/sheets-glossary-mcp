// src/replace/replace.mjs
// - Phase 1: Glossary 치환 + 상세 로그
// ✅ Fix: 치환 결과를 << >> 로 마스킹 처리
// ✅ Fix: replacePlan / plan 둘 다 지원 (호환)

import { escapeRegExp } from "../utils/common.mjs";

// ---------------- Replace Plan Compilation ----------------

/**
 * Compile a replace plan for a given (sourceTextMap, targetLangKey).
 * - Picks the first available translation per term
 * - Sorts terms by length desc
 * - Pre-builds RegExp objects once
 *
 * @param {object} params
 * @param {string} params.targetLangKey
 * @param {Map<string, Array>} params.sourceTextMap Map<sourceText, entry[]>
 * @returns {{ targetLangKey: string, items: Array<{term:string, re:RegExp, target:string, chosen:{key?:string,rowIndex?:number}}>, termCount:number }}
 */
export function compileReplacePlan({ targetLangKey, sourceTextMap }) {
  const tlk = String(targetLangKey ?? "").trim().toLowerCase();
  if (!tlk) return { targetLangKey: "", items: [], termCount: 0 };

  if (!sourceTextMap || typeof sourceTextMap.get !== "function") {
    return { targetLangKey: tlk, items: [], termCount: 0 };
  }

  const terms = Array.from(sourceTextMap.keys())
    .map((s) => String(s ?? "").trim())
    .filter(Boolean);

  // longest-first
  terms.sort((a, b) => b.length - a.length);

  const items = [];

  for (const term of terms) {
    const candidates = sourceTextMap.get(term) || [];

    let chosen = null;
    let target = "";

    for (const c of candidates) {
      const v = c?.translations?.[tlk];
      if (v && String(v).trim()) {
        chosen = c;
        target = String(v).trim();
        break;
      }
    }
    if (!chosen || !target) continue;

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

  return { targetLangKey: tlk, items, termCount: terms.length };
}

/**
 * Fast replace with a compiled plan (no logs, no counts).
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
  for (const it of items) out = out.replace(it.re, it.target);
  return out;
}

// ---------------- Replace Logic (Phase 1 + Logs) ----------------

/**
 * Backward compatible function.
 * - replacePlan: compiled plan (preferred)
 * - plan: alias for backward/other call sites (supported)
 */
export function replaceByGlossaryWithLogs({
  text,
  sourceLangKey,
  targetLangKey,
  sourceTextMap,
  replacePlan,
  plan, // ✅ alias 지원
}) {
  if (typeof text !== "string") text = String(text ?? "");
  if (!text) return { out: "", replacedTotal: 0, logs: [] };

  const tlk = String(targetLangKey ?? "").trim().toLowerCase();
  if (!tlk) return { out: text, replacedTotal: 0, logs: [] };

  // ✅ compiled plan preference: replacePlan > plan
  let usedPlan = replacePlan || plan;
  if (!usedPlan || !Array.isArray(usedPlan.items) || usedPlan.targetLangKey !== tlk) {
    usedPlan = compileReplacePlan({ targetLangKey: tlk, sourceTextMap });
  }

  const items = usedPlan.items || [];
  if (items.length === 0) return { out: text, replacedTotal: 0, logs: [] };

  let out = text;
  let replacedTotal = 0;
  const logs = [];

  for (const it of items) {
    const re = it.re;
    const target = it.target;

    let localCount = 0;

    out = out.replace(re, () => {
      localCount += 1;
      // ✅ 핵심: 용어 치환은 << >> 마스킹
      return `<<${target}>>`;
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
