/**
 * src/translate/openaiTranslate.mjs
 * - Server-side translation utility
 *
 * ✅ 목표:
 * - 모델명을 코드에 고정하지 않고 env로만 스위치
 *   OPENAI_MODEL_TRANSLATE > OPENAI_MODEL(legacy) > default(gpt-4.1)
 *
 * 참고:
 * - GPT-5.2는 API에서 Chat Completions와 Responses 엔드포인트 모두 지원됨. (모델 문서/가이드 참고)
 */

const DEFAULT_MODEL =
  process.env.OPENAI_MODEL_TRANSLATE ||
  process.env.OPENAI_MODEL || // legacy fallback
  "gpt-4.1";

const DEFAULT_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? 0);
const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 4096);
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 60_000);

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

// Record separator & newline placeholder
const RS = "\u241E"; // ␞ (SYMBOL FOR RECORD SEPARATOR)
const NL = "\u241F"; // ␟ (SYMBOL FOR UNIT SEPARATOR) - newline placeholder

function nowMs() {
  return Date.now();
}

function assertString(x, name) {
  if (typeof x !== "string") throw new Error(`${name} must be a string`);
}

function protectNewlines(s) {
  // Preserve all line breaks exactly; keep empty lines.
  return String(s ?? "").replace(/\r\n/g, "\n").replace(/\n/g, NL);
}

function restoreNewlines(s) {
  // Ensure the correct restoration of line breaks after translation
  return String(s ?? "").replace(new RegExp(NL, "g"), "\n");
}

function buildInputPayload(items) {
  // items: [{rowIndex, textForTranslate}]
  // Encode as RS-delimited records:
  //   <rowIndex>\t<protectedText>
  return items
    .map((it) => {
      const rowIndex = Number(it.rowIndex);
      const t = protectNewlines(it.textForTranslate);
      return `${rowIndex}\t${t}`;
    })
    .join(RS);
}

function parseOutputPayload(raw, expectedRowIndexes) {
  const parts = String(raw ?? "").split(RS);

  // Normalize: trim each record outer whitespace only
  const records = parts
    .map((p) => String(p ?? "").trim())
    .filter((p) => p.length > 0);

  const out = new Map();
  for (const rec of records) {
    const tab = rec.indexOf("\t");
    if (tab <= 0) continue;
    const k = Number(rec.slice(0, tab).trim());
    if (!Number.isFinite(k)) continue;
    const v = rec.slice(tab + 1);
    out.set(k, restoreNewlines(v));
  }

  const results = [];
  for (const ri of expectedRowIndexes) {
    const t = out.get(ri);
    results.push({ rowIndex: ri, translatedText: t ?? null });
  }
  return results;
}

function buildSystemPrompt({ sourceLang, targetLang }) {
  return [
    `You are a professional game localization translator.`,
    `Translate from ${sourceLang} to ${targetLang}.`,
    `HARD RULES:`,
    `- Output MUST keep the same record structure.`,
    `- Records are separated by the character "${RS}". Do NOT remove it.`,
    `- Each record format: <rowIndex>\\t<text>. Keep the same rowIndex.`,
    `- Newlines are encoded as the character "${NL}". Do NOT change/remove it.`,
    `- Keep any "{mask:N}" tokens EXACTLY unchanged.`,
    `- Preserve punctuation, numbers, tags (<TIPBOX>, <INFO>, <NAV>), slashes/commands.`,
    `- Do not add commentary; output ONLY the translated records.`,
  ].join("\n");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

async function callOpenAIChatCompletions({ model, temperature, maxTokens, messages, timeoutMs }) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing in environment.");

  const url = `${OPENAI_BASE_URL}/chat/completions`;

  const body = {
    model: model || DEFAULT_MODEL,
    temperature: typeof temperature === "number" ? temperature : DEFAULT_TEMPERATURE,
    max_tokens: typeof maxTokens === "number" ? maxTokens : DEFAULT_MAX_OUTPUT_TOKENS,
    messages,
  };

  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    Math.max(1_000, Number(timeoutMs ?? DEFAULT_TIMEOUT_MS))
  );

  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // keep as raw text
  }

  if (!resp.ok) {
    const msg =
      (data && (data.error?.message || data.error?.type || JSON.stringify(data))) ||
      text ||
      `OpenAI error status=${resp.status}`;
    const err = new Error(msg);
    err.status = 502;
    err.extra = { openaiStatus: resp.status };
    throw err;
  }

  const out = data?.choices?.[0]?.message?.content ?? "";
  return String(out);
}

/**
 * Translate items in chunks with newline & record boundary guarantees.
 *
 * NOTE:
 * - 이름은 기존 호환을 위해 translateItemsWithGpt41을 유지하지만,
 *   실제로는 env 모델(예: gpt-5.2)로 동작 가능.
 *
 * @param {object} args
 * @param {string} args.sourceLang
 * @param {string} args.targetLang
 * @param {Array<{rowIndex:number, sourceText?:string, textForTranslate:string}>} args.items
 * @param {number} args.chunkSize
 * @param {string} [args.model]
 * @returns {Promise<{results:Array<{rowIndex:number, sourceText?:string, translatedText:string, _fallbackUsed?:boolean}>, meta:object}>}
 */
export async function translateItemsWithGpt41(args) {
  const started = nowMs();

  const sourceLang = String(args.sourceLang ?? "").trim();
  const targetLang = String(args.targetLang ?? "").trim();
  const items = Array.isArray(args.items) ? args.items : [];
  const chunkSize = Math.max(1, Math.min(Number(args.chunkSize ?? 25), 100));
  const model = args.model || DEFAULT_MODEL;

  assertString(sourceLang, "sourceLang");
  assertString(targetLang, "targetLang");

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

    // 1st pass
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

    // Repair pass if any missing
    const missing = parsed.filter((x) => !x.translatedText || String(x.translatedText).trim() === "");
    if (missing.length > 0) {
      const repairSystem = [
        `You must REPAIR the output.`,
        `Return ALL records for the input. Keep "${RS}" separators and "${NL}" newline tokens.`,
        `Output ONLY records.`,
      ].join("\n");

      outText = await callOpenAIChatCompletions({
        model,
        temperature: 0,
        maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        messages: [
          { role: "system", content: system + "\n" + repairSystem },
          { role: "user", content: inputText },
          { role: "user", content: "The previous output missed some records. Return all records correctly." },
        ],
      });

      parsed = parseOutputPayload(outText, expectedRowIndexes);
    }

    // Finalize: if still missing, fallback to original textForTranslate
    for (const it of chunk) {
      const ri = Number(it.rowIndex);
      const got = parsed.find((x) => Number(x.rowIndex) === ri);
      const t = got?.translatedText;

      resultsAll.push({
        rowIndex: ri,
        sourceText: String(it.sourceText ?? ""),
        translatedText: t && String(t).trim() ? String(t) : String(it.textForTranslate ?? ""),
        _fallbackUsed: !(t && String(t).trim()),
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
