/**
 * server.mjs
 * - Cloud Run entrypoint
 * - Express bootstrap
 * - Correct env import: src/config/env.mjs
 */

import "dotenv/config";
import express from "express";

// ✅ 네 프로젝트 실제 위치
import { PORT } from "./src/config/env.mjs";
import { registerRoutes } from "./src/http/routes.mjs";

const app = express();

// ---------------- Body parsers ----------------
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

// ---------------- CORS / preflight safety ----------------
// CustomGPT / Connector 방어용
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

  // OPTIONS / HEAD 는 바로 종료
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  next();
});

// ---------------- Register routes ----------------
registerRoutes(app);

// ---------------- Start server ----------------
// Cloud Run은 process.env.PORT 를 강제함
const port = Number(process.env.PORT || PORT || 8080);

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
  console.log(`   ENV PORT=${process.env.PORT}, fallback PORT=${PORT}`);
});
