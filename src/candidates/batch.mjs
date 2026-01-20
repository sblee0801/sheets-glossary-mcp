/**
 * src/candidates/batch.mjs
 * - Production policy: Divine Pride ONLY
 * - Divine search priority:
 *   1) Search by ko-KR (resolved from glossary by en-US anchor)
 *   2) Fallback search by en-US for langs still missing candidates
 * - If candidate text is identical to en-US sourceText => treated as "no useful candidate"
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
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width
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
 * Try to resolve ko-KR from en-US anchor, robustly.
 * Priority:
 *  1) exact match within given categoryKey
 *  2) normalized match within given categoryKey
 *  3) normalized match across ALL categories
 */
async function resolveKoFromEnAnchorRobust({ categoryKey, enUsText }) {
  const cache = await ensureGlossaryLoaded({ forceReload: false });

  const wanted = String(enUsText ?? "").trim();
  if (!wanted) return { ko: null, reason: "empty-en-us" };

  const wantedNorm = normalizeForCompare(wanted);
  const catsAll = Array.from(cache.byCategoryBySource?.keys?.() ?? []);
  const catsToTry =
    categoryKey && cache.byCategoryBySource?.has?.(categoryKey) ? [categoryKey] : catsAll;

  // helper: pick ko from entry list
  const pickKo = (entries) => {
    if (!Array.isArray(entries)) return null;
    for (const e of entries) {
      const ko = String(e?.translations?.["ko-kr"] ?? "").trim();
      if (ko) return ko;
    }
    return null;
  };

  // 1) exact in category
  if (catsToTry.length > 0) {
    const cat = catsToTry[0];
    const bySource = cache.byCategoryBySource?.get(cat);
    const enMap = bySource?.get("en-us");
    if (enMap) {
      const exactEntries = enMap.get(wanted);
      const ko = pickKo(exactEntries);
      if (ko) return { ko, reason: `exact:${cat}` };
    }
  }

  // 2) normalized in category
  if (catsToTry.length > 0) {
    const cat = catsToTry[0];
    const bySource = cache.byCategoryBySource?.get(cat);
    const enMap = bySource?.get("en-us");
    if (enMap) {
      for (const [k, entries] of enMap.entries()) {
        if (normalizeForCompare(k) !== wantedNorm) continue;
        const ko = pickKo(entries);
        if (ko) return { ko, reason: `norm:${cat}` };
      }
    }
  }

  // 3) normalized across ALL categories
  for (const cat of catsAll) {
    const bySource = cache.byCategoryBySource?.get(cat);
    const enMap = bySource?.get("en-us");
    if (!enMap) continue;

    // try exact first (fast)
    const exactEntries = enMap.get(wanted);
    const koExact = pickKo(exactEntries);
    if (koExact) return { ko: koExact, reason: `exact:ALL->${cat}` };

    // then normalized scan
    for (const [k, entries] of enMap.entries()) {
      if (normalizeForCompare(k) !== wantedNorm) continue;
      const ko = pickKo(entries);
      if (ko) return { ko, reason: `norm:ALL->${cat}` };
    }
  }

  return { ko: null, reason: "not-found-or-ko-empty" };
}

async function collectDp({ queryText, targetLangKeys, maxN }) {
  const dp = await collectDivinePrideCandidates({
    sourceText: queryText,
    targetLangKeys,
    maxCandidatesPerLang: maxN,
  });

  const out = {};
  for (const lk of targetLangKeys) {
    const got = Array.isArray(dp?.candidatesByLang?.[lk]) ? dp.candidatesByLang[lk] : [];
    const mapped = got.map(mapDpCandidateToBatchCandidate).filter(Boolean);
    out[lk] = mapped;
  }

  return {
    candidatesByLang: out,
    errors: Array.isArray(dp?.errors) ? dp.errors : [],
  };
}

