/**
 * src/candidates/batch.mjs
 * - Production policy: Divine Pride ONLY
 * - Supports sourceLang: en-US or ko-KR
 *   - If sourceLang=en-US: server tries ko-KR (resolved from glossary) first, then en-US fallback
 *   - If sourceLang=ko-KR: server tries ko-KR first, then en-US fallback (resolved from glossary)
 * - If candidate text is identical to "anchor text for compare" => treated as "no useful candidate"
 */

import { normalizeLang, nowIso, isLikelyEnglish } from "../utils/common.mjs";
import { collectDivinePrideCandidates } from "../glossary/divinePride.mjs";
import { ensureGlossaryLoaded } from "../cache/global.mjs";

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

function filterSameAsSourceCandidates({ compareAnchorText, targetLangKey, candidates }) {
  if (targetLangKey === "en-us") return candidates; // safety
  const out = [];
  for (const c of candidates || []) {
    const t = String(c?.text ?? "").trim();
    if (!t) continue;
    if (isSameAsSource(compareAnchorText, t)) continue;
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

function getCategoriesToSearch(cache, categoryKey) {
  if (categoryKey && String(categoryKey).trim()) {
    const ck = String(categoryKey).trim().toLowerCase();
    if (cache.byCategoryBySource.has(ck)) return [ck];
    // category unknown -> treat as ALL (do not fail hard)
  }
  return Array.from(cache.byCategoryBySource.keys());
}

function resolveKoFromEn({ cache, categories, enText }) {
  const en = String(enText ?? "").trim();
  if (!en) return { ok: false, reason: "en-empty" };

  for (const cat of categories) {
    const bySource = cache.byCategoryBySource.get(cat);
    const enMap = bySource?.get("en-us");
    const hits = enMap?.get(en);
    if (!hits || hits.length === 0) continue;

    for (const e of hits) {
      const ko = String(e?.translations?.["ko-kr"] ?? "").trim();
      if (ko) return { ok: true, text: ko, reason: `exact:${cat}` };
    }
  }

  return { ok: false, reason: "not-found-or-ko-empty" };
}

function resolveEnFromKo({ cache, categories, koText }) {
  const ko = String(koText ?? "").trim();
  if (!ko) return { ok: false, reason: "ko-empty" };

  for (const cat of categories) {
    const bySource = cache.byCategoryBySource.get(cat);
    const koMap = bySource?.get("ko-kr");
    const hits = koMap?.get(ko);
    if (!hits || hits.length === 0) continue;

    for (const e of hits) {
      const en = String(e?.translations?.["en-us"] ?? "").trim();
      if (en) return { ok: true, text: en, reason: `exact:${cat}` };
    }
  }

  return { ok: false, reason: "not-found-or-en-empty" };
}

async function collectDpOnce({ queryText, targetLangKeys, maxN }) {
  const dp = await collectDivinePrideCandidates({
    sourceText: queryText,
    targetLangKeys,
    maxCandidatesPerLang: maxN,
  });

  return dp;
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

  const categoryKey = String(category ?? "").trim().toLowerCase() || null;
  const sourceLangKey = normalizeLang(sourceLang || "en-US");

  // ✅ allow en-US or ko-KR
  if (sourceLangKey !== "en-us" && sourceLangKey !== "ko-kr") {
    const err = new Error("candidates/batch sourceLang must be en-US or ko-KR.");
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

  // load glossary cache for ko<->en resolution
  const cache = await ensureGlossaryLoaded({ forceReload: false });
  const categories = getCategoriesToSearch(cache, categoryKey);

  const results = [];

  for (const inputText of inputs) {
    const candidatesByLang = {};
    const fallbackNeededByLang = {};
    const errors = [];

    for (const lk of normalizedTargets) {
      candidatesByLang[lk] = [];
      fallbackNeededByLang[lk] = true;
    }

    // Decide primary/secondary query terms based on sourceLang
    let primary = null;
    let secondary = null;

    // For "same-as-source" filtering, prefer comparing against en-US anchor if resolvable.
    let compareAnchorText = inputText;

    if (sourceLangKey === "en-us") {
      // input is en anchor
      const koResolved = resolveKoFromEn({ cache, categories, enText: inputText });
      if (koResolved.ok) primary = { lang: "ko-KR", text: koResolved.text };
      secondary = { lang: "en-US", text: inputText };
      compareAnchorText = inputText;

      // Attach debug later
    } else {
      // sourceLangKey === "ko-kr"
      primary = { lang: "ko-KR", text: inputText };
      const enResolved = resolveEnFromKo({ cache, categories, koText: inputText });
      if (enResolved.ok) secondary = { lang: "en-US", text: enResolved.text };
      compareAnchorText = enResolved.ok ? enResolved.text : inputText;
    }

    // Collect with primary (if present)
    if (primary?.text) {
      try {
        const dp1 = await collectDpOnce({
          queryText: primary.text,
          targetLangKeys: normalizedTargets,
          maxN,
        });

        if (Array.isArray(dp1?.errors) && dp1.errors.length) {
          for (const msg of dp1.errors) {
            errors.push({
              source: "divinePride",
              lang: null,
              stage: "collect-primary",
              message: String(msg),
              retryable: false,
            });
          }
        }

        for (const lk of normalizedTargets) {
          const got = Array.isArray(dp1?.candidatesByLang?.[lk]) ? dp1.candidatesByLang[lk] : [];
          const mapped = got.map(mapDpCandidateToBatchCandidate).filter(Boolean);
          const stripped = stripEvidenceIfNeeded(mapped, withEvidence);
          const uniq = dedupeCandidates(stripped, maxN);
          candidatesByLang[lk].push(...uniq);
        }
      } catch (e) {
        errors.push({
          source: "divinePride",
          lang: null,
          stage: "collect-primary",
          message: String(e?.message ?? e),
          retryable: false,
        });
      }
    }

    // Determine which langs still need fallback after primary
    const needFallbackLangs = [];
    for (const lk of normalizedTargets) {
      const uniq = dedupeCandidates(candidatesByLang[lk], maxN);
      candidatesByLang[lk] = uniq;
      if (uniq.length === 0) needFallbackLangs.push(lk);
    }

    // Collect with secondary only for missing langs
    if (secondary?.text && needFallbackLangs.length > 0) {
      try {
        const dp2 = await collectDpOnce({
          queryText: secondary.text,
          targetLangKeys: needFallbackLangs,
          maxN,
        });

        if (Array.isArray(dp2?.errors) && dp2.errors.length) {
          for (const msg of dp2.errors) {
            errors.push({
              source: "divinePride",
              lang: null,
              stage: "collect-secondary",
              message: String(msg),
              retryable: false,
            });
          }
        }

        for (const lk of needFallbackLangs) {
          const got = Array.isArray(dp2?.candidatesByLang?.[lk]) ? dp2.candidatesByLang[lk] : [];
          const mapped = got.map(mapDpCandidateToBatchCandidate).filter(Boolean);
          const stripped = stripEvidenceIfNeeded(mapped, withEvidence);
          const uniq = dedupeCandidates(stripped, maxN);
          candidatesByLang[lk].push(...uniq);
        }
      } catch (e) {
        errors.push({
          source: "divinePride",
          lang: null,
          stage: "collect-secondary",
          message: String(e?.message ?? e),
          retryable: false,
        });
      }
    }

    // Apply same-as-source policy vs compareAnchorText (prefer en-US anchor if available)
    const anchorLooksEnglish = isLikelyEnglish(compareAnchorText);

    for (const lk of normalizedTargets) {
      let filtered = filterSameAsSourceCandidates({
        compareAnchorText,
        targetLangKey: lk,
        candidates: candidatesByLang[lk],
      });

      // safety: if anchor looks English, drop English candidates identical to anchor
      if (anchorLooksEnglish) {
        filtered = filtered.filter((c) => {
          const t = String(c?.text ?? "").trim();
          if (!t) return false;
          if (isLikelyEnglish(t) && isSameAsSource(compareAnchorText, t)) return false;
          return true;
        });
      }

      const uniq = dedupeCandidates(filtered, maxN);
      candidatesByLang[lk] = uniq;
      fallbackNeededByLang[lk] = uniq.length === 0;
    }

    // Build debug payload
    let resolveKo = null;
    let resolveEn = null;

    if (sourceLangKey === "en-us") {
      const koResolved = resolveKoFromEn({ cache, categories, enText: inputText });
      resolveKo = { ok: koResolved.ok, reason: koResolved.reason };
    } else {
      const enResolved = resolveEnFromKo({ cache, categories, koText: inputText });
      resolveEn = { ok: enResolved.ok, reason: enResolved.reason };
    }

    results.push({
      sourceText: inputText,
      candidatesByLang,
      fallbackNeededByLang,
      errors,
      debug: {
        queryUsed: {
          primary: primary?.text ? primary : null,
          secondary: secondary?.text ? secondary : null,
        },
        resolveKo,
        resolveEn,
        compareAnchorText,
      },
    });
  }

  const completedAt = nowIso();

  return {
    ok: true,
    category: categoryKey || "ALL",
    sourceLang: sourceLangKey === "ko-kr" ? "ko-KR" : "en-US",
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
      "Divine Pride only. Search priority: ko-KR first when available; fallback to en-US when needed.",
      "Identical-to-source candidates (compared against compareAnchorText) are treated as no useful candidate.",
    ],
    warnings: [],
  };
}
