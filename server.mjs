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

// ---------- Helpers ----------
function normalize(h) {
  return String(h ?? "").trim().toLowerCase();
}

function getParsedBody(req) {
  // express.json()이면 object, express.text()이면 string일 수 있음
  if (req.body == null) return undefined;

  if (typeof req.body === "string") {
    // text로 들어온 JSON일 수 있으므로 파싱 시도
    try {
      return JSON.parse(req.body);
    } catch {
      return req.body;
    }
  }
  return req.body;
}

// ---------- Google Sheets ----------
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

// ---------- MCP Server ----------
const mcp = new McpServer({
  name: "sheets-glossary-mcp",
  version: "0.3.0",
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

// (선택) 빠른 단일 용어 조회 도구
mcp.tool(
  "lookup_term",
  { term: z.string(), domain: z.string().optional() },
  async ({ term, domain }) => {
    const rows = await readGlossary();
    const t = term.trim().toLowerCase();

    const hit = rows.find((r) => {
      if (r.status.toLowerCase() !== "approved") return false;
      if (r.term.trim().toLowerCase() !== t) return false;
      if (!domain) return true;
      return (r.domain || "").toLowerCase() === domain.toLowerCase();
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: Boolean(hit),
              result: hit
                ? {
                    term: hit.term,
                    translation: hit.translation,
                    domain: hit.domain || undefined,
                    notes: hit.notes || undefined,
                  }
                : null,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---------- HTTP App ----------
const app = express();

// JSON + text 모두 수용 (커넥터가 content-type을 다르게 보낼 수 있음)
app.use(
  express.json({
    limit: "2mb",
    type: ["application/json", "application/*+json"],
  })
);
app.use(express.text({ limit: "2mb", type: ["text/*"] }));

// MCP 엔드포인트: /mcp (GET/POST 모두 처리)
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

// 헬스체크(Cloud Run용)
app.get("/", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`MCP server listening on :${PORT} (endpoint: /mcp)`);
});
