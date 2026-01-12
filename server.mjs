/**
 * server.mjs
 * 목적:
 * - “대화형 웹 세션”에서 Glossary를 1회 로드(캐시)하고
 * - 사용자가 명시적으로 “Glossary 업데이트”를 요청하기 전까지
 *   동일 Glossary 기준으로 치환(Glossary Lock)만 수행
 *
 * 주요 엔드포인트:
 * - POST /v1/session/init            : 세션 생성 + Glossary 로드(카테고리/언어 기준)
 * - POST /v1/translate/replace       : 세션의 Glossary로 용어 치환 (ko-KR -> en-US)
 * - POST /v1/glossary/update         : 세션 Glossary 강제 갱신
 * - GET  /healthz                   : 헬스체크
 *
 * (선택) MCP 엔드포인트도 유지 가능: /mcp
 * - 필요 없다면 /mcp 블록은 삭제해도 됨
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

if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is missing. Check env.");
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing. Check env.");

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

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// 단순 치환(긴 term 우선) + 중복치환 방지(placeholder)
function applyReplacements(text, pairs) {
  // pairs: [{ ko, en }]
  if (!text || pairs.length === 0) {
    return { output: text ?? "", hits: [] };
  }

  const source = String(text);
  const hits = [];
  const placeholders = [];

  // 1) ko 매칭된 부분을 placeholder로 치환
  let tmp = source;

  for (let i = 0; i < pairs.length; i++) {
    const { ko, en } = pairs[i];
    if (!ko) continue;

    // 전역 replace (정확 문자열 매칭)
    if (tmp.includes(ko)) {
      const ph = `[[G${i}]]`;
      tmp = tmp.split(ko).join(ph);
      placeholders.push({ ph, en, ko });
      hits.push({ ko, en });
    }
  }

  // 2) placeholder를 en으로 복원
  let out = tmp;
  for (const p of placeholders) {
    out = out.split(p.ph).join(p.en);
  }

  return { output: out, hits };
}

// ---------------- Sheets Reader (I:U only) ----------------
async function readGlossaryIU() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // ✅ I~U만 읽음
  const range = `${SHEET_NAME}!I:U`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return { header: [], data: [] };

  const headerRaw = rows[0].map((h) => String(h ?? "").trim());
  const header = headerRaw.map(normalizeHeader);
  const body = rows.slice(1);

  // 스크린샷 기준: I=분류, ... T=LEN, U=TERM (대소문자/위치 변동 가능)
  const idx = {
    category: header.indexOf("분류"),
    term: header.indexOf("term"),
    len: header.indexOf("len"),
  };

  if (idx.term < 0) {
    throw new Error(
      "I:U 범위 헤더에 TERM(또는 term)이 없습니다. U열 헤더가 'TERM'인지 확인하세요."
    );
  }

  // 언어 컬럼 인덱스 맵: 예) ko-kr, en-us ...
  const langIndex = {};
  for (let i = 0; i < header.length; i++) {
    if (i === idx.term || i === idx.len || i === idx.category) continue;

    const h = header[i];
    if (!h) continue;

    // 너무 엄격히 제한하지 않고 locale 형태(ko-kr 등)면 언어 컬럼로 인정
    // 필요 시 제외 목록을 확장 가능
    if (/^[a-z]{2}(-[a-z]{2})?$/.test(h) || /^[a-z]{2}-[a-z]{2}$/.test(h)) {
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
    .filter((x) => x.term);

  return { header: headerRaw, data };
}

// ---------------- Session-Scoped Glossary Cache ----------------
/**
 * 세션별 캐시 구조:
 * sessions.get(sessionId) = {
 *   createdAt,
 *   updatedAt,
 *   category,
 *   sourceLang,
 *   targetLang,
 *   glossaryVersion, // 업데이트 시각 기반
 *   map,             // Map<ko, en>
 *   pairsSorted      // [{ko,en}] 길이 내림차순 정렬 (치환용)
 * }
 */
const sessions = new Map();

function buildGlossaryMap(rows, category, sourceLang, targetLang) {
  const cat = normalizeCategory(category);
  const src = normalizeLang(sourceLang);
  const tgt = normalizeLang(targetLang);

  // category가 비어있으면 전체 대상으로 하되, 실무에서는 category를 권장
  const filtered = rows.filter((r) => {
    if (!cat) return true;
    return normalizeCategory(r.category) === cat;
  });

  const map = new Map();

  for (const r of filtered) {
    const ko = String(r.translations?.[src] ?? "").trim();
    const en = String(r.translations?.[tgt] ?? "").trim();
    if (!ko || !en) continue;

    // 동일 ko가 중복될 경우: 먼저 들어온 것을 유지(정책 필요 시 변경)
    if (!map.has(ko)) map.set(ko, en);
  }

  // 긴 용어 우선 치환(부분 매칭/중첩 치환 감소)
  const pairsSorted = [...map.entries()]
    .map(([ko, en]) => ({ ko, en }))
    .sort((a, b) => b.ko.length - a.ko.length);

  return { map, pairsSorted, count: pairsSorted.length };
}

