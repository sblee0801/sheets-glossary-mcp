// src/translate/openaiTranslate.mjs
// - Server-side translation utility (record-safe)
// - ENV model override supported

const DEFAULT_MODEL =
  process.env.OPENAI_MODEL_TRANSLATE ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1";

const DEFAULT_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? 0);
const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 4096);
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 60_000);

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

// Record separator & newline placeholder
const RS = "\u241E"; // ␞
const NL = "\u241F"; // ␟

function nowMs() {
  return Date.now();
}

function assertNonEmptyString(x, name) {
  if (typeof x !== "string" || !x.trim()) throw new Error(`${name} must be a non-empty string`);
}

function protectNewlines(s) {
  return String(s ?? "").replace(/\r\n/g, "\n").replace(/\n/g, NL);
}
function restoreNewlines(s) {
  return String(s ?? "").replace(new RegExp(NL, "g"), "\n");
}

function buildInputPayload(items) {
  // <rowIndex>\t<protectedText> records joined by RS
  return items
    .map((it) => `${Number(it.rowIndex)}\t${protectNewlines(it.textForTranslate)}`)
    .join(RS);
}

function parseOutputPayload(raw, expectedRowIndexes) {
  const recs = String(raw ?? "")
    .split(RS)
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);

  const outMap = new Map();
  for (const rec of recs) {
    const tab = rec.indexOf("\t");
    if (tab <= 0) continue;
    const ri = Number(rec.slice(0, tab).trim());
    if (!Number.isFinite(ri)) continue;
    outMap.set(ri, restoreNewlines(rec.slice(tab + 1)));
  }

  return expectedRowIndexes.map((ri) => ({
    rowIndex: ri,
    translatedText: outMap.get(ri) ?? null,
  }));
}

function buildSystemPrompt({ sourceLang, targetLang }) {
  return [
    `You are a professional game localization translator.`,
    `Translate from ${sourceLang} to ${targetLang}.`,
    `HARD RULES:`,
    `- Output MUST keep the same record structure.`,
    `- Records are separated by "${RS}". Do NOT remove it.`,
    `- Each record format: <rowIndex>\\t<text>. Keep the same rowIndex.`,
    `- Newlines are encoded as "${NL}". Do NOT change/remove it.`,
    `- Keep any "{mask:N}" tokens EXACTLY unchanged.`,
    `- Preserve punctuation, numbers, and tags (<TIPBOX>, <INFO>, <NAV>).`,
    `- Output ONLY the translated records.`,
  ].join("\n");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAIChatCompletions({ model, temperature, maxTokens, messages, timeoutMs }) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing in environment.");

  const resp = await fetchWithTimeout(
    `${OPENAI_BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        temperature: typeof temperature === "number" ? temperature : DEFAULT_TEMPERATURE,
        max_tokens: typeof maxTokens === "number" ? maxTokens : DEFAULT_MAX_OUTPUT_TOKENS,
        messages,
      }),
    },
    Math.max(1_000, Number(timeoutMs ?? DEFAULT_TIMEOUT_MS))
  );

  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // leave as raw
  }

  if (!resp.ok) {
    const msg =
      data?.error?.message ||
      data?.error?.type ||
      (typeof text === "string" && text) ||
      `OpenAI error status=${resp.status}`;
    const err = new Error(msg);
    err.status = 502;
    err.extra = { openaiStatus: resp.status };
    throw err;
  }

  return String(data?.choices?.[0]?.message?.content ?? "");
}

/**
 * Translate items in chunks with record boundary guarantees.
 * - Name kept for compatibility.
 */
export async function translateItemsWithGpt41(args) {
  const started = nowMs();

  const sourceLang = String(args.sourceLang ?? "").trim();
  const targetLang = String(args.targetLang ?? "").trim();
  const items = Array.isArray(args.items) ? args.items : [];
  const chunkSize = Math.max(1, Math.min(Number(args.chunkSize ?? 25), 100));
  const model = args.model || DEFAULT_MODEL;

  assertNonEmptyString(sourceLang, "sourceLang");
  assertNonEmptyString(targetLang, "targetLang");

  if (!items.length) {
    return {
      results: [],
      meta: { model, chunks: 0, chunkSize, elapsedMs: nowMs() - started, items: 0 },
    };
  }

  const resultsAll = [];
  let chunks = 0;

  for (let i = 0; i < items.length; i += chunkSize) {
    chunks += 1;
    const chunk = items.slice(i, i + chunkSize);

    const expectedRowIndexes = chunk.map((it) => Number(it.rowIndex));
    const inputText = buildInputPayload(chunk);
    const system = buildSystemPrompt({ sourceLang, targetLang });

    // Pass 1
    let outText = await callOpenAIChatCompletions({
      model,
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: inputText },
      ],
    });

    let parsed = parseOutputPayload(outText, expectedRowIndexes);

    // Repair pass if missing
    const missing = parsed.filter((x) => !x.translatedText || !String(x.translatedText).trim());
    if (missing.length) {
      outText = await callOpenAIChatCompletions({
        model,
        temperature: 0,
        maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        messages: [
          { role: "system", content: system + "\nReturn ALL records. Output ONLY records." },
          { role: "user", content: inputText },
          { role: "user", content: "The previous output missed some records. Return all records correctly." },
        ],
      });
      parsed = parseOutputPayload(outText, expectedRowIndexes);
    }

    // Finalize with fallback
    for (const it of chunk) {
      const ri = Number(it.rowIndex);
      const got = parsed.find((x) => Number(x.rowIndex) === ri);
      const t = got?.translatedText;

      const ok = t && String(t).trim();
      resultsAll.push({
        rowIndex: ri,
        sourceText: String(it.sourceText ?? ""),
        translatedText: ok ? String(t) : String(it.textForTranslate ?? ""),
        _fallbackUsed: !ok,
      });
    }
  }

  return {
    results: resultsAll,
    meta: {
      model,
      chunks,
      chunkSize,
      elapsedMs: nowMs() - started,
      items: items.length,
    },
  };
}
