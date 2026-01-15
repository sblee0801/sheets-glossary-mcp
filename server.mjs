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

/** "ko", "ko-kr", "ko_KR" -> "ko-kr" */
function normalizeLang(lang) {
  if (!lang) return "";
  return String(lang).trim().toLowerCase().replace(/_/g, "-");
}

/** I~U 범위에서 language 컬럼 후보를 반환 (분류/len/term/notes 제외) */
function isLanguageHeader(h) {
  const x = normalize(h);
  if (!x) return false;

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

  // ✅ I~U만 읽음
  const range = `${SHEET_NAME}!I:U`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return { header: [], data: [] };

  const header = rows[0].map((h) => String(h ?? "").trim());
  const body = rows.slice(1);

  const normHeader = header.map(normalize);

  // ✅ ko-KR 기준키(필수), TERM은 "있으면 보관" (비필수)
  const idx = {
    category: normHeader.indexOf("분류"),
    ko: normHeader.indexOf("ko-kr"),
    term: normHeader.indexOf("term"), // 있을 수도/없을 수도
    len: normHeader.indexOf("len"),
    notes:
      normHeader.indexOf("note") >= 0
        ? normHeader.indexOf("note")
        : normHeader.indexOf("notes"),
  };

  // ✅ 최소 요구: ko-KR은 반드시 있어야 함
  if (idx.ko < 0) {
    throw new Error(
      "I:U 범위 헤더에 ko-KR(또는 ko-kr)이 없습니다. ko-KR 컬럼 헤더를 확인하세요."
    );
  }

  // 언어 컬럼 인덱스 맵 생성 (분류/LEN/TERM/notes 제외)
  const langIndex = {};
  for (let i = 0; i < normHeader.length; i++) {
    const hRaw = header[i];
    const hNorm = normHeader[i];

    if (i === idx.len || i === idx.category) continue;
    if (idx.term >= 0 && i === idx.term) continue; // TERM은 있으면 제외(언어컬럼 아님)
    if (
      hNorm === "note" ||
      hNorm === "notes" ||
      hNorm === "번역메모" ||
      hNorm === "클리펀트"
    )
      continue;

    if (isLanguageHeader(hRaw)) {
      langIndex[hNorm] = i;
    }
  }

  const data = body
    .map((r) => {
      const ko = String(r[idx.ko] ?? "").trim();
      const term = idx.term >= 0 ? String(r[idx.term] ?? "").trim() : "";
      const category =
        idx.category >= 0 ? String(r[idx.category] ?? "").trim() : "";
      const len = idx.len >= 0 ? String(r[idx.len] ?? "").trim() : "";
      const notes = idx.notes >= 0 ? String(r[idx.notes] ?? "").trim() : "";

      const translations = {};
      for (const [langKey, colIdx] of Object.entries(langIndex)) {
        const v = String(r[colIdx] ?? "").trim();
        if (v) translations[langKey] = v;
      }

      // ko-kr은 기준키이므로 translations에 보장
      if (ko) translations["ko-kr"] = ko;

      return { ko, term, category, len, notes, translations };
    })
    .filter((x) => x.ko); // ✅ ko 없는 행 제거

  return { header, data };
}

// ---------------- MCP Server ----------------
const mcp = new McpServer({
  name: "sheets-glossary-mcp",
  version: "0.5.1",
});

/**
 * get_glossary
 * - category(=분류) 필터
 * - lang 지정 시 해당 언어만 반환
 * - lang 미지정 시 가능한 모든 언어 반환
 * - ✅ ko(=ko-KR)를 기준키로 항상 포함
 */
mcp.tool(
  "get_glossary",
  {
    category: z.string().optional(),
    lang: z.string().optional(),
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
        return {
          ko: row.ko,
          term: row.term || undefined,
          category: row.category || undefined,
          len: row.len || undefined,
          notes: row.notes || undefined,
          translations: row.translations,
        };
      }

      return {
        ko: row.ko,
        term: row.term || undefined,
        category: row.category || undefined,
        len: row.len || undefined,
        notes: row.notes || undefined,
        lang: langKey,
        translation: row.translations?.[langKey] ?? "",
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  }
);

/**
 * lookup_term (호환 유지)
 * - term 파라미터를 "TERM"이 아니라 ✅ "ko-KR 원문"으로 간주해서 조회
 */
mcp.tool(
  "lookup_term",
  {
    term: z.string(), // ✅ ko-KR 텍스트
    category: z.string().optional(),
    lang: z.string().optional(),
  },
  async ({ term, category, lang }) => {
    const { data } = await readGlossaryIU();

    const keyKo = String(term).trim().toLowerCase();
    const cat = category ? String(category).trim().toLowerCase() : "";
    const langKey = lang ? normalizeLang(lang) : "";

    const hit = data.find((row) => {
      if (String(row.ko).trim().toLowerCase() !== keyKo) return false;
      if (!cat) return true;
      return String(row.category ?? "").trim().toLowerCase() === cat;
    });

    const result = !hit
      ? null
      : !langKey
        ? {
            ko: hit.ko,
            term: hit.term || undefined,
            category: hit.category || undefined,
            len: hit.len || undefined,
            notes: hit.notes || undefined,
            translations: hit.translations,
          }
        : {
            ko: hit.ko,
            term: hit.term || undefined,
            category: hit.category || undefined,
            len: hit.len || undefined,
            notes: hit.notes || undefined,
            lang: langKey,
            translation: hit.translations?.[langKey] ?? "",
          };

    return {
      content: [{ type: "text", text: JSON.stringify({ found: Boolean(hit), result }, null, 2) }],
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

app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  res.on("close", () => transport.close());

  await mcp.connect(transport);

  const body = getParsedBody(req);
  await transport.handleRequest(req, res, body);
});

// health check
app.get("/", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`MCP server listening on :${PORT} (endpoint: /mcp)`);
});
