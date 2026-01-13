/**
 * server.mjs (Revised: Dual-key Glossary + Fast Replacement + Session Guardrails)
 *
 * 핵심 목표 (2026-01 기준 합의 반영):
 * - 대화형 웹 세션에서 Glossary를 1회 로드(세션 캐시)하고
 * - 사용자가 “Glossary 업데이트” 요청하기 전까지 동일 Glossary 기준으로 Phase 1(치환)만 수행
 * - Glossary 매칭이 있으면 우선 치환, 이후 번역 단계(Phase 2)로 넘겨도 용어가 흔들리지 않게 설계 가능한 출력 제공
 *
 * 주요 개선:
 * 1) Dual-key 치환 (B안 우선 + TERM 보조):
 *    - primary key: sourceLang 컬럼 값 (예: ko-KR)
 *    - secondary key: TERM 컬럼 값 (선택)
 * 2) 고성능 치환:
 *    - 세션 로딩 시 정규식(OR) 컴파일 (chunking)
 *    - 요청 처리에서는 text.replace() 기반으로 1~N회 (chunk 수 만큼) 치환
 * 3) Session Guardrails:
 *    - /v1/translate/replace에서 category/sourceLang/targetLang 검증(409)
 *    - TTL(미사용/최대 수명) 만료 시 410 Gone
 * 4) glossaryVersion:
 *    - 시간 기반이 아니라 “실제 로드된 Glossary 내용 기반” 해시
 *
 * 엔드포인트:
 * - GET  /              : 상태 JSON
 * - GET  /healthz       : Liveness (항상 200)
 * - GET  /readyz        : Readiness (Sheets 연결/범위 확인)
 * - POST /v1/session/init      : 세션 생성 + Glossary 1회 로드
 * - POST /v1/translate/replace : 세션 Glossary로 용어 치환(Phase 1)
 * - POST /v1/glossary/update   : 세션 Glossary 강제 갱신
 * - (옵션) /mcp         : MCP 연결 유지
 */

import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { google } from "googleapis";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------- Env ----------------
const PORT = Number(process.env.PORT || 8080);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Glossary";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// Session TTL (Cloud Run 인메모리 캐시 현실 대응)
const SESSION_IDLE_TTL_MS = Number(process.env.SESSION_IDLE_TTL_MS || 30 * 60 * 1000); // 30m idle
const SESSION_MAX_TTL_MS = Number(process.env.SESSION_MAX_TTL_MS || 6 * 60 * 60 * 1000); // 6h absolute

// 정규식 chunk size (너무 긴 패턴 방지)
const REGEX_CHUNK_SIZE = Number(process.env.REGEX_CHUNK_SIZE || 800);

function envSummary() {
  return {
    PORT,
    SPREADSHEET_ID: Boolean(SPREADSHEET_ID),
    SHEET_NAME: SHEET_NAME || "",
    GOOGLE_SERVICE_ACCOUNT_JSON: Boolean(GOOGLE_SERVICE_ACCOUNT_JSON),
    SESSION_IDLE_TTL_MS,
    SESSION_MAX_TTL_MS,
    REGEX_CHUNK_SIZE,
  };
}

// ---------------- Logging / Safety ----------------
function nowIso() {
  return new Date().toISOString();
}
function nowMs() {
  return Date.now();
}
function log(level, msg, extra = undefined) {
  const base = { ts: nowIso(), level, msg };
  if (extra !== undefined) console.log(JSON.stringify({ ...base, ...extra }));
  else console.log(JSON.stringify(base));
}
process.on("unhandledRejection", (err) => {
  log("error", "unhandledRejection", { err: String(err?.stack || err) });
});
process.on("uncaughtException", (err) => {
  log("error", "uncaughtException", { err: String(err?.stack || err) });
});

