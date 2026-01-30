/**
 * src/config/env.mjs
 * - 환경변수 로딩/검증/기본값 정의
 *
 * ✅ 중요(호환성):
 * - 기존 코드가 import 하는 export를 반드시 제공해야 함:
 *   - DEFAULT_SHEET_NAME
 *   - buildSheetRange
 *
 * ✅ 포함:
 * - Google Sheets (spreadsheet / ranges)
 * - OpenAI (Responses API) for server-side translation
 * - optional feature gate: ENABLE_OPENAI_TRANSLATION
 */

export const PORT = Number(process.env.PORT || 8080);

// ---------------- Google Sheets ----------------
export const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// 기존 코드 호환용: DEFAULT_SHEET_NAME export 필요
export const DEFAULT_SHEET_NAME = process.env.SHEET_NAME || "Glossary";

// 기존 코드에서도 사용할 수 있게 동일 의미로 제공
export const SHEET_NAME = DEFAULT_SHEET_NAME;

/**
 * ✅ buildSheetRange (호환성 필수)
 * - buildSheetRange("Glossary") => "Glossary!A:U"
 * - buildSheetRange("Trans5", "A:Z") => "Trans5!A:Z"
 * - buildSheetRange("Trans5!A:Z") => 이미 ! 포함이면 그대로 보정
 */
export function buildSheetRange(sheetName, a1Range = "A:U") {
  const s = String(sheetName ?? DEFAULT_SHEET_NAME).trim() || DEFAULT_SHEET_NAME;
  const r = String(a1Range ?? "A:U").trim() || "A:U";

  // 이미 "Sheet!A:Z" 형태로 들어오면 그대로
  if (s.includes("!")) return s;

  // range가 "!A:U" 같이 들어오면 보정
  const rr = r.startsWith("!") ? r.slice(1) : r;

  return `${s}!${rr}`;
}

/**
 * ✅ TERM(V열) 무시 → A:U만 읽음 (기본)
 * 필요 시 env로 변경 가능
 */
export const SHEET_RANGE = process.env.SHEET_RANGE || buildSheetRange(DEFAULT_SHEET_NAME, "A:U");

// Rules sheet
export const RULE_SHEET_NAME = process.env.RULE_SHEET_NAME || "Rules";
export const RULE_SHEET_RANGE = process.env.RULE_SHEET_RANGE || buildSheetRange(RULE_SHEET_NAME, "A:U");

/**
 * Google Service Account JSON (stringified)
 */
export const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// ---------------- OpenAI (Server-side translation) ----------------

/**
 * 기능 스위치
 * - true일 때 /v1/translate/auto 사용을 전제로 필수 env 검증 강화
 */
export const ENABLE_OPENAI_TRANSLATION = String(process.env.ENABLE_OPENAI_TRANSLATION || "false")
  .trim()
  .toLowerCase() === "true";

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

/**
 * 모델 기본값 (네 의도: GPT-4.1)
 */
export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

/**
 * 타임아웃/재시도/청크
 */
export const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 60_000);
export const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES ?? 3);
export const OPENAI_CHUNK_SIZE = Number(process.env.OPENAI_CHUNK_SIZE ?? 25);

/**
 * 서버 request 가드(선택)
 */
export const MAX_TEXTS_PER_REQUEST = Number(process.env.MAX_TEXTS_PER_REQUEST ?? 500);

// ---------------- Diagnostics / misc ----------------
export const NODE_ENV = process.env.NODE_ENV || "production";

/**
 * 앱 시작 시 필수 env 검증
 * - server.mjs에서 1회 호출 권장
 */
export function assertRequiredEnv() {
  if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is missing. Check env.");
  if (!GOOGLE_SERVICE_ACCOUNT_JSON)
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing. Check env.");

  if (ENABLE_OPENAI_TRANSLATION) {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing. Check env.");
  }
}
