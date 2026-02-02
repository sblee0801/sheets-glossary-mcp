/**
 * server.mjs (ENTRY)
 * - REST only (CustomGPT Actions/OpenAPI)
 * - ✅ Health/Healthz: no-store + ETag off + slash/alias/method 방어
 * - ✅ Adds revision info (K_REVISION) to detect traffic mixing
 * - ✅ Adds /debug/echo to inspect what CustomGPT actually sends
 * - ✅ Listens on process.env.PORT first (Cloud Run)
 * - Response size guard 유지
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

// ✅ 304 방지
app.set("etag", false);

// ---- request log (필수: CustomGPT가 실제 어떤 method/path로 오는지 확인) ----
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  next();
});

// ---- body parsers ----
app.use(
  express.json({
    limit: BODY_LIMIT,
    type: ["application/json", "application/*+json"],
  })
);
app.use(express.text({ limit: BODY_LIMIT, type: ["text/*"] }));

// ---- Response size guard + logging ----
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

// ---- cache control helper ----
const noStore = (res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
};

// ✅ Health는 “무조건” 여기서 먼저 잡는다 (routes와 무관하게)
const healthJson = (_req, res) => {
  noStore(res);
  return res.status(200).json({
    ok: true,
    // ✅ 이게 핵심: /healthz 와 /healthz/ 가 같은 revision인지 확인 가능
    revision: process.env.K_REVISION || null,
    service: process.env.K_SERVICE || null,
  });
};

// 슬래시/프리픽스/메서드 변형 모두 허용
app.all(
  [
    "/health",
    "/health/",
    "/healthz",
    "/healthz/",
    "/v1/health",
    "/v1/health/",
    "/v1/healthz",
    "/v1/healthz/",
  ],
  healthJson
);

// root
app.get("/", (_req, res) => {
  noStore(res);
  return res.status(200).send("ok");
});

// ✅ CustomGPT가 뭘 보내는지 확인하는 에코(원인 확정용)
app.all("/debug/echo", (req, res) => {
  noStore(res);
  return res.status(200).json({
    ok: true,
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    // express.json/text 이후라 body가 여기서 보임
    body: req.body,
    revision: process.env.K_REVISION || null,
  });
});

// ---- register endpoints ----
registerRoutes(app);

// 404 디버깅
app.use((req, res) => {
  noStore(res);
  res.status(404).json({
    ok: false,
    error: "NotFound",
    method: req.method,
    path: req.originalUrl,
    revision: process.env.K_REVISION || null,
  });
});

// ---- start ----
// ✅ Cloud Run은 process.env.PORT 가 최우선
const port = Number(process.env.PORT || ENV_PORT || 8080);

app.listen(port, () => {
  console.log(`Server listening on :${port}`);
  console.log(`K_REVISION=${process.env.K_REVISION || ""}`);
  console.log(`Sheet range: ${SHEET_RANGE} (TERM ignored)`);
  console.log(`Rule range: ${RULE_SHEET_RANGE}`);
  console.log(`BODY_LIMIT=${BODY_LIMIT}`);
  console.log(`RESPONSE_LIMIT_KB=${RESPONSE_LIMIT_KB} (guard enabled)`);
});
