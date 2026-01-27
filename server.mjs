/**
 * server.mjs (ENTRY)
 * - Express 앱 생성 + 미들웨어 설정
 * - REST 라우트 등록
 * - MCP 엔드포인트 등록
 * - listen + 부팅 로그
 */

import "dotenv/config";
import express from "express";

import {
  PORT,
  SHEET_RANGE,
  RULE_SHEET_RANGE,
  assertRequiredEnv,
} from "./src/config/env.mjs";

import { registerRoutes } from "./src/http/routes.mjs";
import { registerMcp } from "./src/mcp/index.mjs";

// ---- boot-time env validation ----
assertRequiredEnv();

// ---- app ----
const app = express();

/**
 * ✅ 변경 포인트 (유일)
 * - 대용량 마스킹 / batch apply 대비
 * - 기본 32mb, 필요 시 env BODY_LIMIT로 조절
 *
 * 예:
 *   BODY_LIMIT=16mb
 *   BODY_LIMIT=64mb
 */
const BODY_LIMIT = process.env.BODY_LIMIT || "32mb";

app.use(
  express.json({
    limit: BODY_LIMIT,
    type: ["application/json", "application/*+json"],
  })
);

app.use(
  express.text({
    limit: BODY_LIMIT,
    type: ["text/*"],
  })
);

// ---- register endpoints ----
registerRoutes(app);
registerMcp(app);

// ---- start ----
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`Body limit: ${BODY_LIMIT}`);
  console.log(`Sheet range: ${SHEET_RANGE} (TERM ignored)`);
  console.log(`Rule range: ${RULE_SHEET_RANGE}`);
  console.log(
    `REST: /v1/session/init, /v1/translate/replace, /v1/translate/mask, /v1/translate/mask/apply, /v1/glossary/update, /v1/glossary/pending/next, /v1/glossary/qa/next, /v1/glossary/apply`
  );
  console.log(`MCP: /mcp (replace_texts, glossary_update)`);
});
