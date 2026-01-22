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
  UpdateSchema,
  CandidatesBatchSchema,
  ApplySchema,
  PendingNextSchema,
} from "./schemas.mjs";

import { mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { replaceByGlossaryWithLogs, buildRuleLogs } from "../replace/replace.mjs";
import { batchUpdateValuesA1, colIndexToA1 } from "../google/sheets.mjs";
import { runCandidatesBatch } from "../candidates/batch.mjs";

// ---------------- Session Cache (optional legacy) ----------------
const sessions = new Map();

// ---------------- Pending Cursor (Preview / Commit) ----------------
const previewCursors = new Map(); // next 호출 시 이동
const committedCursors = new Map(); // apply 성공 시 확정

function makeCursorKey({ sourceLangKey, categoryKey, targetLangKeys }) {
  const cat = categoryKey ?? "ALL";
  const langs = (targetLangKeys || []).slice().sort().join(",");
  return `${sourceLangKey}::${cat}::${langs}`;
}

// ---------------- Routes ----------------
export function registerRoutes(app) {
  // ✅ basic routes
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/", (_req, res) => res.status(200).send("ok"));

  /**
   * (Optional legacy) POST /v1/session/init
   * - Not required by your OpenAPI but safe to keep if existing clients use it.
   */
  app.post("/v1/session/init", async (req, res) => {
    try {
      const { category, sourceLang, targetLang } = InitSchema.parse(req.body);

      const categoryKey = String(category).trim().toLowerCase();
      const sourceLangKey = normalizeLang(sourceLang);
      const targetLangKey = normalizeLang(targetLang);

      assertAllowedSourceLang(sourceLangKey);

      const cache = await ensureGlossaryLoaded({ forceReload: false });

      const sessionId = newSessionId();
      sessions.set(sessionId, { sessionId, categoryKey, sourceLangKey, targetLangKey });

      return res.status(200).json({
        ok: true,
        sessionId,
        category: categoryKey,
        sourceLang: sourceLangKey,
        targetLang: targetLangKey,
        glossaryLoadedAt: cache.loadedAt ?? null,
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/translate/replace
   * - Phase 1 glossary replacement + Phase 1.5 ruleLogs
   */
  app.post("/v1/translate/replace", async (req, res) => {
    try {
      const body = ReplaceSchema.parse(req.body ?? {});
      const wantLogs = body.includeLogs ?? true;

      // NOTE: sessionId mode is optional; if not provided, require sourceLang/targetLang
      const sourceLangKey = normalizeLang(body.sourceLang);
      const targetLangKey = normalizeLang(body.targetLang);

      assertAllowedSourceLang(sourceLangKey);

      const cache = await ensureGlossaryLoaded({ forceReload: false });

      const categories = body.category
        ? [String(body.category).trim().toLowerCase()]
        : Array.from(cache.byCategoryBySource.keys());

      const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);

      const rulesCache = await ensureRulesLoaded({ forceReload: false });

      const outTexts = [];
      const perLineLogs = [];
      const ruleLogs = [];

      for (let i = 0; i < body.texts.length; i++) {
        const { out, logs } = replaceByGlossaryWithLogs({
          text: body.texts[i],
          sourceLangKey,
          targetLangKey,
          sourceTextMap,
        });

        outTexts.push(out);
        if (wantLogs) perLineLogs.push({ index: i, logs });

        const rLogs = buildRuleLogs({
          text: out,
          categoryKey: body.category ?? "ALL",
          targetLangKey,
          rulesCache,
        });
        ruleLogs.push({ index: i, logs: rLogs });
      }

      return res.status(200).json({
        ok: true,
        mode: "stateless",
        category: body.category ?? "ALL",
        sourceLang: sourceLangKey,
        targetLang: targetLangKey,
        texts: outTexts,
        logs: wantLogs ? perLineLogs : null,
        ruleLogs,
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/glossary/update
   * - Reload glossary cache (read-only)
   */
  app.post("/v1/glossary/update", async (req, res) => {
    try {
      const _body = UpdateSchema.parse(req.body ?? {});
      const cache = await ensureGlossaryLoaded({ forceReload: true });

      return res.status(200).json({
        ok: true,
        mode: "process",
        glossaryLoadedAt: cache.loadedAt ?? null,
        rawRowCount: cache.rawRowCount ?? null,
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/rules/update
   * - Reload rules cache (read-only)
   */
  app.post("/v1/rules/update", async (_req, res) => {
    try {
      const rules = await ensureRulesLoaded({ forceReload: true });
      return res.status(200).json({
        ok: true,
        mode: "process",
        rulesLoadedAt: rules.loadedAt ?? null,
        rawRowCount: rules.rawRowCount ?? null,
        itemRulesCount: rules.itemRulesCount ?? null,
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/glossary/candidates/batch
   * - Divine Pride candidate lookup (read-only)
   */
  app.post("/v1/glossary/candidates/batch", async (req, res) => {
    try {
      const body = CandidatesBatchSchema.parse(req.body ?? {});
      const out = await runCandidatesBatch(body);
      return res.status(200).json(out);
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/glossary/pending/next
   * - committedCursor 기준으로 스캔
   * - previewCursor만 이동
   */
  app.post("/v1/glossary/pending/next", async (req, res) => {
    try {
      const body = PendingNextSchema.parse(req.body ?? {});
      const sourceLangKey = normalizeLang(body.sourceLang ?? "en-US");

      const cache = await ensureGlossaryLoaded({ forceReload: Boolean(body.forceReload) });

      const categoryKey =
        body.category && String(body.category).trim()
          ? String(body.category).trim().toLowerCase()
          : null;

      const targetLangKeysRaw = (body.targetLangs || []).map(normalizeLang).filter(Boolean);
      const targetLangKeys = Array.from(new Set(targetLangKeysRaw));

      if (targetLangKeys.length === 0) {
        return res.status(400).json({ ok: false, error: "targetLangs is required." });
      }

      const validTargetLangKeys = targetLangKeys.filter((k) => cache.langIndex?.[k] != null);
      if (validTargetLangKeys.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "None of targetLangs exist in sheet header (langIndex).",
        });
      }

      const cursorKey = makeCursorKey({
        sourceLangKey,
        categoryKey,
        targetLangKeys: validTargetLangKeys,
      });

      const committed = committedCursors.get(cursorKey) ?? 0;
      const limit = body.limit ?? 100;

      const items = [];
      let scanned = 0;

      for (const entry of cache.entries || []) {
        scanned++;

        if ((entry._rowIndex ?? 0) <= committed) continue;

        if (categoryKey) {
          const eCat = String(entry.category ?? "").trim().toLowerCase();
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

      // preview cursor 이동 (업로드 성공 전에는 committed 변경 없음)
      if (items.length > 0) {
        previewCursors.set(cursorKey, items[items.length - 1].rowIndex);
      }

      return res.status(200).json({
        ok: true,
        category: categoryKey ?? "ALL",
        sourceLang: sourceLangKey === "ko-kr" ? "ko-KR" : "en-US",
        targetLangs: validTargetLangKeys,
        items,
        cursor: {
          committed,
          preview: previewCursors.get(cursorKey) ?? committed,
        },
        meta: { returned: items.length, scanned },
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/glossary/apply
   * - conflict-safe, fillOnlyEmpty, partial_success/no_op 지원
   * - 성공 시 previewCursor → committedCursor 확정
   */
  app.post("/v1/glossary/apply", async (req, res) => {
    try {
      const body = ApplySchema.parse(req.body ?? {});
      const sourceLangKey = normalizeLang(body.sourceLang ?? "en-US");

      const cache = await ensureGlossaryLoaded({ forceReload: true });

      const categoryKey =
        body.category && String(body.category).trim()
          ? String(body.category).trim().toLowerCase()
          : null;

      const categories = categoryKey
        ? [categoryKey]
        : Array.from(cache.byCategoryBySource.keys());

      const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);

      // apply에 포함된 targetLangKeys(커서 key 계산용)
      const unionTargetLangKeys = Array.from(
        new Set(
          body.entries
            .flatMap((e) => Object.keys(e.translations || {}))
            .map((k) => normalizeLang(k))
            .filter(Boolean)
        )
      ).filter((k) => cache.langIndex?.[k] != null);

      const cursorKey = makeCursorKey({
        sourceLangKey,
        categoryKey,
        targetLangKeys: unionTargetLangKeys,
      });

      const updates = [];
      const skipped = [];
      const notFound = [];
      const conflicts = [];

      let updatedPlanned = 0;

      const pickLowestRow = (entries) =>
        entries.reduce((min, e) => (!min || e._rowIndex < min._rowIndex ? e : min), null);

      for (const item of body.entries) {
        const sourceText = String(item.sourceText ?? "").trim();
        const matches = sourceTextMap.get(sourceText);

        if (!matches || matches.length === 0) {
          notFound.push({ sourceText });
          continue;
        }

        const entry = matches.length === 1 ? matches[0] : pickLowestRow(matches);

        if (matches.length > 1) {
          conflicts.push({
            sourceText,
            rowIndices: matches.map((m) => m._rowIndex),
            appliedRowIndex: entry._rowIndex,
          });
        }

        for (const [langRaw, valRaw] of Object.entries(item.translations || {})) {
          const langKey = normalizeLang(langRaw);
          if (!langKey) continue;

          if (langKey === "en-us" && !body.allowAnchorUpdate) {
            skipped.push({ sourceText, lang: langKey, reason: "anchor_update_blocked" });
            continue;
          }

          const colIdx = cache.langIndex?.[langKey];
          if (colIdx == null) {
            skipped.push({ sourceText, lang: langKey, reason: "lang_column_not_found" });
            continue;
          }

          const existing = String(entry.translations?.[langKey] ?? "").trim();
          if (body.fillOnlyEmpty && existing) {
            skipped.push({ sourceText, lang: langKey, reason: "cell_already_has_value" });
            continue;
          }

          const val = String(valRaw ?? "").trim();
          if (!val) {
            skipped.push({ sourceText, lang: langKey, reason: "empty_translation_value" });
            continue;
          }

          const a1 = `${SHEET_NAME}!${colIndexToA1(colIdx)}${entry._rowIndex}`;
          updates.push({ range: a1, values: [[val]] });
          updatedPlanned += 1;
        }
      }

      const { updatedCells } = await batchUpdateValuesA1(updates);

      // 최신화
      await ensureGlossaryLoaded({ forceReload: true });

      // cursor commit (apply 성공 시점에만)
      if (previewCursors.has(cursorKey)) {
        committedCursors.set(cursorKey, previewCursors.get(cursorKey));
      }

      const status =
        updatedCells > 0
          ? skipped.length || conflicts.length || notFound.length
            ? "partial_success"
            : "success"
          : "no_op";

      return res.status(200).json({
        ok: true,
        status,
        category: categoryKey ?? "ALL",
        sourceLang: sourceLangKey === "ko-kr" ? "ko-KR" : "en-US",
        fillOnlyEmpty: Boolean(body.fillOnlyEmpty),
        allowAnchorUpdate: Boolean(body.allowAnchorUpdate),
        writePlan: { intendedUpdates: updatedPlanned },
        result: { updatedCells },
        notFound,
        skipped,
        conflicts,
        cursor: {
          committed: committedCursors.get(cursorKey) ?? 0,
          preview: previewCursors.get(cursorKey) ?? (committedCursors.get(cursorKey) ?? 0),
        },
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });
}
