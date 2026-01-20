/**
 * src/google/sheets.mjs
 * - Google Sheets API client (Read/Write)
 * - readSheetRange(range): values.get
 * - batchUpdateValuesA1(updates): values.batchUpdate
 */

import { google } from "googleapis";
import {
  SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
} from "../config/env.mjs";

// ---------------- Helpers ----------------
export function colIndexToA1(colIndex0) {
  // 0 -> A, 1 -> B ...
  let n = Number(colIndex0) + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------- Google Sheets Client (cached) ----------------
let _sheetsClient = null;

export function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;

  const serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    // ✅ Write 지원 스코프
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  _sheetsClient = sheets;
  return sheets;
}

// ---------------- Google Sheets Read (Generic) ----------------
export async function readSheetRange(range) {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const values = res.data.values || [];
  if (values.length < 1) return { header: [], rows: [] };

  const header = (values[0] || []).map((h) => String(h ?? "").trim());
  const rows = values.slice(1);

  return { header, rows };
}

// ---------------- Google Sheets Write (Batch A1) ----------------
export async function batchUpdateValuesA1(updates) {
  // updates: [{ range: "Glossary!K12", values: [[...]] }]
  const sheets = getSheetsClient();

  if (!updates || updates.length === 0) {
    return { updatedCells: 0, updatedRanges: [] };
  }

  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: updates,
    },
  });

  const totalUpdatedCells = res.data.totalUpdatedCells ?? 0;
  const updatedRanges = (res.data.responses || [])
    .map((r) => r.updatedRange)
    .filter(Boolean);

  return { updatedCells: totalUpdatedCells, updatedRanges };
}
