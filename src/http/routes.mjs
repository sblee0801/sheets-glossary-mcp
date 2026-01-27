/**
 * src/http/routes.mjs
 * - REST endpoints
 *
 * ✅ 2026-01 changes
 * - Add masking workflow:
 *   1) /v1/translate/mask            (texts -> masked texts, compact)
 *   2) /v1/translate/mask/fromSheet  (read sheet -> masked preview)
 *   3) /v1/translate/mask/apply      (write maskedText -> <targetLang>-Masking)
 *
 * - Ensure mask endpoints return small payloads by default.
 */

import {
  InitSchema,
  ReplaceSchema,
  UpdateSchema,
  PendingNextSchema,
  ApplySchema,
  CandidatesBatchSchema,
  MaskSchema,
  MaskFromSheetSchema,
  MaskApplySchema,
} from "./schemas.mjs";

import { SHEET_NAME } from "../config/env.mjs";

import {
  normalizeLang,
  assertAllowedSourceLang,
  newSessionId,
  escapeRegExp,
} from "../utils/common.mjs";

import { ensureGlossaryLoaded, ensureRulesLoaded } from "../cache/global.mjs";
import { mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { replaceByGlossaryWithLogs, buildRuleLogs } from "../replace/replace.mjs";
import { runCandidatesBatch } from "../candidates/batch.mjs";

import {
  readSheetRange,
  batchUpdateValuesA1,
  colIndexToA1,
} from "../google/sheets.mjs";

// ---------------- Session Cache (legacy) ----------------
const sessions = new Map();

// ---------------- Mask helpers (compact, no huge payload) ----------------
function pickRestoreText({ entry, targetLangKey, sourceLangKey, restoreStrategy }) {
  // restoreStrategy = "glossaryTarget": targetLang이 있으면 그걸로 복원, 없으면 anchor fallback
  if (restoreStrategy === "glossaryTarget") {
    const v = String(entry?.translations?.[targetLangKey] ?? "").trim();
    if (v) return v;
    return String(entry?.translations?.[sourceLangKey] ?? "").trim();
  }

  const v = String(entry?.translations?.[targetLangKey] ?? "").trim();
  if (v) return v;
  return String(entry?.translations?.[sourceLangKey] ?? "").trim();
}

function buildGlossaryTermList({ cache, sourceLangKey, categoryKey }) {
  const categories = categoryKey
    ? [String(categoryKey).trim().toLowerCase()]
    : Array.from(cache.byCategoryBySource.keys());

  const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);

  const terms = Array.from(sourceTextMap.keys())
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  return { categories, sourceTextMap, terms };
}

function maskOneText({
  text,
  terms,
  sourceTextMap,
  sourceLangKey,
  targetLangKey,
  restoreStrategy,
  maskStyle,
}) {
  const input = String(text ?? "");
  if (!input) return { masked: "", masks: [] };

  // token per term (NOT per occurrence) -> mapping is compact
  const masks = [];
  const termToToken = new Map();

  let masked = input;
  let counter = 0;

  for (const term of terms) {
    if (!term) continue;
    if (!masked.includes(term)) continue;

    const hits = sourceTextMap.get(term);
    if (!hits || hits.length === 0) continue;

    const chosen = hits[0];
    if (!chosen) continue;

    let token = termToToken.get(term);
    if (!token) {
      counter += 1;
      token = maskStyle === "plain" ? `__MASK_${counter}__` : `{mask:${counter}}`;
      termToToken.set(term, token);

      const restore = pickRestoreText({
        entry: chosen,
        targetLangKey,
        sourceLangKey,
        restoreStrategy,
      });

      masks.push({
        token,
        source: term,
        restore,
        chosenRowIndex: chosen?._rowIndex ?? null,
      });
    }

    const re = new RegExp(escapeRegExp(term), "g");
    masked = masked.replace(re, token);
  }

  return { masked, masks };
}

function findColumnIndexByHeader(header, wantHeaderExact) {
  const want = String(wantHeaderExact ?? "").trim();
  if (!want) return -1;
  for (let i = 0; i < header.length; i++) {
    if (String(header[i] ?? "").trim() === want) return i;
  }
  return -1;
}

function buildMaskingHeader(targetLangRaw) {
  // 규칙: "<targetLang>-Masking" (예: id-ID-Masking)
  const t = String(targetLangRaw ?? "").trim();
  return `${t}-Masking`;
}

