/**
 * server.mjs (ENTRY)
 * - Express 앱 생성 + 미들웨어 설정
 * - REST 라우트 등록
 * - (MCP 제거) CustomGPT Actions(OpenAPI) 기반 REST만 사용
 * - 응답 크기 가드(커넥터 ResponseTooLarge 사전 차단)
 * - 응답 바이트 로깅(어느 엔드포인트가 폭주하는지 즉시 확정)
 */

import "dotenv/config";
import express from "express";

import { PORT, SHEET_RANGE, RULE_SHEET_RANGE, assertRequiredEnv } from "./src/config/env.mjs";
import { registerRoutes } from "./src/http/routes.mjs";

// ---- boot-time env validation ----
assertRequiredEnv();

// ---- env knobs ----
// 요청 바디 제한(서버가 받는 입력 제한)
const BODY_LIMIT = process.env.BODY_LIMIT ?? "8mb";

// 커넥터/Actions 쪽은 "응답"이 너무 크면 죽는다.
// 서버에서 미리 컷해서 작은 에러(JSON)로 돌려주기 위한 제한.
const RESPONSE_LIMIT_KB = Number(process.env.RESPONSE_LIMIT_KB ?? "900"); // 기본 900KB
const RESPONSE_LIMIT_BYTES = Math.max(50 * 1024, RESPONSE_LIMIT_KB * 1024); // 최소 50KB 안전장치

// ---- app ----
const app = express();

app.use(
  express.json({
    limit: BODY_LIMIT,
    type: ["application/json", "application/*+json"],
  })
);
app.use(express.text({ limit: BODY_LIMIT, type: ["text/*"] }));

/**
 * Response size guard + logging
 * - res.json / res.send payload 바이트를 계산해 상한 초과 시 "작은 에러"로 대체
 * - 어떤 path가 얼마나 큰 응답을 만들었는지 로그로 고정
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
      // object / array
      return Buffer.byteLength(JSON.stringify(payload), "utf8");
    } catch {
      // 최악의 경우를 대비
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
          "Server response exceeded safe limit for CustomGPT Actions. Reduce payload (e.g., return only matched mask ids, not full glossary/masks).",
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
            "Server response exceeded safe limit for CustomGPT Actions. Reduce payload (e.g., return only matched mask ids, not full glossary/masks).",
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

// ---- register endpoints (REST only) ----
registerRoutes(app);

// ---- start ----
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`Sheet range: ${SHEET_RANGE} (TERM ignored)`);
  console.log(`Rule range: ${RULE_SHEET_RANGE}`);
  console.log(`BODY_LIMIT=${BODY_LIMIT}`);
  console.log(`RESPONSE_LIMIT_KB=${RESPONSE_LIMIT_KB} (guard enabled)`);
  console.log(
    `REST: /v1/session/init, /v1/translate/replace, /v1/translate/mask, /v1/translate/mask/apply, /v1/glossary/*, /v1/rules/* (per your routes.mjs)`
  );
});
