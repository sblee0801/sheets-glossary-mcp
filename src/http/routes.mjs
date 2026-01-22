/**
 * src/http/routes.mjs
 * - REST endpoints only
 * - Server is the single source of truth
 */

import { SHEET_NAME } from "../config/env.mjs";
import {
  normalizeLang,
  assertAllowedSourceLang,
  newSessionId,
} from "../utils/common.mjs";

import { ensureGlossaryLoaded, ensureRulesLoaded } from "../cache/global.mjs";

import {
  InitSchema,
  ReplaceSchema,
  CandidatesBatchSchema,
  ApplySchema,
  PendingNextSchema,
} from "./schemas.mjs";

import { mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { replaceByGlossaryWithLogs, buildRuleLogs } from "../replace/replace.mjs";
import { batchUpdateValuesA1, colIndexToA1 } from "../google/sheets.mjs";
import { runCandidatesBatch } from "../candidates/batch.mjs";

// ---------------- Session Cache ----------------
const sessions = new Map();

// ---------------- Pending Cursor (Preview / Commit) ----------------
const previewCursors = new Map();   // next 호출 시 이동
const committedCursors = new Map(); // apply 성공 시 확정

function makeCursorKey({ sourceLangKey, categoryKey, targetLangKeys }) {
  const cat = categoryKey ?? "ALL";
  const langs = targetLangKeys.slice().sort().join(",");
  return `${sourceLangKey}::${cat}::${langs}`;
}

// ---------------- Routes ----------------
export function registerRoutes(app) {
  app.get("/health", (_req, res) => res.json({ ok: true }));

  /**
   * POST /v1/glossary/pending/next
   * - committedCursor 기준으로 스캔
   * - previewCursor만 이동
   */
  app.post("/v1/glossary/pending/next", async (req, res) => {
    try {
      const body = PendingNextSchema.parse(req.body ?? {});
      const sourceLangKey = normalizeLang(body.sourceLang ?? "en-US");

      const cache = await ensureGlossaryLoaded({ forceReload: body.forceReload });

      const categoryKey = body.category
        ? String(body.category).trim().toLowerCase()
        : null;

      const targetLangKeys = body.targetLangs.map(normalizeLang);
      const validTargetLangKeys = targetLangKeys.filter(
        (k) => cache.langIndex?.[k] != null
      );

      const cursorKey = makeCursorKey({
        sourceLangKey,
        categoryKey,
        targetLangKeys: validTargetLangKeys,
      });

      const committed = committedCursors.get(cursorKey) ?? 0;
      const limit = body.limit ?? 100;

      const items = [];
      let scanned = 0;

      for (const entry of cache.entries) {
        scanned++;

        if ((entry._rowIndex ?? 0) <= committed) continue;

        if (categoryKey) {
          const eCat = String(entry.category ?? "").toLowerCase();
          if (eCat !== categoryKey) continue;
        }

        const src = String(entry.translations?.[sourceLangKey] ?? "").trim();
        if (!src) continue;

        let needs = false;
        for (const tKey of validTargetLangKeys) {
          const tv = String(entry.translations?.[tKey] ?? "").trim();
          if (!tv) {
            needs = true;
            break;
          }
        }
        if (!needs) continue;

        items.push({
          sourceText: src,
          category: entry.category ?? null,
          rowIndex: entry._rowIndex ?? null,
        });

        if (items.length >= limit) break;
      }

      // preview cursor 이동
      if (items.length > 0) {
        previewCursors.set(cursorKey, items[items.length - 1].rowIndex);
      }

      res.json({
        ok: true,
        items,
        cursor: {
          committed,
          preview: previewCursors.get(cursorKey) ?? committed,
        },
        meta: { returned: items.length, scanned },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * POST /v1/glossary/apply
   * - 성공 시 previewCursor → committedCursor 확정
   */
  app.post("/v1/glossary/apply", async (req, res) => {
    try {
      const body = ApplySchema.parse(req.body ?? {});
      const sourceLangKey = normalizeLang(body.sourceLang ?? "en-US");

      const cache = await ensureGlossaryLoaded({ forceReload: true });

      const categoryKey = body.category
        ? String(body.category).trim().toLowerCase()
        : null;

      const targetLangKeys = Object.keys(body.entries[0]?.translations ?? {}).map(
        normalizeLang
      );

      const cursorKey = makeCursorKey({
        sourceLangKey,
        categoryKey,
        targetLangKeys,
      });

      // ---- 기존 apply 로직 (변경 없음) ----
      const sourceTextMap = mergeSourceTextMapsFromCache(
        cache,
        sourceLangKey,
        categoryKey ? [categoryKey] : Array.from(cache.byCategoryBySource.keys())
      );

      const updates = [];
      let updatedCells = 0;

      for (const item of body.entries) {
        const matches = sourceTextMap.get(item.sourceText);
        if (!matches?.length) continue;
        const entry = matches[0];

        for (const [lang, val] of Object.entries(item.translations)) {
          const langKey = normalizeLang(lang);
          const colIdx = cache.langIndex[langKey];
          if (colIdx == null) continue;

          const a1 = `${SHEET_NAME}!${colIndexToA1(colIdx)}${entry._rowIndex}`;
          updates.push({ range: a1, values: [[val]] });
          updatedCells++;
        }
      }

      await batchUpdateValuesA1(updates);
      await ensureGlossaryLoaded({ forceReload: true });

      // ---- cursor commit ----
      if (previewCursors.has(cursorKey)) {
        committedCursors.set(cursorKey, previewCursors.get(cursorKey));
      }

      res.json({
        ok: true,
        updatedCells,
        cursor: {
          committed: committedCursors.get(cursorKey),
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
