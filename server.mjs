import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { google } from "googleapis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT || 8080);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Glossary";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const GLOSSARY_RANGE = process.env.GLOSSARY_RANGE || `${SHEET_NAME}!A:AA`;

const SESSION_IDLE_TTL_MS = Number(process.env.SESSION_IDLE_TTL_MS || 30 * 60 * 1000);
const SESSION_MAX_TTL_MS = Number(process.env.SESSION_MAX_TTL_MS || 6 * 60 * 60 * 1000);
const MAX_PATTERN_LEN = Number(process.env.MAX_PATTERN_LEN || 50000);

const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();
const log = (level, msg, extra) => console.log(JSON.stringify({ ts: nowIso(), level, msg, ...(extra || {}) }));

process.on("unhandledRejection", (e) => log("error", "unhandledRejection", { err: String(e?.stack || e) }));
process.on("uncaughtException", (e) => log("error", "uncaughtException", { err: String(e?.stack || e) }));

const normHeader = (s) => String(s ?? "").trim().toLowerCase();
const normLang = (s) => String(s ?? "").trim().toLowerCase().replace(/_/g, "-");
const normCat = (s) => String(s ?? "").trim().toLowerCase();
const safeJson = (s, fb = null) => {
  try { return JSON.parse(s); } catch { return fb; }
};
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let _sheets = null;
function sheetsClient() {
  if (_sheets) return _sheets;
  if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is missing.");
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing.");
  const creds = safeJson(GOOGLE_SERVICE_ACCOUNT_JSON);
  if (!creds) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  _sheets = google.sheets({ version: "v4", auth });
  return _sheets;
}

const findHeaderIdx = (hn, candidates, contains = false) => {
  if (!contains) {
    for (const c of candidates) {
      const i = hn.indexOf(c);
      if (i >= 0) return i;
    }
    return -1;
  }
  for (let i = 0; i < hn.length; i++) {
    const h = hn[i] || "";
    for (const c of candidates) if (h.includes(c)) return i;
  }
  return -1;
};

async function readGlossary() {
  const res = await sheetsClient().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: GLOSSARY_RANGE });
  const rows = res.data.values || [];
  if (rows.length < 2) return { headerRaw: [], headerNorm: [], data: [] };

  const headerRaw = rows[0].map((h) => String(h ?? "").trim());
  const headerNorm = headerRaw.map(normHeader);
  const body = rows.slice(1);

  const idxCategory = findHeaderIdx(headerNorm, ["분류", "category", "cat"], true);
  const idxTerm = findHeaderIdx(headerNorm, ["term"], true);
  const idxLen = findHeaderIdx(headerNorm, ["len"], false);

  if (idxTerm < 0) throw new Error("TERM header not found (expected header containing 'TERM').");

  const langIndex = {};
  for (let i = 0; i < headerNorm.length; i++) {
    if (i === idxTerm || i === idxLen || i === idxCategory) continue;
    const h = headerNorm[i];
    if (!h) continue;
    if (/^[a-z]{2}(-[a-z0-9]{2,8}){0,2}$/.test(h)) langIndex[h] = i;
  }

  const data = body
    .map((r) => {
      const term = String(r[idxTerm] ?? "").trim();
      const category = idxCategory >= 0 ? String(r[idxCategory] ?? "").trim() : "";
      const len = idxLen >= 0 ? String(r[idxLen] ?? "").trim() : "";
      const translations = {};
      for (const [lk, ci] of Object.entries(langIndex)) {
        const v = String(r[ci] ?? "").trim();
        if (v) translations[lk] = v;
      }
      return { term, category, len, translations };
    })
    .filter((x) => x.term || Object.keys(x.translations || {}).length > 0);

  return { headerRaw, headerNorm, data };
}

function compileReplacers(map) {
  const keys = [...map.keys()].filter((k) => k && String(k).length);
  if (!keys.length) return { chunks: [], keyCount: 0 };

  keys.sort((a, b) => b.length - a.length);
  const chunks = [];
  let buf = [];
  let bufLen = 0;

  for (const k of keys) {
    const ek = escRe(k);
    const addLen = ek.length + (buf.length ? 1 : 0);
    if (bufLen + addLen > MAX_PATTERN_LEN && buf.length) {
      chunks.push(new RegExp(buf.join("|"), "g"));
      buf = [];
      bufLen = 0;
    }
    buf.push(ek);
    bufLen += addLen;
  }
  if (buf.length) chunks.push(new RegExp(buf.join("|"), "g"));
  return { chunks, keyCount: keys.length };
}

