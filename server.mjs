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

function normalize(h) {
  return String(h ?? "").trim().toLowerCase();
}

async function readGlossary() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const range = `${SHEET_NAME}!A:Z`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const header = rows[0].map(normalize);
  const body = rows.slice(1);

  const idx = {
    term: header.indexOf("term"),
    translation: header.indexOf("translation"),
    status: header.indexOf("status"),
    domain: header.indexOf("domain"),
    notes: header.indexOf("notes"),
  };

  if (idx.term < 0 || idx.translation < 0 || idx.status < 0) {
    throw new Error(
      "Sheet header must include: Term, Translation, Status (case-insensitive)."
    );
  }

  return body
    .map((r) => ({
      term: String(r[idx.term] ?? "").trim(),
      translation: String(r[idx.translation] ?? "").trim(),
      status: String(r[idx.status] ?? "").trim(),
      domain: idx.domain >= 0 ? String(r[idx.domain] ?? "").trim() : "",
      notes: idx.notes >= 0 ? String(r[idx.notes] ?? "").trim() : "",
    }))
    .filter((x) => x.term && x.translation && x.status);
}

// MCP 서버(도구 정의)
const mcp = new McpServer({
  name: "sheets-glossary-mcp",
  version: "0.2.0",
});

mcp.tool(
  "get_glossary",
  { domain: z.string().optional() },
  async ({ domain }) => {
    const rows = await readGlossary();
    const result = rows.filter((r) => {
      if (r.status.toLowerCase() !== "approved") return false;
      if (!domain) return true;
      return (r.domain || "").toLowerCase() === domain.toLowerCase();
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// HTTP 앱
const app = express();
app.use(express.json({ limit: "2mb" }));

// (최소한의) Origin 검증: 필요 시 환경변수로 확장 가능
const ALLOWED_ORIGINS = new Set([
  "https://chat.openai.com",
  "https://chatgpt.com",
]);

function assertOrigin(req, res) {
  const origin = req.headers.origin;
  // Origin이 없는 경우(서버-서버 호출 등)는 일단 허용
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  res.status(403).send("Forbidden origin");
  return false;
}

// MCP 엔드포인트: /mcp (GET/POST)
app.all("/mcp", async (req, res) => {
  if (!assertOrigin(req, res)) return;

  const transport = new StreamableHTTPServerTransport(req, res);
  await mcp.connect(transport);
});

// 헬스체크(Cloud Run용)
app.get("/", (req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  // stdout 로그는 Cloud Run에서 정상
  console.log(`MCP server listening on :${PORT} (endpoint: /mcp)`);
});
