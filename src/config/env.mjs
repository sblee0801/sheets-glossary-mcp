/**
 * src/config/env.mjs
 * - 환경변수 로딩/검증/기본값 정의
 * - 다른 모듈에서 import 해서 사용
 *
 * 주의:
 * - dotenv는 server.mjs에서 import "dotenv/config"로 1회만 로드하는 것을 권장
 * - 본 파일은 process.env 값을 읽기만 한다.
 */

export const PORT = Number(process.env.PORT || 8080);

export const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
export const SHEET_NAME = process.env.SHEET_NAME || "Glossary";

/**
 * ✅ TERM(V열) 무시 → A:U만 읽음 (기본)
 * (환경변수로 덮어쓸 수 있게 유지)
 */
export const SHEET_RANGE =
  process.env.SHEET_RANGE || `${SHEET_NAME}!A:U`;

// Phase 1.5 Rules sheet (separate from Glossary)
export const RULE_SHEET_NAME = process.env.RULE_SHEET_NAME || "Rules";
export const RULE_SHEET_RANGE =
  process.env.RULE_SHEET_RANGE || `${RULE_SHEET_NAME}!A:U`;

/**
 * Google Service Account JSON
 * - Cloud Run에서는 보통 env로 주입
 */
export const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

/**
 * 앱 시작 시 필수 env 검증
 * - server.mjs에서 1회 호출
 */
export function assertRequiredEnv() {
  if (!SPREADSHEET_ID) {
    throw new Error("SPREADSHEET_ID is missing. Check env.");
  }
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing. Check env.");
  }
}