// ---------------- Routes ----------------
export function registerRoutes(app) {
  // basic
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/", (_req, res) => res.status(200).send("ok"));

  /**
   * POST /v1/session/init (legacy)
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
   * ✅ POST /v1/translate/mask
   * - texts 마스킹(검수용)
   * - 기본 응답은 "maskedText 중심"으로 작게 유지
   */
  app.post("/v1/translate/mask", async (req, res) => {
    try {
      const body = MaskSchema.parse(req.body ?? {});

      const categoryKey = body.category ? String(body.category).trim().toLowerCase() : null;
      const sourceLangKey = normalizeLang(body.sourceLang);
      const targetLangKey = normalizeLang(body.targetLang);

      assertAllowedSourceLang(sourceLangKey);

      const cache = await ensureGlossaryLoaded({ forceReload: false });
      const { sourceTextMap, terms } = buildGlossaryTermList({
        cache,
        sourceLangKey,
        categoryKey,
      });

      const textsMasked = [];
      const mapByIndex = [];

      for (let i = 0; i < body.texts.length; i++) {
        const { masked, masks } = maskOneText({
          text: body.texts[i],
          terms,
          sourceTextMap,
          sourceLangKey,
          targetLangKey,
          restoreStrategy: body.restoreStrategy,
          maskStyle: body.maskStyle,
        });

        textsMasked.push(masked);

        // includeMap=false 기본 (대용량 안전)
        if (body.includeMap) {
          mapByIndex.push({
            index: i,
            masks: masks.map(({ token, source, restore }) => ({ token, source, restore })),
          });
        }
      }

      return res.status(200).json({
        ok: true,
        sourceLang: body.sourceLang,
        targetLang: body.targetLang,
        textsMasked,
        maps: body.includeMap ? mapByIndex : undefined,
        meta: { lines: body.texts.length },
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * ✅ POST /v1/translate/mask/fromSheet
   * - 1) Trans 시트에서 sourceLang 컬럼 텍스트를 읽고
   * - 2) glossary 기반 마스킹 수행
   * - 3) 결과만 반환 (WRITE 없음)
   */
  app.post("/v1/translate/mask/fromSheet", async (req, res) => {
    try {
      const body = MaskFromSheetSchema.parse(req.body ?? {});

      const sheet = body.sheet;
      const sourceLangRaw = body.sourceHeader ?? body.sourceLang;
      const targetLangRaw = body.targetLang;
      const maskingHeader = body.maskingHeader ?? buildMaskingHeader(targetLangRaw);

      const sourceLangKey = normalizeLang(body.sourceLang);
      const targetLangKey = normalizeLang(body.targetLang);
      assertAllowedSourceLang(sourceLangKey);

      const categoryKey = body.category ? String(body.category).trim().toLowerCase() : null;

      // Trans sheet read A:Z
      const { header, rows } = await readSheetRange(`${sheet}!A:Z`);
      if (!header.length) return res.status(400).json({ ok: false, error: "sheet header is empty." });

      const idxSource = findColumnIndexByHeader(header, sourceLangRaw);
      if (idxSource < 0) {
        return res.status(400).json({
          ok: false,
          error: `source column not found in header: '${sourceLangRaw}'`,
        });
      }

      const idxMasking = findColumnIndexByHeader(header, maskingHeader);
      if (body.onlyIfMaskingEmpty && idxMasking < 0) {
        return res.status(400).json({
          ok: false,
          error: `masking column not found in header: '${maskingHeader}'`,
        });
      }

      // glossary index once
      const cache = await ensureGlossaryLoaded({ forceReload: false });
      const { sourceTextMap, terms } = buildGlossaryTermList({
        cache,
        sourceLangKey,
        categoryKey,
      });

      const items = [];
      let nextCursor = body.cursor;

      for (let r = 0; r < rows.length; r++) {
        const rowIndex = r + 2; // header=1, data starts at 2
        if (rowIndex <= body.cursor) continue;

        const row = rows[r] || [];
        const src = String(row[idxSource] ?? "").trim();
        if (!src) continue;

        if (body.onlyIfMaskingEmpty) {
          const existingMask = String((row[idxMasking] ?? "")).trim();
          if (existingMask) continue;
        }

        const { masked } = maskOneText({
          text: src,
          terms,
          sourceTextMap,
          sourceLangKey,
          targetLangKey,
          restoreStrategy: "glossaryTarget",
          maskStyle: "braces",
        });

        items.push({ rowIndex, sourceText: src, maskedText: masked });
        nextCursor = rowIndex;

        if (items.length >= body.limit) break;
      }

      return res.status(200).json({
        ok: true,
        sheet,
        sourceLang: body.sourceLang,
        targetLang: body.targetLang,
        sourceHeader: sourceLangRaw,
        maskingHeader,
        items,
        nextCursor,
        meta: { returned: items.length },
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * ✅ POST /v1/translate/mask/apply
   * - 검수한 maskedText를 <targetLang>-Masking 컬럼에 업로드
   */
  app.post("/v1/translate/mask/apply", async (req, res) => {
    try {
      const body = MaskApplySchema.parse(req.body ?? {});

      const sheet = body.sheet;
      const targetLangRaw = body.targetLang;
      const maskingHeader = body.maskingHeader ?? buildMaskingHeader(targetLangRaw);

      // read header to resolve masking col
      const { header, rows } = await readSheetRange(`${sheet}!A:Z`);
      if (!header.length) return res.status(400).json({ ok: false, error: "sheet header is empty." });

      const idxMasking = findColumnIndexByHeader(header, maskingHeader);
      if (idxMasking < 0) {
        return res.status(400).json({
          ok: false,
          error: `masking column not found in header: '${maskingHeader}'`,
        });
      }

      const updates = [];
      let intended = 0;
      let skippedFilled = 0;
      let skippedInvalid = 0;

      for (const it of body.entries) {
        const rowIndex = it.rowIndex;
        const maskedText = String(it.maskedText ?? "").trim();
        if (!maskedText) {
          skippedInvalid += 1;
          continue;
        }

        if (body.fillOnlyEmpty) {
          const dataRowIdx = rowIndex - 2;
          const existing = String((rows[dataRowIdx] || [])[idxMasking] ?? "").trim();
          if (existing) {
            skippedFilled += 1;
            continue;
          }
        }

        const a1 = `${sheet}!${colIndexToA1(idxMasking)}${rowIndex}`;
        updates.push({ range: a1, values: [[maskedText]] });
        intended += 1;
      }

      const { updatedCells, updatedRanges } = await batchUpdateValuesA1(updates);

      return res.status(200).json({
        ok: true,
        sheet,
        targetLang: targetLangRaw,
        maskingHeader,
        writePlan: {
          intendedUpdates: intended,
          skippedBecauseFilled: skippedFilled,
          skippedInvalid,
        },
        result: {
          updatedCells,
          updatedRangesCount: updatedRanges.length,
        },
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/glossary/update
   */
  app.post("/v1/glossary/update", async (req, res) => {
    try {
      UpdateSchema.parse(req.body ?? {});
      const cache = await ensureGlossaryLoaded({ forceReload: true });

      return res.status(200).json({
        ok: true,
        glossaryLoadedAt: cache.loadedAt ?? null,
        rawRowCount: cache.rawRowCount ?? null,
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/rules/update
   */
  app.post("/v1/rules/update", async (_req, res) => {
    try {
      const rules = await ensureRulesLoaded({ forceReload: true });
      return res.status(200).json({
        ok: true,
        rulesLoadedAt: rules.loadedAt ?? null,
        rawRowCount: rules.rawRowCount ?? null,
        itemRulesCount: rules.itemEntries?.length ?? null,
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/glossary/candidates/batch
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
   * - (주의) 현재 구현은 glossary cache 기반이며 sheet별 cache까지 완전 멀티시트 SSOT는 다음 단계에서 맞추는 게 안전함
   */
  app.post("/v1/glossary/pending/next", async (req, res) => {
    try {
      const body = PendingNextSchema.parse(req.body ?? {});
      const sourceLangKey = normalizeLang(body.sourceLang);

      const cache = await ensureGlossaryLoaded({ forceReload: Boolean(body.forceReload) });

      const categoryKey =
        body.category && String(body.category).trim()
          ? String(body.category).trim().toLowerCase()
          : null;

      const targetLangKeys = Array.from(new Set((body.targetLangs || []).map(normalizeLang).filter(Boolean)));

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

      const items = [];
      let scanned = 0;

      for (const entry of cache.entries || []) {
        scanned++;

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

        if (items.length >= body.limit) break;
      }

      return res.status(200).json({
        ok: true,
        sheet: body.sheet ?? "Glossary",
        category: categoryKey ?? "ALL",
        sourceLang: body.sourceLang,
        targetLangs: validTargetLangKeys,
        items,
        meta: { returned: items.length, scanned },
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });

  /**
   * POST /v1/glossary/apply
   */
  app.post("/v1/glossary/apply", async (req, res) => {
    try {
      const body = ApplySchema.parse(req.body ?? {});
      const sourceLangKey = normalizeLang(body.sourceLang);

      const cache = await ensureGlossaryLoaded({ forceReload: true });

      const categoryKey =
        body.category && String(body.category).trim()
          ? String(body.category).trim().toLowerCase()
          : null;

      const categories = categoryKey ? [categoryKey] : Array.from(cache.byCategoryBySource.keys());
      const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);

      const updates = [];
      let updatedPlanned = 0;
      const skipped = [];
      const notFound = [];

      for (const item of body.entries) {
        const sourceText = String(item.sourceText ?? "").trim();
        const matches = sourceTextMap.get(sourceText);

        if (!matches || matches.length === 0) {
          notFound.push({ sourceText });
          continue;
        }

        // 동일 sourceText 중 가장 위 row를 사용
        const entry = matches.reduce((min, e) => (!min || e._rowIndex < min._rowIndex ? e : min), null);

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

      return res.status(200).json({
        ok: true,
        status: updatedCells > 0 ? "success" : "no_op",
        sheet: body.sheet ?? "Glossary",
        category: categoryKey ?? "ALL",
        sourceLang: body.sourceLang,
        fillOnlyEmpty: Boolean(body.fillOnlyEmpty),
        allowAnchorUpdate: Boolean(body.allowAnchorUpdate),
        writePlan: { intendedUpdates: updatedPlanned },
        result: { updatedCells },
        notFound,
        skipped,
      });
    } catch (e) {
      return res.status(e?.status ?? 500).json({ ok: false, error: e?.message });
    }
  });
}
