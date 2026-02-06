/**
 * server.mjs (ENTRY)
 * - Express app + middleware
 * - Response size guard (CustomGPT Actions 안정성)
 * - Route registration: v1 (QA) + v2 (batch translate)
 */

import "dotenv/config";
import express from "express";

import { PORT, assertRequiredEnv } from "./src/config/env.mjs";
import { registerRoutes } from "./src/http/routes.mjs";     // v1 (QA/update/apply)
import { registerRoutesV2 } from "./src/http/routesV2.mjs"; // v2 (batch)

assertRequiredEnv();

const BODY_LIMIT = process.env.BODY_LIMIT ?? "8mb";

// Connector/Actions 응답이 너무 크면 실패하는 경우가 있어 서버에서 선제 차단
const RESPONSE_LIMIT_KB = Number(process.env.RESPONSE_LIMIT_KB ?? "900"); // default 900KB
const RESPONSE_LIMIT_BYTES = Math.max(50 * 1024, RESPONSE_LIMIT_KB * 1024); // min 50KB

const app = express();

app.use(
  express.json({
    limit: BODY_LIMIT,
    type: ["application/json", "application/*+json"],
  })
);
app.use(express.text({ limit: BODY_LIMIT, type: ["text/*"] }));

// ---------------- Response size guard ----------------
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

  function cutoffPayload(bytes) {
    return {
      ok: false,
      error: "ResponseTooLarge",
      message:
        "Server response exceeded safe limit for CustomGPT Actions. Reduce payload (e.g., use summary-only responses, or fetch details via /v2/batch/:id/anomalies).",
      meta: {
        responseBytes: bytes,
        limitBytes: RESPONSE_LIMIT_BYTES,
        limitKB: RESPONSE_LIMIT_KB,
        method: req.method,
        path: req.originalUrl,
      },
    };
  }

  res.json = (payload) => {
    const bytes = byteLen(payload);
    if (bytes > RESPONSE_LIMIT_BYTES) {
      logSize(bytes, "[CUTOFF: json too large]");
      res.status(413);
      return originalJson(cutoffPayload(bytes));
    }
    logSize(bytes);
    return originalJson(payload);
  };

  res.send = (payload) => {
    const bytes = byteLen(payload);
    if (bytes > RESPONSE_LIMIT_BYTES) {
      logSize(bytes, "[CUTOFF: send too large]");
      res.status(413);
      return originalSend(JSON.stringify(cutoffPayload(bytes)));
    }
    logSize(bytes);
    return originalSend(payload);
  };

  next();
});

// ---------------- Routes ----------------
registerRoutes(app);   // v1
registerRoutesV2(app); // v2

// ---------------- Start ----------------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`BODY_LIMIT=${BODY_LIMIT}`);
  console.log(`RESPONSE_LIMIT_KB=${RESPONSE_LIMIT_KB}`);
  console.log(`REST(v1): /v1/glossary/update, /v1/glossary/qa/next, /v1/glossary/apply`);
  console.log(`REST(v2): /v2/batch/run, /v2/batch/:id/anomalies`);
});
