/**
 * server.mjs (ENTRY)
 * - ✅ Health/Healthz: no-store + trailing slash + /v1 alias + HEAD/OPTIONS 모두 200
 * - ✅ ETag 비활성화 (304 방지)
 * - ✅ Cloud Run: process.env.PORT 우선 리슨
 * - Response size guard 유지
 */

import "dotenv/config";
import express from "express";

import { PORT, SHEET_RANGE, RULE_SHEET_RANGE, assertRequiredEnv } from "./src/config/env.mjs";
import { registerRoutes } from "./src/http/routes.mjs";

// ---- boot-time env validation ----
assertRequiredEnv();

const BODY_LIMIT = process.env.BODY_LIMIT ?? "8mb";
const RESPONSE_LIMIT_KB = Number(process.env.RESPONSE_LIMIT_KB ?? "900");
const RESPONSE_LIMIT_BYTES = Math.max(50 * 1024, RESPONSE_LIMIT_KB * 1024);

const app = express();
app.disable("x-powered-by");

// ✅ 304 방지: express 기본 ETag 때문에 브라우저/클라이언트가 If-None-Match 보내면 304가 나올 수 있음
app.set("etag", false);

// (선택) 요청이 어떻게 들어오는지 확인하고 싶으면 켜두기
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  next();
});

// ✅ Health는 제일 먼저, 무조건 200 + 바디 반환 (캐시 금지)
const health = (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return res.status(200).json({ ok: true });
};

// 슬래시/프리픽스/메서드 변형 전부 수용
app.all(
  ["/health", "/health/", "/healthz", "/healthz/", "/v1/health", "/v1/healthz", "/v1/healthz/"],
  health
);

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

// ---- register endpoints ----
registerRoutes(app);

// ✅ 디버깅용 404 JSON
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "NotFound", method: req.method, path: req.originalUrl });
});

// ---- start ----
// ✅ Cloud Run은 process.env.PORT가 진짜 포트
const port = Number(process.env.PORT || PORT || 8080);
app.listen(port, () => {
  console.log(`Server listening on :${port}`);
  console.log(`Sheet range: ${SHEET_RANGE}`);
  console.log(`Rule range: ${RULE_SHEET_RANGE}`);
  console.log(`BODY_LIMIT=${BODY_LIMIT}`);
  console.log(`RESPONSE_LIMIT_KB=${RESPONSE_LIMIT_KB} (guard enabled)`);
});