function applyReplace(text, map, chunks) {
  const src = String(text ?? "");
  if (!src || !map?.size || !chunks?.length) return { output: src, hits: [] };
  const hit = new Set();
  let out = src;
  for (const re of chunks) {
    out = out.replace(re, (m) => {
      const rep = map.get(m);
      if (rep !== undefined) { hit.add(m); return rep; }
      return m;
    });
  }
  return { output: out, hits: [...hit].map((k) => ({ from: k, to: map.get(k) })) };
}

function buildGlossaryDual(rows, category, sourceLang, targetLang) {
  const cat = normCat(category);
  const src = normLang(sourceLang);
  const tgt = normLang(targetLang);

  const filtered = rows.filter((r) => !cat || normCat(r.category) === cat);

  const primary = new Map();
  const secondary = new Map();
  let dupP = 0, dupS = 0, fromSrc = 0, fromTerm = 0;

  for (const r of filtered) {
    const termKey = String(r.term ?? "").trim();
    const srcKey = String(r.translations?.[src] ?? "").trim();
    const tgtVal = String(r.translations?.[tgt] ?? "").trim();
    if (!tgtVal) continue;

    if (srcKey) { if (primary.has(srcKey)) dupP++; primary.set(srcKey, tgtVal); fromSrc++; }
    if (termKey) { if (secondary.has(termKey)) dupS++; secondary.set(termKey, tgtVal); fromTerm++; }
  }

  const merged = new Map(secondary);
  for (const [k, v] of primary.entries()) merged.set(k, v);

  const { chunks } = compileReplacers(merged);
  const entries = [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return {
    map: merged,
    regexChunks: chunks,
    termCount: merged.size,
    versionEntries: entries,
    stats: { duplicates: { primary: dupP, secondary: dupS }, fromSourceLangKeys: fromSrc, fromTermKeys: fromTerm },
  };
}

const sessions = new Map();

const expiry = (createdAtMs, lastUsedAtMs) => {
  const maxExpiresAtMs = createdAtMs + SESSION_MAX_TTL_MS;
  const idleExpiresAtMs = (lastUsedAtMs ?? nowMs()) + SESSION_IDLE_TTL_MS;
  const expiresAtMs = Math.min(idleExpiresAtMs, maxExpiresAtMs);
  return { expiresAtMs, maxExpiresAtMs };
};

const touch = (s) => {
  const t = nowMs();
  s.lastUsedAtMs = t;
  s.updatedAtMs = t;
  const { expiresAtMs, maxExpiresAtMs } = expiry(s.createdAtMs, s.lastUsedAtMs);
  s.expiresAtMs = expiresAtMs;
  s.maxExpiresAtMs = maxExpiresAtMs;
};

const getSession = (id) => {
  const s = sessions.get(id);
  if (!s) return { session: null, expired: false };
  const t = nowMs();
  if (t > s.expiresAtMs || t > s.maxExpiresAtMs) { sessions.delete(id); return { session: null, expired: true }; }
  touch(s);
  return { session: s, expired: false };
};

async function loadSession(sessionId, { category, sourceLang, targetLang }) {
  const { data } = await readGlossary();
  const built = buildGlossaryDual(data, category, sourceLang, targetLang);

  const existing = sessions.get(sessionId);
  const createdAtMs = existing?.createdAtMs ?? nowMs();

  const glossaryVersion = sha256(
    JSON.stringify({
      category: category ?? "",
      sourceLang: normLang(sourceLang),
      targetLang: normLang(targetLang),
      entries: built.versionEntries,
    })
  ).slice(0, 16);

  const s = {
    createdAtMs,
    updatedAtMs: nowMs(),
    lastUsedAtMs: nowMs(),
    expiresAtMs: 0,
    maxExpiresAtMs: 0,
    category: category ?? "",
    sourceLang: normLang(sourceLang),
    targetLang: normLang(targetLang),
    glossaryVersion,
    map: built.map,
    regexChunks: built.regexChunks,
    termCount: built.termCount,
    stats: built.stats,
  };

  Object.assign(s, expiry(s.createdAtMs, s.lastUsedAtMs));
  sessions.set(sessionId, s);
  return s;
}

// ---------------- HTTP ----------------
const app = express();
app.use(express.json({ limit: "5mb", type: ["application/json", "application/*+json"] }));
app.use(express.text({ limit: "5mb", type: ["text/*"] }));
app.use((req, _res, next) => { log("info", "request", { method: req.method, path: req.path }); next(); });

app.get("/", (_req, res) => {
  res.status(200).json({
    status: "OK",
    service: "sheets-glossary-mcp",
    time: nowIso(),
    uptimeSec: Math.floor(process.uptime()),
    env: {
      PORT,
      SPREADSHEET_ID: Boolean(SPREADSHEET_ID),
      SHEET_NAME,
      GLOSSARY_RANGE,
      GOOGLE_SERVICE_ACCOUNT_JSON: Boolean(GOOGLE_SERVICE_ACCOUNT_JSON),
      SESSION_IDLE_TTL_MS,
      SESSION_MAX_TTL_MS,
      MAX_PATTERN_LEN,
    },
    sessions: { count: sessions.size },
    endpoints: {
      healthz: "/healthz",
      readyz: "/readyz",
      sessionInit: "/v1/session/init",
      replace: "/v1/translate/replace",
      glossaryUpdate: "/v1/glossary/update",
      mcp: "/mcp",
    },
  });
});

app.get("/healthz", (_req, res) => res.status(200).send("OK"));

app.get("/readyz", async (_req, res) => {
  try {
    const range = `${SHEET_NAME}!A1:AA1`;
    const r = await sheetsClient().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    const header = r?.data?.values?.[0] ?? [];
    res.status(200).json({
      status: "OK",
      sheets: { spreadsheetIdPresent: Boolean(SPREADSHEET_ID), sheetName: SHEET_NAME, range, headerCells: header.length },
      time: nowIso(),
    });
  } catch (e) {
    res.status(500).json({ status: "NOT_READY", error: String(e?.message || e), time: nowIso() });
  }
});

app.post("/v1/session/init", async (req, res) => {
  const schema = z.object({
    category: z.string().optional().default(""),
    sourceLang: z.string().optional().default("ko-KR"),
    targetLang: z.string().optional().default("en-US"),
    sessionId: z.string().optional(),
  });
  const p = schema.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });

  const sessionId = p.data.sessionId?.trim() || crypto.randomUUID();
  try {
    const s = await loadSession(sessionId, p.data);
    res.status(200).json({
      sessionId,
      category: s.category,
      sourceLang: s.sourceLang,
      targetLang: s.targetLang,
      glossaryVersion: s.glossaryVersion,
      termCount: s.termCount,
      updatedAt: new Date(s.updatedAtMs).toISOString(),
      expiresAt: new Date(s.expiresAtMs).toISOString(),
      maxExpiresAt: new Date(s.maxExpiresAtMs).toISOString(),
      stats: s.stats,
    });
  } catch (e) {
    log("error", "session_init_failed", { err: String(e?.stack || e) });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/v1/glossary/update", async (req, res) => {
  const schema = z.object({
    sessionId: z.string(),
    category: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLang: z.string().optional(),
  });
  const p = schema.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });

  const cur = sessions.get(p.data.sessionId);
  if (!cur) return res.status(404).json({ error: "Unknown sessionId." });

  const category = p.data.category ?? cur.category;
  const sourceLang = p.data.sourceLang ?? cur.sourceLang;
  const targetLang = p.data.targetLang ?? cur.targetLang;

  try {
    const s = await loadSession(p.data.sessionId, { category, sourceLang, targetLang });
    res.status(200).json({
      sessionId: p.data.sessionId,
      category: s.category,
      sourceLang: s.sourceLang,
      targetLang: s.targetLang,
      glossaryVersion: s.glossaryVersion,
      termCount: s.termCount,
      updatedAt: new Date(s.updatedAtMs).toISOString(),
      expiresAt: new Date(s.expiresAtMs).toISOString(),
      maxExpiresAt: new Date(s.maxExpiresAtMs).toISOString(),
      stats: s.stats,
    });
  } catch (e) {
    log("error", "glossary_update_failed", { err: String(e?.stack || e) });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/v1/translate/replace", async (req, res) => {
  const schema = z.object({
    sessionId: z.string(),
    texts: z.array(z.string()).min(1).max(200),
    category: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLang: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  });
  const p = schema.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });

  const { session: s, expired } = getSession(p.data.sessionId);
  if (!s) return res.status(expired ? 410 : 404).json({ error: expired ? "Session expired. Re-init required." : "Unknown sessionId." });

  const reqCat = p.data.category;
  const reqSrc = p.data.sourceLang ? normLang(p.data.sourceLang) : undefined;
  const reqTgt = p.data.targetLang ? normLang(p.data.targetLang) : undefined;

  if (reqCat !== undefined && normCat(reqCat) !== normCat(s.category)) return res.status(409).json({ error: "Session/category mismatch." });
  if (reqSrc !== undefined && reqSrc !== s.sourceLang) return res.status(409).json({ error: "Session/sourceLang mismatch." });
  if (reqTgt !== undefined && reqTgt !== s.targetLang) return res.status(409).json({ error: "Session/targetLang mismatch." });

  const sliced = p.data.texts.slice(0, p.data.limit ?? p.data.texts.length);
  const results = [];
  let noHit = 0;

  for (const t of sliced) {
    const { output, hits } = applyReplace(t, s.map, s.regexChunks);
    if (!hits.length) noHit++;
    results.push({ input: t, output, replacements: hits });
  }

  res.status(200).json({
    sessionId: p.data.sessionId,
    glossaryVersion: s.glossaryVersion,
    category: s.category,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    termCount: s.termCount,
    updatedAt: new Date(s.updatedAtMs).toISOString(),
    expiresAt: new Date(s.expiresAtMs).toISOString(),
    maxExpiresAt: new Date(s.maxExpiresAtMs).toISOString(),
    results,
    notes: noHit ? [`no glossary hit in ${noHit} line(s)`] : [],
  });
});

