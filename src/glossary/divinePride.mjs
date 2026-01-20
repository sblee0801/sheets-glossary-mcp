// src/glossary/divinePride.mjs
// Divine Pride candidate collector (improved disambiguation)
//
// Strategy:
// 1) Resolve itemId by scraping DP database search result page (HTML)
//    - extract href + anchor text
//    - score candidates to avoid [Event]/Costume/Box variants when input is plain
// 2) Fetch localized item name via DP API using Accept-Language header
//
// Requirements (env):
// - DIVINE_PRIDE_API_KEY (required for API calls)
// - DIVINE_PRIDE_SERVER (optional, default: "iRO")
// - DIVINE_PRIDE_BASE_URL (optional, default: "https://www.divine-pride.net")

const DEFAULT_BASE_URL = "https://www.divine-pride.net";

function normLang(langKey) {
  return String(langKey ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function safeText(s) {
  return String(s ?? "").trim();
}

function normalizeForCompare(s) {
  return safeText(s)
    .toLowerCase()
    .replace(/[\[\]\(\)\{\}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toSlugLike(s) {
  // "Red Potion" -> "red-potion"
  return safeText(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildEvidence({ sourceText, itemId, url, server, langKey, name }) {
  return {
    source: "divinePride",
    sourceText,
    match: { itemId, server, lang: langKey },
    url,
    value: { name },
  };
}

/**
 * Extract item links from HTML including anchor text:
 * <a href="/database/item/501/red-potion">Red Potion</a>
 */
function extractItemAnchorsFromHtml(html) {
  const out = [];
  const s = String(html ?? "");
  if (!s) return out;

  // Capture href and anchor inner text (non-greedy)
  // href="/database/item/501/red-potion" ...> ... </a>
  const re = /<a\b[^>]*href="(\/database\/item\/(\d+)(?:\/[^"]*)?)"[^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  while ((m = re.exec(s)) !== null) {
    const href = m[1];
    const id = Number(m[2]);
    if (!Number.isFinite(id)) continue;

    // strip tags inside anchor text (DP may include spans/icons)
    const rawInner = String(m[3] ?? "");
    const inner = rawInner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    out.push({ href, id, text: inner });
  }
  return out;
}

function containsVariantKeyword(s) {
  const t = normalizeForCompare(s);

  // High-frequency “variant” markers we want to avoid when input is plain.
  // Keep this conservative; we are only *ranking* candidates, not hard-filtering.
  const bad = [
    "event",
    "costume",
    "box",
    "scroll",
    "card",
    "shadow",
    "enchant",
    "rune",
    "rental",
    "sealed",
    "fragment",
    "voucher",
    "ticket",
    "package",
    "bundle",
    "random",
    "choice",
    "special",
  ];

  for (const w of bad) {
    if (t.includes(w)) return true;
  }
  return false;
}

function scoreCandidate({ sourceText, href, anchorText }) {
  const inputRaw = safeText(sourceText);
  const inputNorm = normalizeForCompare(inputRaw);
  const inputSlug = toSlugLike(inputRaw);

  const hrefLower = String(href ?? "").toLowerCase();
  const anchorNorm = normalizeForCompare(anchorText);

  let score = 0;

  // 1) Exact / near-exact name match (strong)
  if (anchorNorm === inputNorm) score += 100;
  else if (anchorNorm.includes(inputNorm) && inputNorm.length >= 4) score += 40;
  else if (inputNorm.includes(anchorNorm) && anchorNorm.length >= 4) score += 20;

  // 2) Slug match in href (strong)
  // e.g., /database/item/501/red-potion
  if (inputSlug && hrefLower.includes(`/${inputSlug}`)) score += 80;
  else if (inputSlug && hrefLower.includes(inputSlug)) score += 30;

  // 3) Penalize variant markers in anchor text
  if (containsVariantKeyword(anchorText)) score -= 60;

  // 4) Penalize bracketed prefixes like "[Event]" or "[Costume]" etc.
  if (/^\s*\[[^\]]+\]\s*/.test(String(anchorText ?? ""))) score -= 40;

  // 5) Prefer shorter href path (heuristic: fewer slashes after /database/item/<id>)
  // "/database/item/501/red-potion" better than "/database/item/501/some/extra"
  const afterId = hrefLower.replace(/.*\/database\/item\/\d+\/?/, "");
  const slashCount = (afterId.match(/\//g) || []).length;
  score += Math.max(0, 10 - slashCount * 5);

  // 6) Small bonus if anchor text starts with input (common for exact items)
  if (anchorNorm.startsWith(inputNorm) && inputNorm.length >= 4) score += 10;

  return score;
}

/**
 * Resolve itemId by querying DP search page, then scoring candidates.
 *
 * Search URL:
 *   /database/item?find=Search&name=<term>
 *
 * We fail gracefully; the caller will leave fallbackNeeded=true.
 */
async function resolveItemIdByName({ baseUrl, sourceText, timeoutMs = 8000 }) {
  const name = safeText(sourceText);
  if (!name) return { ok: false, itemId: null, reason: "empty sourceText" };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL("/database/item", baseUrl);
    url.searchParams.set("find", "Search");
    url.searchParams.set("name", name);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Accept-Language": "en-US",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, itemId: null, reason: `search http ${res.status}` };
    }

    const html = await res.text();
    const links = extractItemAnchorsFromHtml(html);

    if (!links.length) {
      return { ok: false, itemId: null, reason: "no item links in search HTML" };
    }

    // Score and pick best
    let best = null;
    let bestScore = -Infinity;

    for (const x of links) {
      const sc = scoreCandidate({
        sourceText: name,
        href: x.href,
        anchorText: x.text,
      });

      if (sc > bestScore) {
        bestScore = sc;
        best = { ...x, score: sc };
      }
    }

    if (!best) {
      return { ok: false, itemId: null, reason: "no best candidate after scoring" };
    }

    // If the best score is extremely low, it might be noise; still return (better than nothing),
    // but include reason so upstream can observe.
    return {
      ok: true,
      itemId: best.id,
      reason: `resolved via scoring (score=${best.score})`,
      debug: { href: best.href, text: best.text, score: best.score },
    };
  } catch (e) {
    return {
      ok: false,
      itemId: null,
      reason: e?.name === "AbortError" ? "search timeout" : String(e?.message ?? e),
    };
  } finally {
    clearTimeout(t);
  }
}

async function fetchItemLocalizedName({ baseUrl, apiKey, server, itemId, langKey, timeoutMs = 8000 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(`/api/database/Item/${itemId}`, baseUrl);
    url.searchParams.set("apiKey", apiKey);
    if (server) url.searchParams.set("server", server);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        // DP API supports language selection via Accept-Language
        "Accept-Language": langKey,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, name: "", reason: `api http ${res.status}` };
    }

    const json = await res.json();
    const name = safeText(json?.name);
    if (!name) {
      return { ok: false, name: "", reason: "api returned empty name" };
    }

    return { ok: true, name, reason: "ok" };
  } catch (e) {
    return {
      ok: false,
      name: "",
      reason: e?.name === "AbortError" ? "api timeout" : String(e?.message ?? e),
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Main collector export
 * @param {Object} args
 * @param {string} args.sourceText - en-US anchor name
 * @param {string[]} args.targetLangKeys - normalized keys like ["ko-kr","de-de"]
 * @param {number} args.maxCandidatesPerLang - typically 1~2
 * @returns {Promise<{ candidatesByLang: Object, fallbackNeededByLang: Object, errors: string[] }>}
 */
export async function collectDivinePrideCandidates({
  sourceText,
  targetLangKeys,
  maxCandidatesPerLang = 2,
}) {
  const baseUrl = process.env.DIVINE_PRIDE_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = process.env.DIVINE_PRIDE_API_KEY || "";
  const server = process.env.DIVINE_PRIDE_SERVER || "iRO";

  const candidatesByLang = {};
  const fallbackNeededByLang = {};
  const errors = [];

  for (const lk of targetLangKeys) {
    const k = normLang(lk);
    candidatesByLang[k] = [];
    fallbackNeededByLang[k] = true;
  }

  if (!apiKey) {
    errors.push("DIVINE_PRIDE_API_KEY is missing (Divine Pride API requires an API key).");
    return { candidatesByLang, fallbackNeededByLang, errors };
  }

  const resolved = await resolveItemIdByName({ baseUrl, sourceText });

  if (!resolved.ok || !resolved.itemId) {
    errors.push(`DivinePride: failed to resolve itemId for '${sourceText}' (${resolved.reason})`);
    return { candidatesByLang, fallbackNeededByLang, errors };
  }

  const itemId = resolved.itemId;

  // For each target language, call API with Accept-Language
  for (const rawLang of targetLangKeys) {
    const langKey = normLang(rawLang);
    if (!langKey) continue;

    const r = await fetchItemLocalizedName({ baseUrl, apiKey, server, itemId, langKey });
    if (!r.ok || !r.name) {
      // keep fallbackNeeded=true
      continue;
    }

    const url = `${baseUrl}/database/item/${itemId}`;
    const evidence = buildEvidence({
      sourceText,
      itemId,
      url,
      server,
      langKey,
      name: r.name,
    });

    candidatesByLang[langKey].push({
      text: r.name,
      confidence: "high",
      evidence: [evidence],
      meta: {
        resolver: {
          reason: resolved.reason,
          debug: resolved.debug,
        },
      },
    });

    candidatesByLang[langKey] = candidatesByLang[langKey].slice(
      0,
      Math.max(1, Number(maxCandidatesPerLang) || 2)
    );
    fallbackNeededByLang[langKey] = candidatesByLang[langKey].length === 0;
  }

  return { candidatesByLang, fallbackNeededByLang, errors };
}
