/**
 * src/candidates/batch.mjs
 * - Production policy: Divine Pride ONLY
 * - If candidate text is identical to sourceText => treated as "no useful candidate"
 */

import { normalizeLang, nowIso, isLikelyEnglish } from "../utils/common.mjs";
import { collectDivinePrideCandidates } from "../glossary/divinePride.mjs";

function uniqNonEmptyTrimmed(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const t = String(x ?? "").trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const i = Math.trunc(v);
  return Math.min(max, Math.max(min, i));
}

function dedupeCandidates(cands, maxN) {
  const uniq = [];
  const seen = new Set();

  for (const c of cands || []) {
    const text = String(c?.text ?? "").trim();
    const url = String(c?.url ?? "").trim();
    const src = String(c?.source ?? "").trim();
    if (!text) continue;

    const k = `${text}@@${url}@@${src}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push({
      text,
      source: src || "unknown",
      url,
      evidence: c?.evidence,
      meta: c?.meta,
      confidence: c?.confidence,
    });

    if (uniq.length >= maxN) break;
  }

  return uniq;
}

function stripEvidenceIfNeeded(cands, includeEvidence) {
  if (includeEvidence) return cands;
  return (cands || []).map((c) => {
    if (!c || typeof c !== "object") return c;
    const { evidence, ...rest } = c;
    return rest;
  });
}

function normalizeForCompare(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\[\]\(\)\{\}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSameAsSource(sourceText, candidateText) {
  const a = normalizeForCompare(sourceText);
  const b = normalizeForCompare(candidateText);
  if (!a || !b) return false;
  return a === b;
}

function filterSameAsSourceCandidates({ sourceText, targetLangKey, candidates }) {
  if (targetLangKey === "en-us") return candidates; // safety
  const out = [];
  for (const c of candidates || []) {
    const t = String(c?.text ?? "").trim();
    if (!t) continue;
    if (isSameAsSource(sourceText, t)) continue;
    out.push(c);
  }
  return out;
}

function mapDpCandidateToBatchCandidate(dpCand) {
  const text = String(dpCand?.text ?? "").trim();
  if (!text) return null;

  const ev0 = Array.isArray(dpCand?.evidence) ? dpCand.evidence[0] : null;
  const url = String(ev0?.url ?? "").trim();

  return {
    text,
    source: "divinePride",
    url,
    evidence: dpCand?.evidence,
    meta: dpCand?.meta,
    confidence: dpCand?.confidence,
  };
}

/**
 * Step 2 candidates/batch (Divine Pride only)
 */
export async function runCandidatesBatch({
  category,
  sourceLang,
  sourceTexts,
  targetLangs,
  sources, // ignored or validated at schema level; kept for forward-compat
  maxCandidatesPerLang,
  includeEvidence,
}) {
  const startedAt = nowIso();

  const categoryKey = String(category ?? "").trim().toLowerCase();
  const sourceLangKey = normalizeLang(sourceLang || "en-US");

  if (categoryKey !== "item") {
    const err = new Error("Only category='item' is supported for now.");
    err.status = 400;
    throw err;
  }
  if (sourceLangKey !== "en-us") {
    const err = new Error("sourceLang must be en-US (anchor) for candidates/batch.");
    err.status = 400;
    throw err;
  }

  const normalizedTargets = uniqNonEmptyTrimmed(targetLangs).map(normalizeLang);
  if (normalizedTargets.length === 0) {
    const err = new Error("targetLangs must have at least 1 language.");
    err.status = 400;
    throw err;
  }

  const inputs = uniqNonEmptyTrimmed(sourceTexts);
  if (inputs.length === 0) {
    const err = new Error("sourceTexts must have at least 1 text.");
    err.status = 400;
    throw err;
  }

  const maxN = clampInt(maxCandidatesPerLang, 1, 5, 2);
  const withEvidence = Boolean(includeEvidence);

  const results = [];

  for (const sourceText of inputs) {
    const candidatesByLang = {};
    const fallbackNeededByLang = {};
    const errors = [];

    for (const lk of normalizedTargets) {
      candidatesByLang[lk] = [];
      fallbackNeededByLang[lk] = true;
    }

    // Divine Pride: sourceText 당 1회 호출 -> 언어별 후보 수집
    try {
      const dp = await collectDivinePrideCandidates({
        sourceText,
        targetLangKeys: normalizedTargets,
        maxCandidatesPerLang: maxN,
      });

      if (Array.isArray(dp?.errors) && dp.errors.length) {
        for (const msg of dp.errors) {
          errors.push({
            source: "divinePride",
            lang: null,
            stage: "collect",
            message: String(msg),
            retryable: false,
          });
        }
      }

      for (const lk of normalizedTargets) {
        const got = Array.isArray(dp?.candidatesByLang?.[lk]) ? dp.candidatesByLang[lk] : [];
        const mapped = got.map(mapDpCandidateToBatchCandidate).filter(Boolean);
        const stripped = stripEvidenceIfNeeded(mapped, withEvidence);
        const uniq = dedupeCandidates(stripped, maxN);
        candidatesByLang[lk].push(...uniq);
      }
    } catch (e) {
      errors.push({
        source: "divinePride",
        lang: null,
        stage: "collect",
        message: String(e?.message ?? e),
        retryable: false,
      });
    }

    // same-as-source 정책 적용 -> 제거 후 fallback 재계산
    const sourceLooksEnglish = isLikelyEnglish(sourceText);

    for (const lk of normalizedTargets) {
      let filtered = filterSameAsSourceCandidates({
        sourceText,
        targetLangKey: lk,
        candidates: candidatesByLang[lk],
      });

      // 안전장치(실질 영향 거의 없음): 영어로 보이고 normalize 동일이면 제거
      if (sourceLooksEnglish) {
        filtered = filtered.filter((c) => {
          const t = String(c?.text ?? "").trim();
          if (!t) return false;
          if (isLikelyEnglish(t) && isSameAsSource(sourceText, t)) return false;
          return true;
        });
      }

      const uniq = dedupeCandidates(filtered, maxN);
      candidatesByLang[lk] = uniq;
      fallbackNeededByLang[lk] = uniq.length === 0;
    }

    results.push({
      sourceText,
      candidatesByLang,
      fallbackNeededByLang,
      errors,
    });
  }

  const completedAt = nowIso();

  return {
    ok: true,
    category: categoryKey,
    sourceLang: "en-US",
    targetLangs,
    sourcesUsed: ["divinePride"],
    meta: {
      startedAt,
      completedAt,
      inputCount: inputs.length,
      uniqueInputCount: results.length,
    },
    results,
    notes: [
      "Divine Pride only: candidates are collected from Divine Pride; identical-to-source candidates are treated as no useful candidate.",
    ],
    warnings: [],
  };
}
