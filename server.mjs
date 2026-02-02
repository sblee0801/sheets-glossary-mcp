/**
 * server.mjs
 * - Cloud Run entrypoint
 * - Express bootstrap
 * - ✅ Always-on health endpoints defined BEFORE any other routes
 */

import "dotenv/config";
import express from "express";

// ✅ 네 프로젝트 실제 위치
import { PORT } from "./src/config/env.mjs";
import { registerRoutes } from "./src/http/routes.mjs";

const app = express();

// ---- Body parsers ----
app.use(
  express.json({
    limit: "8mb",
    type: ["application/json", "application/*+json"],
  })
);

app.use(
  express.text({
    limit: "8mb",
    type: ["text/*"],
  })
);

// ---- CORS / preflight safety ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );

  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

/**
 * ✅ ALWAYS-ON health (CustomGPT/Cloud Run/Proxy defensive)
 * - Some clients call HEAD/OPTIONS or add trailing slash.
 * - Some tools unexpectedly prefix /v1.
 * - Put these BEFORE registerRoutes so they never disappear.
 */
const health = (_req, res) => res.status(200).json({ ok: true });
app.all(["/health", "/health/", "/healthz", "/healthz/", "/v1/health", "/v1/healthz"], health);
app.all("/", (_req, res) => res.status(200).send("ok"));

// ---- Register the rest of routes ----
registerRoutes(app);

// ---- Start server ----
const port = Number(process.env.PORT || PORT || 8080);
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
