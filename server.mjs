import "dotenv/config";
import { google } from "googleapis";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Glossary";

if (!SPREADSHEET_ID) {
  throw new Error("SPREADSHEET_ID is missing. Check .env");
}

function normalize(h) {
  return String(h ?? "").trim().toLowerCase();
}

async function readGlossary() {
  const auth = new google.auth.GoogleAuth({
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

const server = new McpServer({
  name: "sheets-glossary-mcp",
  version: "0.1.0",
});

server.tool(
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
