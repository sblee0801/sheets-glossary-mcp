import "dotenv/config";
import { google } from "googleapis";
import { z } from "zod";

import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// ===== 환경변수 =====
const SPREADSHEET_ID = process.env.SPREADSHEET_ID!;
const SHEET_NAME = process.env.SHEET_NAME || "Glossary";

// ===== Google Sheets Client =====
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

// ===== Glossary Row 처리 =====
function normalize(h: string) {
  return h.trim().toLowerCase();
}

async function readGlossary() {
  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!A:Z`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => normalize(String(h)));
  const body = rows.slice(1);

  const idx = {
    term: header.indexOf("term"),
    translation: header.indexOf("translation"),
    status: header.indexOf("status"),
    domain: header.indexOf("domain"),
    notes: header.indexOf("notes"),
  };

  return body.map((r) => ({
    term: r[idx.term],
    translation: r[idx.translation],
    status: r[idx.status],
    domain: idx.domain >= 0 ? r[idx.domain] : "",
    notes: idx.notes >= 0 ? r[idx.notes] : "",
  }));
}

// ===== MCP 서버 =====
const server = new McpServer({
  name: "sheets-glossary-mcp",
  version: "0.1.0",
});

// Tool: get_glossary
server.tool(
  "get_glossary",
  {
    domain: z.string().optional(),
  },
  async ({ domain }) => {
    const rows = await readGlossary();
    const result = rows.filter(
      (r) =>
        String(r.status).toLowerCase() === "approved" &&
        (!domain ||
          String(r.domain).toLowerCase() === domain.toLowerCase())
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ===== 실행 =====
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();