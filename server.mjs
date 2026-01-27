/**
 * server.mjs (ENTRY)
 * - Express 앱 생성 + 미들웨어 설정
 * - REST 라우트 등록
 * - MCP 엔드포인트 등록
 * - listen + 부팅 로그
 *
 * ✅ 2026-01 changes
 * - Increase body size limits for large batch operations (mask/apply, apply, etc.)
 * - Allow body limit override via env BODY_LIMIT (default: 32mb)
 */

import "dotenv/config";
import express from "express";

import { PORT, SHEET_RANGE, RULE_SHEET_RANGE, assertRequiredEnv } from "./src/config/env.mjs";
import { registerRoutes } from "./src/http/routes.mjs";
import { registerMcp } from "./src/mcp/index.mjs";

// ---- boot-time env validation ----
assertRequiredEnv();

// ---- app ----
const app = express();

// ✅ allow tuning via env
// examples: "16mb", "32mb", "64mb"
const BODY_LIMIT = process.env.BODY_LIMIT || "32mb";

// JSON
app.use(
  express.json({
    limit: BODY_LIMIT,
    type: ["application/json", "application/*+json"],
  })
);

// TEXT (MCP / misc)
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
    `REST: /health, /healthz, /v1/session/init, /v1/translate/replace, /v1/translate/mask, /v1/translate/mask/fromSheet, /v1/translate/mask/apply, /v1/glossary/update, /v1/rules/update, /v1/glossary/pending/next, /v1/glossary/apply`
  );
  console.log(`MCP: /mcp (replace_texts, glossary_update)`);
});
