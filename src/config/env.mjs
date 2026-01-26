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

// 기존 호환 유지: SHEET_NAME은 "기본 Glossary 시트명"으로만 사용
export const DEFAULT_SHEET_NAME = process.env.SHEET_NAME || "Glossary";

/**
 * ✅ 기존 호환 유지용
 * - 예전 코드가 SHEET_RANGE를 직접 쓰는 경우를 위해 남겨둔다.
 * - 다중 시트 지원 이후에는, loadGlossaryAll({ sheetName })가 sheetName에 맞는 range를 생성한다.
 */
export const SHEET_RANGE = process.env.SHEET_RANGE || `${DEFAULT_SHEET_NAME}!A:Z`;

// Phase 1.5 Rules sheet (separate from Glossary)
export const RULE_SHEET_NAME = process.env.RULE_SHEET_NAME || "Rules";
export const RULE_SHEET_RANGE = process.env.RULE_SHEET_RANGE || `${RULE_SHEET_NAME}!A:Z`;

/**
 * Google Service Account JSON
 * - Cloud Run에서는 보통 env로 주입
 */
export const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

/**
 * ✅ 시트별 기본 Range 생성 (Glossary형 vs Trans형)
 * - Trans1~5: A:H 고정 (ID + 언어 컬럼)
 * - 그 외: A:U (기존 Glossary 규격 유지)
 *
 * 필요 시, DEFAULT_SHEET_NAME에 대해서는 env.SHEET_RANGE로 override 가능(기존 유지).
 */
export function buildSheetRange(sheetName) {
  const sn = String(sheetName ?? "").trim() || DEFAULT_SHEET_NAME;

  // 기존 호환: 기본 시트는 SHEET_RANGE override 허용
  if (sn === DEFAULT_SHEET_NAME && process.env.SHEET_RANGE) {
    return process.env.SHEET_RANGE;
  }

  const isTrans = /^trans\d+$/i.test(sn);
  return `${sn}!${isTrans ? "A:Z" : "A:Z"}`;
}

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
