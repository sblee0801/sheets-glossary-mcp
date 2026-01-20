/**
 * src/replace/replace.mjs
 * - Phase 1: Glossary 치환 + 상세 로그
 * - Phase 1.5: Rules 매칭 로그(치환/생성 없음)
 *
 * 원칙:
 * - 순수 함수 모음(캐시/IO 접근 금지)
 */

import { escapeRegExp } from "../utils/common.mjs";

// ---------------- Replace Logic (Phase 1 + Logs) ----------------
/**
 * @param {object} params
 * @param {string} params.text
 * @param {string} params.sourceLangKey  ex) "ko-kr" | "en-us"
 * @param {string} params.targetLangKey  ex) "en-us" | "ko-kr" | "de-de" ...
 * @param {Map<string, Array>} params.sourceTextMap Map<sourceText, entry[]>
 */
export function replaceByGlossaryWithLogs({ text, sourceLangKey, targetLangKey, sourceTextMap }) {
  if (typeof text !== "string") text = String(text ?? "");
  if (!text) return { out: "", replacedTotal: 0, logs: [] };

  const terms = Array.from(sourceTextMap.keys()).sort((a, b) => b.length - a.length);

  let out = text;
  let replacedTotal = 0;
  const logs = [];

  for (const term of terms) {
    const candidates = sourceTextMap.get(term) || [];

    let chosen = null;
    let target = "";
    for (const c of candidates) {
      const v = c?.translations?.[targetLangKey];
      if (v && String(v).trim()) {
        chosen = c;
        target = String(v).trim();
        break;
      }
    }
    if (!chosen || !target) continue;

    const re = new RegExp(escapeRegExp(term), "g");
    let localCount = 0;
    out = out.replace(re, () => {
      localCount += 1;
      return target;
    });

    if (localCount > 0) {
      replacedTotal += localCount;
      logs.push({
        sourceLang: sourceLangKey,
        targetLang: targetLangKey,
        from: term,
        to: target,
        count: localCount,
        chosen: {
          key: chosen.key || undefined,
          rowIndex: chosen._rowIndex,
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

function ruleMatchesText(ruleKo, matchType, text) {
  const ko = String(ruleKo ?? "").trim();
  if (!ko) return false;

  const mt = String(matchType ?? "").trim().toLowerCase();

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

    const matched = ruleMatchesText(from, r.matchType, text);
    if (!matched) continue;

    const to = String(r.translations?.[targetLangKey] ?? "").trim();

    out.push({
      ruleKey: r.key || `row:${r._rowIndex}`,
      from,
      to: to || "",
    });
  }

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
