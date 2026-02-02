/**
 * server.mjs (ENTRY)
 * - REST only (CustomGPT Actions/OpenAPI)
 * - ✅ Health/Healthz: no-store + ETag off + slash/alias/method 방어
 * - ✅ strict routing OFF (trailing slash 차이 제거)
 * - Response size guard 유지
 */

import "dotenv/config";
import express from "express";

import { PORT, SHEET_RANGE, RULE_SHEET_RANGE, assertRequiredEnv } from "./src/config/env.mjs";
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

// ✅ trailing slash 차이 제거 (중요)
app.set("strict routing", false);
app.set("case sensitive routing", false);

// ✅ 304 방지 (CustomGPT가 304를 실패로 볼 수 있음)
app.set("etag", false);

// (원하면 켜기) 요청이 실제 어떤 path/method로 오는지 로그
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  next();
});

// ✅ Health는 “가장 먼저” + “항상 200 + JSON 바디” + “캐시 금지”
const noStore = (res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  if (typeof res.removeHeader === "function") res.removeHeader("ETag");
};

const healthJson = (req, res) => {
  noStore(res);
  return res.status(200).json({
    ok: true,
    revision: process.env.K_REVISION ?? null,
    service: process.env.K_SERVICE ?? null,
    path: req.originalUrl,
  });
};

// ✅ 메서드/슬래시/프리픽스 변형 전부 허용
app.all("/health", healthJson);
app.all("/health/", healthJson);
app.all("/healthz", healthJson);
app.all("/healthz/", healthJson);
app.all("/v1/health", healthJson);
app.all("/v1/health/", healthJson);
app.all("/v1/healthz", healthJson);
app.all("/v1/healthz/", healthJson);

// root도 항상 살아있게
app.all("/", (_req, res) => {
  noStore(res);
  return res.status(200).send("ok");
});

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

// ---- register endpoints (REST only) ----
registerRoutes(app);

// ✅ 404 디버깅 핸들러 (항상 JSON)
app.use((req, res) => {
  noStore(res);
  res.status(404).json({
    ok: false,
    error: "NotFound",
    method: req.method,
    path: req.originalUrl,
  });
});

// ---- start ----
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`Sheet range: ${SHEET_RANGE} (TERM ignored)`);
  console.log(`Rule range: ${RULE_SHEET_RANGE}`);
  console.log(`BODY_LIMIT=${BODY_LIMIT}`);
  console.log(`RESPONSE_LIMIT_KB=${RESPONSE_LIMIT_KB} (guard enabled)`);
});
