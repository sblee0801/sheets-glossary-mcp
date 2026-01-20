/**
 * server.mjs (ENTRY)
 * - Express 앱 생성 + 미들웨어 설정
 * - REST 라우트 등록
 * - MCP 엔드포인트 등록
 * - listen + 부팅 로그
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

app.use(
  express.json({
    limit: "8mb",
    type: ["application/json", "application/*+json"],
  })
);
app.use(express.text({ limit: "8mb", type: ["text/*"] }));

// ---- register endpoints ----
registerRoutes(app);
registerMcp(app);

// ---- start ----
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`Sheet range: ${SHEET_RANGE} (TERM ignored)`);
  console.log(`Rule range: ${RULE_SHEET_RANGE}`);
  console.log(
    `REST: /v1/session/init, /v1/translate/replace(+logs, stateless ok, +ruleLogs), /v1/glossary/update(session optional), /v1/rules/update, /v1/glossary/suggest, /v1/glossary/candidates, /v1/glossary/apply, /v1/glossary/raw`
  );
  console.log(`MCP: /mcp (replace_texts, glossary_update)`);
});
