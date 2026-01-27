/**
 * src/http/routes.mjs
 * - REST endpoints (sheet-aware)
 */

import {
  normalizeLang,
  assertAllowedSourceLang,
  newSessionId,
  nowIso,
  getParsedBody,
} from "../utils/common.mjs";

import { ensureGlossaryLoaded, ensureRulesLoaded } from "../cache/global.mjs";
import { mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { replaceByGlossaryWithLogs, buildRuleLogs } from "../replace/replace.mjs";
import { colIndexToA1, batchUpdateValuesA1 } from "../google/sheets.mjs";

import {
  InitSchema,
  ReplaceSchema,
  UpdateSchema,
  PendingNextSchema,
  ApplySchema,
  GlossaryQaNextSchema,
  MaskSchema,
  MaskApplySchema, // ✅ ADD
} from "./schemas.mjs";

// ---------------- In-memory sessions (lightweight) ----------------
const _sessions = new Map();

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

function toJson(res, status, payload) {
  res.status(status).json(payload);
}

function handleErr(res, e) {
  const status = Number(e?.status) || 500;
  toJson(res, status, {
    ok: false,
    error: String(e?.message ?? e),
    extra: e?.extra,
  });
}

function pickSheet(v) {
  return String(v?.sheet ?? "Glossary").trim() || "Glossary";
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeToken(style, id) {
  return `{mask:${id}}`;
}

/**
 * Mask a single text using deterministic glossary masking
 */
function maskOneText({
  text,
  terms,
  termToMaskId,
  masksById,
  maskStyle,
  caseSensitive,
  wordBoundary,
}) {
  let out = String(text ?? "");
  if (!out || !terms.length) return out;

  for (const t of terms) {
    if (!t) continue;

    const existingId = termToMaskId.get(t);
    const id = existingId ?? (masksById.size + 1);

    if (!existingId) {
      termToMaskId.set(t, id);
      if (!masksById.has(id)) masksById.set(id, null);
    }

    let pattern = escapeRegex(t);
    if (wordBoundary && /^[A-Za-z0-9_]/.test(t) && /[A-Za-z0-9_]$/.test(t)) {
      pattern = `\\b${pattern}\\b`;
    }

    const re = new RegExp(pattern, caseSensitive ? "g" : "gi");
    out = out.replace(re, makeToken(maskStyle, id));
  }

  return out;
}

// ---------------- Endpoint registration ----------------
export function registerRoutes(app) {
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/", (_req, res) => res.send("ok"));

  /**
   * POST /v1/session/init
   */
  app.post("/v1/session/init", async (req, res) => {
    try {
      const v = InitSchema.parse(getParsedBody(req));

      const sheet = pickSheet(v);
      const sourceLangKey = normalizeLang(v.sourceLang);
      const targetLangKey = normalizeLang(v.targetLang);

      assertAllowedSourceLang(sourceLangKey);

      const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: false });

      const sessionId = newSessionId();
      _sessions.set(sessionId, {
        sheet,
        category: v.category,
        sourceLangKey,
        targetLangKey,
        createdAt: nowIso(),
      });

      toJson(res, 200, { ok: true, sessionId, sheet });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * POST /v1/translate/replace
   */
  app.post("/v1/translate/replace", async (req, res) => {
    try {
      const v = ReplaceSchema.parse(getParsedBody(req));
      const sheet = pickSheet(v);

      let cfg = null;
      if (v.sessionId) {
        cfg = _sessions.get(v.sessionId);
        if (!cfg) throw httpError(400, "Invalid sessionId");
      }

      const category = v.category ?? cfg?.category;
      const sourceLangKey = normalizeLang(v.sourceLang ?? cfg?.sourceLangKey);
      const targetLangKey = normalizeLang(v.targetLang ?? cfg?.targetLangKey);

      assertAllowedSourceLang(sourceLangKey);

      const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: false });

      const categories = category
        ? [String(category).toLowerCase()]
        : Array.from(cache.byCategoryBySource.keys());

      const sourceTextMap = mergeSourceTextMapsFromCache(
        cache,
        sourceLangKey,
        categories
      );

      const rulesCache = await ensureRulesLoaded({ forceReload: false });

      const out = [];
      const logs = [];
      const ruleLogs = [];

      for (let i = 0; i < v.texts.length; i++) {
        const r = replaceByGlossaryWithLogs({
          text: v.texts[i],
          sourceLangKey,
          targetLangKey,
          sourceTextMap,
        });

        out.push(r.out);
        logs.push({ index: i, logs: r.logs });

        ruleLogs.push({
          index: i,
          logs: buildRuleLogs({
            text: r.out,
            categoryKey: category ?? "ALL",
            targetLangKey,
            rulesCache,
          }),
        });
      }

      toJson(res, 200, { ok: true, texts: out, logs, ruleLogs });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * POST /v1/translate/mask
   */
  app.post("/v1/translate/mask", async (req, res) => {
    try {
      const v = MaskSchema.parse(getParsedBody(req));

      const glossarySheet = String(v.glossarySheet ?? "Glossary");
      const sourceLangKey = normalizeLang(v.sourceLang);
      const targetLangKey = normalizeLang(v.targetLang);

      const cache = await ensureGlossaryLoaded({
        sheetName: glossarySheet,
        forceReload: Boolean(v.forceReload),
      });

      const categories = v.category
        ? [String(v.category).toLowerCase()]
        : Array.from(cache.byCategoryBySource.keys());

      const sourceTextMap = mergeSourceTextMapsFromCache(
        cache,
        sourceLangKey,
        categories
      );

      const terms = Array.from(sourceTextMap.keys()).sort(
        (a, b) => b.length - a.length
      );

      const termToMaskId = new Map();
      const masksById = new Map();

      const textsMasked = v.texts.map((t) =>
        maskOneText({
          text: t,
          terms,
          termToMaskId,
          masksById,
          maskStyle: v.maskStyle,
          caseSensitive: v.caseSensitive,
          wordBoundary: v.wordBoundary,
        })
      );

      const masks = Array.from(termToMaskId.entries()).map(([anchor, id]) => {
        const hits = sourceTextMap.get(anchor) || [];
        const chosen = hits[0];
        const restore =
          chosen?.translations?.[targetLangKey] ||
          chosen?.translations?.[sourceLangKey] ||
          anchor;

        return { id, anchor, restore };
      });

      toJson(res, 200, {
        ok: true,
        textsMasked,
        masks,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * ✅ NEW: POST /v1/translate/mask/apply
   */
  app.post("/v1/translate/mask/apply", async (req, res) => {
    try {
      const v = MaskApplySchema.parse(getParsedBody(req));

      const sheet = v.sheet;
      const maskingHeader = `${v.targetLang}-Masking`;

      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: false,
      });

      const header = cache.header;
      const colIdx = header.findIndex(
        (h) => String(h ?? "").trim() === maskingHeader
      );
      if (colIdx < 0) {
        throw httpError(400, `Masking column not found: ${maskingHeader}`);
      }

      const updates = v.entries.map((e) => ({
        range: `${sheet}!${colIndexToA1(colIdx)}${e.rowIndex}`,
        values: [[e.maskedText]],
      }));

      const result = await batchUpdateValuesA1(updates);

      toJson(res, 200, {
        ok: true,
        sheet,
        maskingHeader,
        updatedCells: result.updatedCells,
        updatedRanges: result.updatedRanges,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * POST /v1/glossary/update
   */
  app.post("/v1/glossary/update", async (req, res) => {
    try {
      const v = UpdateSchema.parse(getParsedBody(req));
      const sheet = pickSheet(v);

      const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: true });

      toJson(res, 200, {
        ok: true,
        sheet,
        glossaryLoadedAt: cache.loadedAt,
        rawRowCount: cache.rawRowCount,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * POST /v1/glossary/pending/next
   */
  app.post("/v1/glossary/pending/next", async (req, res) => {
    try {
      const v = PendingNextSchema.parse(getParsedBody(req));
      const sheet = pickSheet(v);

      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: Boolean(v.forceReload),
      });

      const sourceLangKey = normalizeLang(v.sourceLang);
      const targetLangKeys = v.targetLangs.map(normalizeLang);

      const items = [];

      for (let i = 0; i < cache.rawRows.length; i++) {
        const row = cache.rawRows[i];
        const rowIndex = i + 2;
        const src = String(row[cache.langIndex[sourceLangKey]] ?? "").trim();
        if (!src) continue;

        let pending = false;
        for (const lk of targetLangKeys) {
          const col = cache.langIndex[lk];
          if (!String(row[col] ?? "").trim()) {
            pending = true;
            break;
          }
        }

        if (pending) {
          items.push({ rowIndex, sourceText: src });
          if (items.length >= v.limit) break;
        }
      }

      toJson(res, 200, { ok: true, sheet, items });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * POST /v1/glossary/qa/next
   */
  app.post("/v1/glossary/qa/next", async (req, res) => {
    try {
      const v = GlossaryQaNextSchema.parse(getParsedBody(req));
      const sheet = pickSheet(v);

      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: Boolean(v.forceReload),
      });

      const srcCol = cache.langIndex[normalizeLang(v.sourceLang)];
      const tgtCol = cache.langIndex[normalizeLang(v.targetLang)];

      const items = [];
      for (let i = 0; i < cache.rawRows.length; i++) {
        const row = cache.rawRows[i];
        if (row[srcCol] && row[tgtCol]) {
          items.push({
            rowIndex: i + 2,
            sourceText: row[srcCol],
            targetText: row[tgtCol],
          });
          if (items.length >= v.limit) break;
        }
      }

      toJson(res, 200, { ok: true, sheet, items });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /**
   * POST /v1/glossary/apply
   */
  app.post("/v1/glossary/apply", async (req, res) => {
    try {
      const v = ApplySchema.parse(getParsedBody(req));
      const sheet = pickSheet(v);

      const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: false });
      const sourceLangKey = normalizeLang(v.sourceLang);

      const categories = v.category
        ? [String(v.category).toLowerCase()]
        : Array.from(cache.byCategoryBySource.keys());

      const sourceTextMap = mergeSourceTextMapsFromCache(
        cache,
        sourceLangKey,
        categories
      );

      const updates = [];

      for (const e of v.entries) {
        const hits = sourceTextMap.get(e.sourceText) || [];
        if (!hits.length) continue;

        const chosen = hits[0];
        for (const [lang, val] of Object.entries(e.translations)) {
          const colIdx = cache.langIndex[normalizeLang(lang)];
          if (colIdx == null) continue;

          updates.push({
            range: `${sheet}!${colIndexToA1(colIdx)}${chosen._rowIndex}`,
            values: [[val]],
          });
        }
      }

      const result = await batchUpdateValuesA1(updates);

      toJson(res, 200, {
        ok: true,
        sheet,
        updatedCells: result.updatedCells,
        updatedRanges: result.updatedRanges,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });
}
