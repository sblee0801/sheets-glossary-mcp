import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const GLOSSARY_API =
  "https://sheets-glossary-mcp-885964096612.europe-west1.run.app";

app.post("/run-apply", async (req, res) => {
  try {
    const payload = req.body;

    if (
      !payload ||
      typeof payload.sheet !== "string" ||
      !Array.isArray(payload.entries)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payload",
      });
    }

    const r = await fetch(`${GLOSSARY_API}/v1/glossary/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const out = await r.json();
    res.json(out);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e),
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`apply-runner listening on ${PORT}`);
});