// ---------------- Helpers ----------------
function normalizeHeader(h) {
  return String(h ?? "").trim().toLowerCase();
}
function normalizeLang(lang) {
  return String(lang ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}
function normalizeCategory(cat) {
  return String(cat ?? "").trim().toLowerCase();
}
function safeJsonParse(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------- Google Sheets Client ----------------
let _sheetsClient = null;

function getSheetsClientOrThrow() {
  if (_sheetsClient) return _sheetsClient;

  if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is missing. Check env.");
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing. Check env.");

  const serviceAccount = safeJsonParse(GOOGLE_SERVICE_ACCOUNT_JSON, null);
  if (!serviceAccount) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  _sheetsClient = sheets;
  return sheets;
}

// ---------------- Sheets Reader (I:U only) ----------------
async function readGlossaryIU() {
  const sheets = getSheetsClientOrThrow();
  const range = `${SHEET_NAME}!I:U`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return { headerRaw: [], headerNorm: [], data: [] };

  const headerRaw = rows[0].map((h) => String(h ?? "").trim());
  const headerNorm = headerRaw.map(normalizeHeader);
  const body = rows.slice(1);

  const idx = {
    category: headerNorm.indexOf("분류"),
    term: headerNorm.indexOf("term"),
    len: headerNorm.indexOf("len"),
  };

  if (idx.term < 0) {
    throw new Error("I:U 범위 헤더에 TERM(또는 term)이 없습니다. U열 헤더가 'TERM'인지 확인하세요.");
  }

  // 언어 컬럼 인덱스 맵
  // - 기본: xx-yy, xx
  // - 확장: zh-hans 같은 3파트도 허용(옵션)
  const langIndex = {};
  for (let i = 0; i < headerNorm.length; i++) {
    if (i === idx.term || i === idx.len || i === idx.category) continue;
    const h = headerNorm[i];
    if (!h) continue;

    // 허용: en, en-us, zh-cn, zh-hans 등
    if (/^[a-z]{2}(-[a-z0-9]{2,8}){0,2}$/.test(h)) {
      langIndex[h] = i;
    }
  }

  const data = body
    .map((r) => {
      const term = String(r[idx.term] ?? "").trim();
      const category = idx.category >= 0 ? String(r[idx.category] ?? "").trim() : "";
      const len = idx.len >= 0 ? String(r[idx.len] ?? "").trim() : "";

      const translations = {};
      for (const [langKey, colIdx] of Object.entries(langIndex)) {
        const v = String(r[colIdx] ?? "").trim();
        if (v) translations[langKey] = v;
      }

      return { term, category, len, translations };
    })
    .filter((x) => x.term || Object.keys(x.translations || {}).length > 0);

  return { headerRaw, headerNorm, data };
}

// ---------------- Replacement Compiler (Fast) ----------------
function compileReplacers(map, chunkSize = REGEX_CHUNK_SIZE) {
  const keys = [...map.keys()].filter((k) => k && String(k).length > 0);
  if (keys.length === 0) return { chunks: [], keyCount: 0 };

  // 긴 term 우선
  keys.sort((a, b) => b.length - a.length);

  const chunks = [];
  for (let i = 0; i < keys.length; i += chunkSize) {
    const slice = keys.slice(i, i + chunkSize).map(escapeRegExp);
    const pattern = slice.join("|");
    // 빈 패턴 방지
    if (!pattern) continue;
    const re = new RegExp(pattern, "g");
    chunks.push(re);
  }

  return { chunks, keyCount: keys.length };
}

function applyReplacementsFast(text, map, regexChunks) {
  const src = String(text ?? "");
  if (!src || !map || map.size === 0 || !regexChunks || regexChunks.length === 0) {
    return { output: src, hits: [] };
  }

  const hitsSet = new Set();
  let out = src;

  // chunk별 순차 replace
  for (const re of regexChunks) {
    out = out.replace(re, (m) => {
      const rep = map.get(m);
      if (rep !== undefined) {
        hitsSet.add(m);
        return rep;
      }
      return m;
    });
  }

  // hits는 필요한 만큼만(성능)
  const hits = [...hitsSet].map((k) => ({ from: k, to: map.get(k) }));
  return { output: out, hits };
}

// ---------------- Session-Scoped Glossary Cache ----------------
/**
 * sessions.get(sessionId) = {
 *   createdAtMs,
 *   updatedAtMs,
 *   lastUsedAtMs,
 *   expiresAtMs,
 *   maxExpiresAtMs,
 *   category,
 *   sourceLang,
 *   targetLang,
 *   glossaryVersion,
 *   map,             // Map<sourceKey, targetTerm>
 *   regexChunks,     // RegExp[] (chunked)
 *   termCount,
 *   stats: { duplicates, fromSourceLangKeys, fromTermKeys }
 * }
 */
const sessions = new Map();

function computeGlossaryVersion({ category, sourceLang, targetLang, entries }) {
  // entries는 안정적 순서로 구성해야 함
  const payload = JSON.stringify({
    category: category ?? "",
    sourceLang: normalizeLang(sourceLang),
    targetLang: normalizeLang(targetLang),
    entries,
  });
  return sha256Hex(payload).slice(0, 16);
}

/**
 * Dual-key map build:
 * - primary: srcLang column value -> tgtLang column value
 * - secondary: TERM value -> tgtLang column value (if non-empty)
 *
 * 충돌 정책:
 * - primary 키 충돌: "마지막 값 우선"(시트 수정 반영 유리)
 * - TERM 키 충돌: "마지막 값 우선"
 * - 동일 문자열이 primary와 secondary에 모두 등장: primary가 최종 우선
 */
function buildGlossaryMapDual(rows, category, sourceLang, targetLang) {
  const cat = normalizeCategory(category);
  const src = normalizeLang(sourceLang);
  const tgt = normalizeLang(targetLang);

  const filtered = rows.filter((r) => {
    if (!cat) return true;
    return normalizeCategory(r.category) === cat;
  });

  const primary = new Map(); // srcLangValue -> tgtLangValue
  const secondary = new Map(); // TERM -> tgtLangValue

  let dupPrimary = 0;
  let dupSecondary = 0;
  let fromSourceLangKeys = 0;
  let fromTermKeys = 0;

  for (const r of filtered) {
    const termKey = String(r.term ?? "").trim();
    const srcKey = String(r.translations?.[src] ?? "").trim();
    const tgtVal = String(r.translations?.[tgt] ?? "").trim();
    if (!tgtVal) continue;

    if (srcKey) {
      if (primary.has(srcKey)) dupPrimary++;
      primary.set(srcKey, tgtVal);
      fromSourceLangKeys++;
    }

    if (termKey) {
      if (secondary.has(termKey)) dupSecondary++;
      secondary.set(termKey, tgtVal);
      fromTermKeys++;
    }
  }

  // merge with priority: primary wins
  const merged = new Map(secondary);
  for (const [k, v] of primary.entries()) {
    merged.set(k, v);
  }

  const { chunks: regexChunks } = compileReplacers(merged, REGEX_CHUNK_SIZE);

  // glossaryVersion 계산용 entries: key 정렬(안정성)
  const entries = [...merged.entries()].sort((a, b) => {
    // 길이 우선이 아니라 "안정 정렬" (버전 계산용)
    if (a[0] === b[0]) return 0;
    return a[0] < b[0] ? -1 : 1;
  });

  return {
    map: merged,
    regexChunks,
    termCount: merged.size,
    versionEntries: entries,
    stats: {
      duplicates: { primary: dupPrimary, secondary: dupSecondary },
      fromSourceLangKeys,
      fromTermKeys,
    },
  };
}

function computeSessionExpiry(createdAtMs, lastUsedAtMs) {
  const now = nowMs();
  const maxExpiresAtMs = createdAtMs + SESSION_MAX_TTL_MS;
  const idleExpiresAtMs = (lastUsedAtMs ?? now) + SESSION_IDLE_TTL_MS;
  const expiresAtMs = Math.min(idleExpiresAtMs, maxExpiresAtMs);
  return { expiresAtMs, maxExpiresAtMs };
}

function touchSession(session) {
  const t = nowMs();
  session.lastUsedAtMs = t;
  session.updatedAtMs = t;
  const { expiresAtMs, maxExpiresAtMs } = computeSessionExpiry(session.createdAtMs, session.lastUsedAtMs);
  session.expiresAtMs = expiresAtMs;
  session.maxExpiresAtMs = maxExpiresAtMs;
}

function getSessionOrExpire(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { session: null, expired: false };

  const now = nowMs();
  if (now > s.expiresAtMs || now > s.maxExpiresAtMs) {
    sessions.delete(sessionId);
    return { session: null, expired: true };
  }

  touchSession(s);
  return { session: s, expired: false };
}

async function loadSessionGlossary(sessionId, { category, sourceLang, targetLang }) {
  const { data } = await readGlossaryIU();
  const built = buildGlossaryMapDual(data, category, sourceLang, targetLang);

  const existing = sessions.get(sessionId);
  const createdAtMs = existing?.createdAtMs ?? nowMs();

  const glossaryVersion = computeGlossaryVersion({
    category,
    sourceLang,
    targetLang,
    entries: built.versionEntries,
  });

  const session = {
    createdAtMs,
    updatedAtMs: nowMs(),
    lastUsedAtMs: nowMs(),
    expiresAtMs: 0,
    maxExpiresAtMs: 0,
    category: category ?? "",
    sourceLang: normalizeLang(sourceLang),
    targetLang: normalizeLang(targetLang),
    glossaryVersion,
    map: built.map,
    regexChunks: built.regexChunks,
    termCount: built.termCount,
    stats: built.stats,
  };

  // expiry 계산
  const { expiresAtMs, maxExpiresAtMs } = computeSessionExpiry(session.createdAtMs, session.lastUsedAtMs);
  session.expiresAtMs = expiresAtMs;
  session.maxExpiresAtMs = maxExpiresAtMs;

  sessions.set(sessionId, session);
  return session;
}

// ---------------- Express App ----------------
const app = express();

// body parsing
app.use(express.json({ limit: "5mb", type: ["application/json", "application/*+json"] }));
app.use(express.text({ limit: "5mb", type: ["text/*"] }));

// request logging
app.use((req, _res, next) => {
  log("info", "request", { method: req.method, path: req.path });
  next();
});

// Root
app.get("/", (_req, res) => {
  const uptimeSec = Math.floor(process.uptime());
  const summary = envSummary();

  res.status(200).json({
    status: "OK",
    service: "sheets-glossary-mcp",
    time: nowIso(),
    uptimeSec,
    env: summary,
    sessions: { count: sessions.size },
    endpoints: {
      healthz: "/healthz",
      readyz: "/readyz",
      sessionInit: "/v1/session/init",
      replace: "/v1/translate/replace",
      glossaryUpdate: "/v1/glossary/update",
    },
  });
});

app.get("/healthz", (_req, res) => res.status(200).send("OK"));

app.get("/readyz", async (_req, res) => {
  try {
    const sheets = getSheetsClientOrThrow();
    const range = `${SHEET_NAME}!I1:U1`;

    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });

    const header = r?.data?.values?.[0] ?? [];

    return res.status(200).json({
      status: "OK",
      sheets: {
        spreadsheetIdPresent: Boolean(SPREADSHEET_ID),
        sheetName: SHEET_NAME,
        range,
        headerCells: header.length,
      },
      time: nowIso(),
    });
  } catch (e) {
    return res.status(500).json({
      status: "NOT_READY",
      error: String(e?.message || e),
      env: envSummary(),
      time: nowIso(),
    });
  }
});

