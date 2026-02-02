/**
 * server.mjs (ENTRY)
 * - Express 앱 생성 + 미들웨어 설정
 * - REST 라우트 등록
 * - 응답 크기 가드 + 응답 바이트 로깅
 * - ✅ Health/Healthz 강제 대응(프록시/CustomGPT 변형 호출 방어)
 * - ✅ 요청 method/path 로깅(문제 재현 즉시 원인 확정)
 */

import "dotenv/config";
import express from "express";

import { PORT as ENV_PORT, SHEET_RANGE, RULE_SHEET_RANGE, assertRequiredEnv } from "./src/config/env.mjs";
import { registerRoutes } from "./src/http/routes.mjs";

// ---- boot-time env validation ----
assertRequiredEnv();

// ---- env knobs ----
const BODY_LIMIT = process.env.BODY_LIMIT ?? "8mb";
const RESPONSE_LIMIT_KB = Number(process.env.RESPONSE_LIMIT_KB ?? "900");
const RESPONSE_LIMIT_BYTES = Math.max(50 * 1024, RESPONSE_LIMIT_KB * 1024);

// ---- app ----
const app = express();
app.disable("x-powered-by");

// ✅ (중요) CustomGPT/프록시가 이상한 method로 health 때리는지 바로 보이게
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  next();
});

/**
 * ✅ ALWAYS-ON health endpoints (가장 먼저 등록)
 * - /healthz/ 같이 슬래시 붙이거나
 * - /v1/healthz 로 프리픽스 붙이거나
 * - HEAD/OPTIONS 로 호출해도 무조건 200
 */
const healthHandler = (_req, res) => res.status(200).json({ ok: true });
app.all(
  ["/health", "/health/", "/healthz", "/healthz/", "/v1/health", "/v1/healthz", "/v1/healthz/"],
  healthHandler
);

// Root도 항상 살아있게
app.get("/", (_req, res) => res.status(200).send("ok"));

// ---- body parsers ----
app.use(
  express.json({
    limit: BODY_LIMIT,
    type: ["application/json", "application/*+json"],
  })
);
app.use(express.text({ limit: BODY_LIMIT, type: ["text/*"] }));

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
          "Server response exceeded safe limit for CustomGPT Actions. Reduce payload (e.g., smaller batches).",
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
          message: "Server response exceeded safe limit for CustomGPT Actions.",
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

// ---- register endpoints (REST) ----
registerRoutes(app);

// ✅ 마지막 404 핸들러(원인 추적용)
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "NotFound",
    method: req.method,
    path: req.originalUrl,
  });
});

// ---- start ----
// Cloud Run은 process.env.PORT가 “진짜” 포트임
const port = Number(process.env.PORT || ENV_PORT || 8080);

app.listen(port, () => {
  console.log(`Server listening on :${port}`);
  console.log(`Sheet range: ${SHEET_RANGE}`);
  console.log(`Rule range: ${RULE_SHEET_RANGE}`);
  console.log(`BODY_LIMIT=${BODY_LIMIT}`);
  console.log(`RESPONSE_LIMIT_KB=${RESPONSE_LIMIT_KB} (guard enabled)`);
});