// ---------------- MCP ----------------
const mcp = new McpServer({ name: "sheets-glossary-mcp", version: "4.0.0" });

mcp.tool(
  "session_init",
  { category: z.string().optional(), sourceLang: z.string().optional(), targetLang: z.string().optional() },
  async ({ category, sourceLang, targetLang }) => {
    const sessionId = crypto.randomUUID();
    const s = await loadSession(sessionId, { category: category ?? "", sourceLang: sourceLang ?? "ko-KR", targetLang: targetLang ?? "en-US" });
    return { content: [{ type: "text", text: JSON.stringify({ sessionId, category: s.category, sourceLang: s.sourceLang, targetLang: s.targetLang, glossaryVersion: s.glossaryVersion, termCount: s.termCount, updatedAt: new Date(s.updatedAtMs).toISOString(), expiresAt: new Date(s.expiresAtMs).toISOString(), stats: s.stats }, null, 2) }] };
  }
);

mcp.tool(
  "replace_batch",
  { sessionId: z.string(), texts: z.array(z.string()).min(1).max(200), category: z.string().optional(), sourceLang: z.string().optional(), targetLang: z.string().optional() },
  async ({ sessionId, texts, category, sourceLang, targetLang }) => {
    const { session: s, expired } = getSession(sessionId);
    if (!s) return { content: [{ type: "text", text: JSON.stringify({ error: expired ? "Session expired. Re-init required." : "Unknown sessionId" }, null, 2) }] };

    if (category !== undefined && normCat(category) !== normCat(s.category)) return { content: [{ type: "text", text: JSON.stringify({ error: "Session/category mismatch." }, null, 2) }] };
    if (sourceLang !== undefined && normLang(sourceLang) !== s.sourceLang) return { content: [{ type: "text", text: JSON.stringify({ error: "Session/sourceLang mismatch." }, null, 2) }] };
    if (targetLang !== undefined && normLang(targetLang) !== s.targetLang) return { content: [{ type: "text", text: JSON.stringify({ error: "Session/targetLang mismatch." }, null, 2) }] };

    const results = texts.map((t) => {
      const { output, hits } = applyReplace(t, s.map, s.regexChunks);
      return { input: t, output, replacements: hits };
    });
    return { content: [{ type: "text", text: JSON.stringify({ sessionId, glossaryVersion: s.glossaryVersion, results }, null, 2) }] };
  }
);

// Accept 보정(406 방지)
app.all("/mcp", async (req, res) => {
  const accept = String(req.headers["accept"] ?? "").toLowerCase();
  if (!accept || accept.includes("*/*") || (accept.includes("application/json") && !accept.includes("text/event-stream"))) {
    req.headers["accept"] = "text/event-stream, application/json";
  }
  let body = req.body;
  if (typeof body === "string") body = safeJson(body, body);

  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => transport.close());

  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
});

app.use((_req, res) => res.status(404).json({ error: "Not Found" }));
app.use((err, _req, res, _next) => { log("error", "express_error", { err: String(err?.stack || err) }); res.status(500).json({ error: "Internal Server Error" }); });

app.listen(PORT, () => log("info", "server_started", { port: PORT }));