// ---------------- API ----------------

// 1) 세션 생성 + Glossary 1회 로드
app.post("/v1/session/init", async (req, res) => {
  const schema = z.object({
    category: z.string().optional().default(""),
    sourceLang: z.string().optional().default("ko-KR"),
    targetLang: z.string().optional().default("en-US"),
    sessionId: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { category, sourceLang, targetLang } = parsed.data;
  const sessionId = parsed.data.sessionId?.trim() || crypto.randomUUID();

  try {
    const session = await loadSessionGlossary(sessionId, { category, sourceLang, targetLang });

    return res.status(200).json({
      sessionId,
      category: session.category,
      sourceLang: session.sourceLang,
      targetLang: session.targetLang,
      glossaryVersion: session.glossaryVersion,
      termCount: session.termCount,
      updatedAt: new Date(session.updatedAtMs).toISOString(),
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      maxExpiresAt: new Date(session.maxExpiresAtMs).toISOString(),
      // 운영 관측용(가볍게)
      stats: session.stats,
    });
  } catch (e) {
    log("error", "session_init_failed", { err: String(e?.stack || e) });
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// 2) Glossary 업데이트(명시적 갱신)
app.post("/v1/glossary/update", async (req, res) => {
  const schema = z.object({
    sessionId: z.string(),
    category: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLang: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { sessionId } = parsed.data;
  const current = sessions.get(sessionId);
  if (!current) return res.status(404).json({ error: "Unknown sessionId." });

  const category = parsed.data.category ?? current.category;
  const sourceLang = parsed.data.sourceLang ?? current.sourceLang;
  const targetLang = parsed.data.targetLang ?? current.targetLang;

  try {
    const session = await loadSessionGlossary(sessionId, { category, sourceLang, targetLang });

    return res.status(200).json({
      sessionId,
      category: session.category,
      sourceLang: session.sourceLang,
      targetLang: session.targetLang,
      glossaryVersion: session.glossaryVersion,
      termCount: session.termCount,
      updatedAt: new Date(session.updatedAtMs).toISOString(),
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      maxExpiresAt: new Date(session.maxExpiresAtMs).toISOString(),
      stats: session.stats,
    });
  } catch (e) {
    log("error", "glossary_update_failed", { err: String(e?.stack || e) });
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// 3) 대량 치환(Phase 1: Glossary Lock only)
app.post("/v1/translate/replace", async (req, res) => {
  const schema = z.object({
    sessionId: z.string(),
    texts: z.array(z.string()).min(1).max(200),
    // 세션 오용 방지: 검증용 필드(권장: 클라이언트가 항상 포함)
    category: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLang: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { sessionId, texts } = parsed.data;

  const { session: s, expired } = getSessionOrExpire(sessionId);
  if (!s) {
    if (expired) {
      return res.status(410).json({ error: "Session expired. Call /v1/session/init again." });
    }
    return res.status(404).json({ error: "Unknown sessionId. Call /v1/session/init first." });
  }

  // 세션 메타 검증(409): 잘못된 sessionId 재사용 차단
  const reqCat = parsed.data.category;
  const reqSrc = parsed.data.sourceLang ? normalizeLang(parsed.data.sourceLang) : undefined;
  const reqTgt = parsed.data.targetLang ? normalizeLang(parsed.data.targetLang) : undefined;

  if (reqCat !== undefined && normalizeCategory(reqCat) !== normalizeCategory(s.category)) {
    return res.status(409).json({ error: "Session/category mismatch." });
  }
  if (reqSrc !== undefined && reqSrc !== s.sourceLang) {
    return res.status(409).json({ error: "Session/sourceLang mismatch." });
  }
  if (reqTgt !== undefined && reqTgt !== s.targetLang) {
    return res.status(409).json({ error: "Session/targetLang mismatch." });
  }

  const limit = parsed.data.limit ?? texts.length;
  const sliced = texts.slice(0, limit);

  const results = [];
  let noHitCount = 0;

  for (const t of sliced) {
    const { output, hits } = applyReplacementsFast(t, s.map, s.regexChunks);
    if ((hits?.length ?? 0) === 0) noHitCount++;
    results.push({
      input: t,
      output,
      replacements: hits, // [{from,to}]
    });
  }

  return res.status(200).json({
    sessionId,
    glossaryVersion: s.glossaryVersion,
    category: s.category,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    termCount: s.termCount,
    updatedAt: new Date(s.updatedAtMs).toISOString(),
    expiresAt: new Date(s.expiresAtMs).toISOString(),
    maxExpiresAt: new Date(s.maxExpiresAtMs).toISOString(),
    results,
    notes: noHitCount > 0 ? [`no glossary hit in ${noHitCount} line(s)`] : [],
  });
});

// ---------------- (선택) MCP 유지: /mcp ----------------
const mcp = new McpServer({ name: "sheets-glossary-mcp", version: "2.0.0" });

mcp.tool(
  "session_init",
  {
    category: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLang: z.string().optional(),
  },
  async ({ category, sourceLang, targetLang }) => {
    const sessionId = crypto.randomUUID();
    const session = await loadSessionGlossary(sessionId, {
      category: category ?? "",
      sourceLang: sourceLang ?? "ko-KR",
      targetLang: targetLang ?? "en-US",
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionId,
              category: session.category,
              sourceLang: session.sourceLang,
              targetLang: session.targetLang,
              glossaryVersion: session.glossaryVersion,
              termCount: session.termCount,
              updatedAt: new Date(session.updatedAtMs).toISOString(),
              expiresAt: new Date(session.expiresAtMs).toISOString(),
              maxExpiresAt: new Date(session.maxExpiresAtMs).toISOString(),
              stats: session.stats,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

mcp.tool(
  "replace_batch",
  {
    sessionId: z.string(),
    texts: z.array(z.string()).min(1).max(200),
    category: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLang: z.string().optional(),
  },
  async ({ sessionId, texts, category, sourceLang, targetLang }) => {
    const { session: s, expired } = getSessionOrExpire(sessionId);
    if (!s) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: expired ? "Session expired. Re-init required." : "Unknown sessionId" },
              null,
              2
            ),
          },
        ],
      };
    }

    // 메타 검증(선택)
    if (category !== undefined && normalizeCategory(category) !== normalizeCategory(s.category)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Session/category mismatch." }, null, 2) }] };
    }
    if (sourceLang !== undefined && normalizeLang(sourceLang) !== s.sourceLang) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Session/sourceLang mismatch." }, null, 2) }] };
    }
    if (targetLang !== undefined && normalizeLang(targetLang) !== s.targetLang) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Session/targetLang mismatch." }, null, 2) }] };
    }

    const results = texts.map((t) => {
      const { output, hits } = applyReplacementsFast(t, s.map, s.regexChunks);
      return { input: t, output, replacements: hits };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ sessionId, glossaryVersion: s.glossaryVersion, results }, null, 2),
        },
      ],
    };
  }
);

app.all("/mcp", async (req, res) => {
  // ---- Accept 헤더 보정: */*, 미지정, application/json만 온 경우에도 통과시키기 ----
  const accept = String(req.headers["accept"] ?? "").toLowerCase();

  // SDK가 text/event-stream을 요구하므로, 애매한 Accept는 강제로 추가
  if (!accept || accept.includes("*/*") || (accept.includes("application/json") && !accept.includes("text/event-stream"))) {
    req.headers["accept"] = "text/event-stream, application/json";
  }

  let body = req.body;
  if (typeof body === "string") body = safeJsonParse(body, body);

  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => transport.close());

  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
});

// ---------------- 404 / Error Handling ----------------
app.use((_req, res) => {
  res.status(404).json({ error: "Not Found" });
});

app.use((err, _req, res, _next) => {
  log("error", "express_error", { err: String(err?.stack || err) });
  res.status(500).json({ error: "Internal Server Error" });
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  log("info", "server_started", { port: PORT, env: envSummary() });
});