export async function runCandidatesBatch({
  category,
  sourceLang,
  sourceTexts,
  targetLangs,
  sources,
  maxCandidatesPerLang,
  includeEvidence,
}) {
  const startedAt = nowIso();

  const categoryKey = String(category ?? "").trim().toLowerCase();
  const sourceLangKey = normalizeLang(sourceLang || "en-US");


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

  for (const enSourceText of inputs) {
    const candidatesByLang = {};
    const fallbackNeededByLang = {};
    const errors = [];
    const debug = {
      queryUsed: { primary: null, secondary: null },
      resolveKo: { ok: false, reason: null },
    };

    for (const lk of normalizedTargets) {
      candidatesByLang[lk] = [];
      fallbackNeededByLang[lk] = true;
    }

    // 1) Resolve ko-KR query from en-US anchor (robust)
    let koQuery = null;
    try {
      const r = await resolveKoFromEnAnchorRobust({ categoryKey, enUsText: enSourceText });
      debug.resolveKo.reason = r.reason;
      if (r.ko) {
        koQuery = r.ko;
        debug.resolveKo.ok = true;
        debug.queryUsed.primary = { lang: "ko-KR", text: koQuery };
      }
    } catch (e) {
      errors.push({
        source: "glossaryCache",
        lang: "ko-kr",
        stage: "resolve",
        message: String(e?.message ?? e),
        retryable: false,
      });
      debug.resolveKo.reason = "exception";
    }

    // 2) Primary Divine search (ko-KR) if available
    let primaryByLang = {};
    if (koQuery) {
      try {
        const dp1 = await collectDp({
          queryText: koQuery,
          targetLangKeys: normalizedTargets,
          maxN,
        });

        if (dp1.errors.length) {
          for (const msg of dp1.errors) {
            errors.push({
              source: "divinePride",
              lang: null,
              stage: "collect(primary:ko-kr)",
              message: String(msg),
              retryable: false,
            });
          }
        }

        primaryByLang = dp1.candidatesByLang;
      } catch (e) {
        errors.push({
          source: "divinePride",
          lang: null,
          stage: "collect(primary:ko-kr)",
          message: String(e?.message ?? e),
          retryable: false,
        });
      }
    }

    // 3) Apply same-as-source policy to primary
    const sourceLooksEnglish = isLikelyEnglish(enSourceText);

    for (const lk of normalizedTargets) {
      const mapped = Array.isArray(primaryByLang?.[lk]) ? primaryByLang[lk] : [];
      const stripped = stripEvidenceIfNeeded(mapped, withEvidence);
      let filtered = filterSameAsSourceCandidates({
        sourceText: enSourceText,
        targetLangKey: lk,
        candidates: stripped,
      });

      if (sourceLooksEnglish) {
        filtered = filtered.filter((c) => {
          const t = String(c?.text ?? "").trim();
          if (!t) return false;
          if (isLikelyEnglish(t) && isSameAsSource(enSourceText, t)) return false;
          return true;
        });
      }

      const uniq = dedupeCandidates(filtered, maxN);
      candidatesByLang[lk].push(...uniq);
    }

    // 4) Secondary Divine search (en-US) only for langs still missing candidates
    const missingLangs = normalizedTargets.filter((lk) => (candidatesByLang[lk] || []).length === 0);
    debug.queryUsed.secondary = missingLangs.length > 0 ? { lang: "en-US", text: enSourceText } : null;

    if (missingLangs.length > 0) {
      try {
        const dp2 = await collectDp({
          queryText: enSourceText,
          targetLangKeys: missingLangs,
          maxN,
        });

        if (dp2.errors.length) {
          for (const msg of dp2.errors) {
            errors.push({
              source: "divinePride",
              lang: null,
              stage: "collect(secondary:en-us)",
              message: String(msg),
              retryable: false,
            });
          }
        }

        for (const lk of missingLangs) {
          const mapped = Array.isArray(dp2.candidatesByLang?.[lk]) ? dp2.candidatesByLang[lk] : [];
          const stripped = stripEvidenceIfNeeded(mapped, withEvidence);

          let filtered = filterSameAsSourceCandidates({
            sourceText: enSourceText,
            targetLangKey: lk,
            candidates: stripped,
          });

          if (sourceLooksEnglish) {
            filtered = filtered.filter((c) => {
              const t = String(c?.text ?? "").trim();
              if (!t) return false;
              if (isLikelyEnglish(t) && isSameAsSource(enSourceText, t)) return false;
              return true;
            });
          }

          const merged = dedupeCandidates([...(candidatesByLang[lk] || []), ...filtered], maxN);
          candidatesByLang[lk] = merged;
        }
      } catch (e) {
        errors.push({
          source: "divinePride",
          lang: null,
          stage: "collect(secondary:en-us)",
          message: String(e?.message ?? e),
          retryable: false,
        });
      }
    }

    // 5) Final fallbackNeededByLang
    for (const lk of normalizedTargets) {
      const uniq = dedupeCandidates(candidatesByLang[lk], maxN);
      candidatesByLang[lk] = uniq;
      fallbackNeededByLang[lk] = uniq.length === 0;
    }

    results.push({
      sourceText: enSourceText,
      candidatesByLang,
      fallbackNeededByLang,
      errors,
      debug,
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
      "Divine Pride only. Search priority: ko-KR (resolved from glossary by en-US anchor) first, then en-US fallback for languages still missing candidates.",
      "Identical-to-source candidates (compared against en-US anchor) are treated as no useful candidate.",
    ],
    warnings: [],
  };
}
