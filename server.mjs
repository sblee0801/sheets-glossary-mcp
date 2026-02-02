/**
 * src/server.mjs (ENTRY)
 * - Express 앱 생성 + 미들웨어 설정
 * - REST 라우트 등록
 * - (MCP 제거) CustomGPT Actions(OpenAPI) 기반 REST만 사용
 * - 응답 크기 가드(커넥터 ResponseTooLarge 사전 차단)
 * - 응답 바이트 로깅
 */

import "dotenv/config";
import express from "express";

import { PORT, SHEET_RANGE, RULE_SHEET_RANGE, assertRequiredEnv } from "./config/env.mjs";
import { registerRoutes } from "./http/routes.mjs";

// ---- boot-time env validation ----
assertRequiredEnv();

// ---- env knobs ----
const BODY_LIMIT = process.env.BODY_LIMIT ?? "8mb";
const RESPONSE_LIMIT_KB = Number(process.env.RESPONSE_LIMIT_KB ?? "900");
const RESPONSE_LIMIT_BYTES = Math.max(50 * 1024, RESPONSE_LIMIT_KB * 1024);

// ---- app ----
const app = express();

// ---- parsers ----
app.use(
  express.json({
    limit: BODY_LIMIT,
    type: ["application/json", "application/*+json"],
  })
);
app.use(express.text({ limit: BODY_LIMIT, type: ["text/*"] }));

/**
 * CORS (CustomGPT/Connector 방어)
 * - Connector는 서버-서버라 CORS 불필요한 경우도 많지만,
 *   일부 환경에서 preflight(OPTIONS) 때문에 실패하는 케이스를 막음.
 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

/**
 * Response size guard + logging
 */
app.use((req, res, next) => {
  const startedAt = Date.now();

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  function byteLen(payload) {
    try {
      if (payload == null) return 0;
      if (Buffer.isBuffer(payload)) return payload.length;
      if (typeof payload === "string") return Buffer.byteLength(payload, "utf8");
      return Buffer.byteLength(JSON.stringify(payload), "utf8");
    } catch {
      return RESPONSE_LIMIT_BYTES + 1;
    }
  }

  function logSize(bytes, note = "") {
    const ms = Date.now() - startedAt;
    console.log(
      `[RESP] ${req.method} ${req.originalUrl} -> ${bytes} bytes (${Math.round(bytes / 1024)}KB) in ${ms}ms${
        note ? ` ${note}` : ""
      }`
    );
  }

  res.json = (payload) => {
    const bytes = byteLen(payload);

    if (bytes > RESPONSE_LIMIT_BYTES) {
      logSize(bytes, "[CUTOFF: json too large]");
      res.status(413);
      return originalJson({
        ok: false,
        error: "ResponseTooLarge",
        message:
          "Server response exceeded safe limit for CustomGPT Actions. Reduce payload size.",
        meta: {
          responseBytes: bytes,
          limitBytes: RESPONSE_LIMIT_BYTES,
          limitKB: RESPONSE_LIMIT_KB,
          method: req.method,
          path: req.originalUrl,
        },
      });
    }

    logSize(bytes);
    return originalJson(payload);
  };

  res.send = (payload) => {
    const bytes = byteLen(payload);

    if (bytes > RESPONSE_LIMIT_BYTES) {
      logSize(bytes, "[CUTOFF: send too large]");
      res.status(413);
      return originalSend(
        JSON.stringify({
          ok: false,
          error: "ResponseTooLarge",
          message:
            "Server response exceeded safe limit for CustomGPT Actions. Reduce payload size.",
          meta: {
            responseBytes: bytes,
            limitBytes: RESPONSE_LIMIT_BYTES,
            limitKB: RESPONSE_LIMIT_KB,
            method: req.method,
            path: req.originalUrl,
          },
        })
      );
    }

    logSize(bytes);
    return originalSend(payload);
  };

  next();
});

// ---- register endpoints ----
registerRoutes(app);

// ---- start ----
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`Sheet range: ${SHEET_RANGE} (TERM ignored)`);
  console.log(`Rule range: ${RULE_SHEET_RANGE}`);
  console.log(`BODY_LIMIT=${BODY_LIMIT}`);
  console.log(`RESPONSE_LIMIT_KB=${RESPONSE_LIMIT_KB} (guard enabled)`);
});
