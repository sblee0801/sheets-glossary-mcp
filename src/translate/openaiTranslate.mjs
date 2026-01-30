/**
 * src/translate/openaiTranslate.mjs
 * - Server-side Phase 2 translation via OpenAI Responses API
 *
 * Provides:
 *   export async function translateItemsWithGpt41(...)
 */

import {
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_TIMEOUT_MS,
  OPENAI_MAX_RETRIES,
  OPENAI_CHUNK_SIZE,
} from "../config/env.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

function ensureApiKey() {
  if (!OPENAI_API_KEY) throw httpError(500, "OPENAI_API_KEY is missing in env.");
}

function normalizeLangKeyForPrompt(langKey) {
  const k = String(langKey || "").toLowerCase();
  if (k === "en-us") return "English (en-US)";
  if (k === "ko-kr") return "Korean (ko-KR)";
  return String(langKey || "Unknown");
}

/**
 * items: [{ rowIndex:number, text:string }]
 * returns: { results:[{rowIndex, translatedText}], meta:{...} }
 */
export async function translateItemsWithGpt41({
  items,
  sourceLang,
  targetLang,
  mode = "replace", // replace | mask
  chunkSize,
}) {
  ensureApiKey();

  const safeItems = Array.isArray(items) ? items : [];
  if (!safeItems.length) throw httpError(400, "translateItemsWithGpt41: items is empty.");

  const cs = Number(chunkSize || OPENAI_CHUNK_SIZE || 20);
  const chunks = [];
  for (let i = 0; i < safeItems.length; i += cs) chunks.push(safeItems.slice(i, i + cs));

  const startedAt = Date.now();
  const results = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];

    const inputLines = chunk.map((it) => {
      const rowIndex = Number(it?.rowIndex);
      const text = String(it?.text ?? "");
      return `${rowIndex}\t${text}`;
    });

    const sys = [
      "You are a professional game localization translator.",
      "Rules (HARD):",
      "- Preserve all tokens exactly (e.g., {mask:123}, {0}, {1}, %s, <TAG>, [TAG]). Do NOT modify token text.",
      "- Preserve punctuation, numbers, and line structure.",
      "- Translate ONLY natural language parts into the target language.",
      "- Output MUST be TSV lines: <rowIndex>\\t<translatedText>",
      "- Output line count MUST equal input line count.",
      mode === "mask"
        ? "- If {mask:N} appears, keep it unchanged and in the same position."
        : "- Do not invent glossary terms; already-replaced terms must remain unchanged.",
    ].join("\n");

    const user = [
      `Source language: ${normalizeLangKeyForPrompt(sourceLang)}`,
      `Target language: ${normalizeLangKeyForPrompt(targetLang)}`,
      "",
      "Translate the following TSV lines:",
      ...inputLines,
    ].join("\n");

    const outText = await callOpenAIResponses({
      model: OPENAI_MODEL,
      instructions: sys,
      input: user,
      timeoutMs: OPENAI_TIMEOUT_MS,
      maxRetries: OPENAI_MAX_RETRIES,
    });

    const parsed = parseTsvOutput(outText, chunk);
    for (const p of parsed) results.push(p);
  }

  const endedAt = Date.now();

  return {
    results,
    meta: {
      model: OPENAI_MODEL,
      chunks: chunks.length,
      chunkSize: cs,
      elapsedMs: endedAt - startedAt,
      items: safeItems.length,
    },
  };
}

function parseTsvOutput(outputText, chunk) {
  const raw = String(outputText ?? "").trim();
  if (!raw) throw httpError(502, "OpenAI returned empty output.");

  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  // strip accidental code fences
  const cleaned = [];
  for (const ln of lines) {
    if (ln.startsWith("```")) continue;
    cleaned.push(ln);
  }

  if (cleaned.length !== chunk.length) {
    throw httpError(502, `OpenAI output line count mismatch. expected=${chunk.length}, got=${cleaned.length}`, {
      expected: chunk.length,
      got: cleaned.length,
      sample: cleaned.slice(0, 5),
    });
  }

  const results = [];
  for (let i = 0; i < chunk.length; i++) {
    const expectedRow = Number(chunk[i]?.rowIndex);
    const ln = cleaned[i];

    const tabPos = ln.indexOf("\t");
    if (tabPos < 0) throw httpError(502, "OpenAI output must be TSV (<rowIndex>\\t<text>).", { line: ln });

    const rowStr = ln.slice(0, tabPos).trim();
    const text = ln.slice(tabPos + 1);

    const rowIndex = Number(rowStr);
    if (!Number.isFinite(rowIndex) || rowIndex !== expectedRow) {
      throw httpError(502, "OpenAI output rowIndex mismatch.", { expectedRow, gotRow: rowStr, line: ln });
    }

    results.push({ rowIndex, translatedText: String(text ?? "") });
  }

  return results;
}

/**
 * OpenAI Responses API (no SDK)
 */
async function callOpenAIResponses({ model, instructions, input, timeoutMs, maxRetries }) {
  const url = "https://api.openai.com/v1/responses";

  const payload = {
    model,
    instructions,
    input,
  };

  const retries = Number(maxRetries ?? 3);
  const timeout = Number(timeoutMs ?? 60000);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);

    try {
      const res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const msg =
          (data && (data.error?.message || data.message)) ||
          `OpenAI API error: ${res.status}`;

        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(250 * (attempt + 1) ** 2);
          continue;
        }
        throw httpError(502, msg, { status: res.status, data });
      }

      return extractOutputText(data);
    } catch (e) {
      const isAbort = String(e?.name) === "AbortError";
      if ((isAbort || isTransientFetchError(e)) && attempt < retries) {
        await sleep(250 * (attempt + 1) ** 2);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  throw httpError(502, "OpenAI API: exceeded retry limit.");
}

function isTransientFetchError(e) {
  const msg = String(e?.message ?? "");
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(msg);
}

function extractOutputText(data) {
  if (!data || typeof data !== "object") return "";

  if (typeof data.output_text === "string") return data.output_text;

  const out = Array.isArray(data.output) ? data.output : [];
  const parts = [];

  for (const o of out) {
    const content = Array.isArray(o?.content) ? o.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") parts.push(c.text);
      if (c?.type === "text" && typeof c?.text === "string") parts.push(c.text);
    }
  }

  return parts.join("\n").trim();
}
