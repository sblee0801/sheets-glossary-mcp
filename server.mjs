import "dotenv/config";
import express from "express";
import { google } from "googleapis";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT || 8080);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Glossary";

if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is missing. Check env.");
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing. Check env.");

// ---------------- Helpers ----------------
function normalize(h) {
  return String(h ?? "").trim().toLowerCase();
}

function getParsedBody(req) {
  if (req.body == null) return undefined;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return req.body;
    }
  }
  return req.body;
}

/**
 * lang 문자열을 시트 헤더 형태로 정규화 (예: "ko", "ko-kr", "ko_KR" -> "ko-kr")
 */
function normalizeLang(lang) {
  if (!lang) return "";
  return String(lang).trim().toLowerCase().replace("_", "-");
}

/**
 * I~U 범위에서 language 컬럼 후보를 반환 (분류/len/term/notes 제외)
 */
function isLanguageHeader(h) {
  const x = normalize(h);
  if (!x) return false;
  // 제외 목록: 분류/term/len/notes/비고성 컬럼(프로젝트 상황에 맞춰 추가 가능)
  const excluded = new Set([
    "분류",
    "category",
    "term",
    "len",
    "length",
    "note",
    "notes",
    "번역메모",
    "클리펀트",
  ]);
  if (excluded.has(x)) return false;

  // 언어 컬럼은 보통 ko-kr, en-us, zh-cn 같은 형태이거나 locale 코드
  // 너무 엄격히 제한하지 않고, 제외 목록에만 걸리지 않으면 후보로 둠
  return true;
}

// ---------------- Google Sheets (I~U only) ----------------
async function readGlossaryIU() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // ✅ 핵심: I~U만 읽음
  const range = `${SHEET_NAME}!I:U`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return { header: [], data: [] };

  const header = rows[0].map((h) => String(h ?? "").trim());
  const body = rows.slice(1);

  // I~U 내부에 있는 헤더만으로 매핑
  const normHeader = header.map(normalize);

  // 스크린샷 기준: I=분류, J=ko-KR, ... T=LEN, U=TERM
  const idx = {
    category: normHeader.indexOf("분류"),
    term: normHeader.indexOf("term"), // "TERM"
    len: normHeader.indexOf("len"),   // "LEN"
    notes: normHeader.indexOf("note") >= 0 ? normHeader.indexOf("note") : normHeader.indexOf("notes"),
  };

  // 최소 요구: TERM, 분류는 없어도 동작하게(필터만 못 함)
  if (idx.term < 0) {
    throw new Error(
      "I:U 범위 헤더에 TERM(또는 term)이 없습니다. U열 헤더가 'TERM'인지 확인하세요."
    );
  }

  // 언어 컬럼 인덱스 맵 생성
  const langIndex = {};
  for (let i = 0; i < normHeader.length; i++) {
    const hRaw = header[i];
    const hNorm = normHeader[i];

    // TERM/LEN/분류/notes류는 제외하고 언어 후보만
    if (i === idx.term || i === idx.len || i === idx.category) continue;
    if (hNorm === "note" || hNorm === "notes" || hNorm === "번역메모" || hNorm === "클리펀트") continue;

    if (isLanguageHeader(hRaw)) {
      langIndex[hNorm] = i;
    }
  }

  const data = body
    .map((r) => {
      const term = String(r[idx.term] ?? "").trim();
      const category = idx.category >= 0 ? String(r[idx.category] ?? "").trim() : "";
      const len = idx.len >= 0 ? String(r[idx.len] ?? "").trim() : "";
      const notes =
        idx.notes >= 0 ? String(r[idx.notes] ?? "").trim() : "";

      // 언어별 값
      const translations = {};
      for (const [langKey, colIdx] of Object.entries(langIndex)) {
        const v = String(r[colIdx] ?? "").trim();
        if (v) translations[langKey] = v;
      }

      return { term, category, len, notes, translations };
    })
    .filter((x) => x.term); // term 없는 행 제거

  return { header, data };
}

// ---------------- MCP Server ----------------
const mcp = new McpServer({
  name: "sheets-glossary-mcp",
  version: "0.4.0",
});

/**
 * ✅ get_glossary
 * - category(=분류)로 필터 가능
 * - lang 지정 시 해당 언어 번역만 반환 (예: ko-kr, en-us)
 * - lang 미지정 시 I~U에 있는 언어 컬럼을 가능한 한 모두 반환
 */
mcp.tool(
  "get_glossary",
  {
    category: z.string().optional(), // 분류 필터
    lang: z.string().optional(),     // "ko-KR" 등
  },
  async ({ category, lang }) => {
    const { data } = await readGlossaryIU();

    const cat = category ? String(category).trim().toLowerCase() : "";
    const langKey = lang ? normalizeLang(lang) : "";

    const filtered = data.filter((row) => {
      if (!cat) return true;
      return String(row.category ?? "").trim().toLowerCase() === cat;
    });

    const out = filtered.map((row) => {
      if (!langKey) {
        // 언어 미지정: 가능한 번역 전체 반환
        return {
          term: row.term,
          category: row.category || undefined,
          len: row.len || undefined,
          notes: row.notes || undefined,
          translations: row.translations,
        };
      }

      // 언어 지정: 해당 언어만(없으면 빈 문자열)
      return {
        term: row.term,
        category: row.category || undefined,
        len: row.len || undefined,
        notes: row.notes || undefined,
        translation: row.translations?.[langKey] ?? "",
        lang: langKey,
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

/**
 * ✅ lookup_term
 * - term(=TERM) 정확 일치 조회
 * - category(=분류) 옵션 필터
 * - lang 지정 시 해당 언어만
 */
mcp.tool(
  "lookup_term",
  {
    term: z.string(),
    category: z.string().optional(),
    lang: z.string().optional(),
  },
  async ({ term, category, lang }) => {
    const { data } = await readGlossaryIU();

    const t = String(term).trim().toLowerCase();
    const cat = category ? String(category).trim().toLowerCase() : "";
    const langKey = lang ? normalizeLang(lang) : "";

    const hit = data.find((row) => {
      if (String(row.term).trim().toLowerCase() !== t) return false;
      if (!cat) return true;
      return String(row.category ?? "").trim().toLowerCase() === cat;
    });

    const result = !hit
      ? null
      : !langKey
        ? {
            term: hit.term,
            category: hit.category || undefined,
            len: hit.len || undefined,
            notes: hit.notes || undefined,
            translations: hit.translations,
          }
        : {
            term: hit.term,
            category: hit.category || undefined,
            len: hit.len || undefined,
            notes: hit.notes || undefined,
            lang: langKey,
            translation: hit.translations?.[langKey] ?? "",
          };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { found: Boolean(hit), result },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---------------- HTTP App ----------------
const app = express();

app.use(
  express.json({
    limit: "2mb",
    type: ["application/json", "application/*+json"],
  })
);
app.use(express.text({ limit: "2mb", type: ["text/*"] }));

// MCP endpoint
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
  });

  await mcp.connect(transport);

  const body = getParsedBody(req);
  await transport.handleRequest(req, res, body);
});

// health check
app.get("/", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`MCP server listening on :${PORT} (endpoint: /mcp)`);
});