async function loadSessionGlossary(sessionId, { category, sourceLang, targetLang }) {
  const { data } = await readGlossaryIU();

  const built = buildGlossaryMap(data, category, sourceLang, targetLang);

  const session = {
    createdAt: sessions.get(sessionId)?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    category: category ?? "",
    sourceLang: normalizeLang(sourceLang),
    targetLang: normalizeLang(targetLang),
    glossaryVersion: sha1(`${nowIso()}|${category}|${sourceLang}|${targetLang}`),
    map: built.map,
    pairsSorted: built.pairsSorted,
    termCount: built.count,
  };

  sessions.set(sessionId, session);
  return session;
}

function requireSession(req, res) {
  const sessionId =
    req.headers["x-session-id"] ||
    req.body?.sessionId ||
    req.query?.sessionId;

  if (!sessionId) {
    res.status(400).json({ error: "Missing sessionId. Provide X-Session-Id header or body.sessionId." });
    return null;
  }

  const s = sessions.get(String(sessionId));
  if (!s) {
    res.status(404).json({ error: "Unknown sessionId. Call /v1/session/init first." });
    return null;
  }

  return { sessionId: String(sessionId), session: s };
}

// ---------------- Express App ----------------
const app = express();
app.use(express.json({ limit: "5mb", type: ["application/json", "application/*+json"] }));
app.use(express.text({ limit: "5mb", type: ["text/*"] }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// 1) 세션 생성 + Glossary 1회 로드
app.post("/v1/session/init", async (req, res) => {
  const schema = z.object({
    category: z.string().optional().default(""),
    sourceLang: z.string().optional().default("ko-KR"),
    targetLang: z.string().optional().default("en-US"),
    sessionId: z.string().optional(), // 외부에서 지정하고 싶으면 허용
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

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
      updatedAt: session.updatedAt,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// 2) Glossary 업데이트(명시적 갱신)
app.post("/v1/glossary/update", async (req, res) => {
  const schema = z.object({
    sessionId: z.string(),
    // 변경 없이 단순 갱신도 가능. 필요하면 아래 값 생략
    category: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLang: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

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
      updatedAt: session.updatedAt,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// 3) 대량 치환(Phase 1: Glossary Lock only)
app.post("/v1/translate/replace", async (req, res) => {
  const schema = z.object({
    sessionId: z.string(),
    texts: z.array(z.string()).min(1).max(200), // 대화형 UX 기준: 50줄은 무난
    // 출력 형식 옵션
    limit: z.number().int().min(1).max(200).optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { sessionId, texts } = parsed.data;
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: "Unknown sessionId. Call /v1/session/init first." });

  const limit = parsed.data.limit ?? texts.length;
  const sliced = texts.slice(0, limit);

  const results = [];
  const missing = new Set();

  // 치환은 pairsSorted(긴 term 우선)로 수행
  for (const t of sliced) {
    const { output, hits } = applyReplacements(t, s.pairsSorted);

    // “특이사항(미등록 용어)”을 완벽히 하려면 NER/토크나이즈가 필요하지만,
    // 여기서는 “치환 히트가 0인 문장”에 대해 알림 수준으로만 수집
    if ((hits?.length ?? 0) === 0) {
      // 문장 전체를 missing으로 잡으면 노이즈가 크니, 일단 문장 인덱스만 표시하도록 둠
      missing.add("(no glossary hit in some lines)");
    }

    results.push({
      input: t,
      output,
      replacements: hits, // 치환된 용어만 기록
    });
  }

  return res.status(200).json({
    sessionId,
    glossaryVersion: s.glossaryVersion,
    category: s.category,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    results,
    notes: missing.size ? [...missing] : [],
  });
});

// ---------------- (선택) MCP 유지: /mcp ----------------
// 기존 ChatGPT MCP 연결을 계속 쓸 경우에만 사용하세요.
const mcp = new McpServer({ name: "sheets-glossary-mcp", version: "1.0.0" });

// MCP에서 “세션 초기화”를 노출하고 싶으면 도구 추가 가능 (옵션)
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
              updatedAt: session.updatedAt,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// MCP에서 “대량 치환” 도구(옵션)
mcp.tool(
  "replace_batch",
  {
    sessionId: z.string(),
    texts: z.array(z.string()).min(1).max(200),
  },
  async ({ sessionId, texts }) => {
    const s = sessions.get(sessionId);
    if (!s) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Unknown sessionId" }, null, 2) }],
      };
    }

    const results = texts.map((t) => {
      const { output, hits } = applyReplacements(t, s.pairsSorted);
      return { input: t, output, replacements: hits };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionId,
              glossaryVersion: s.glossaryVersion,
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// MCP 엔드포인트
app.all("/mcp", async (req, res) => {
  // body 파싱
  let body = req.body;
  if (typeof body === "string") body = safeJsonParse(body, body);

  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => transport.close());

  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
