// src/http/routes.mjs
// FINAL: Server-side QA engine
// - QA sheet and Glossary sheet are separated explicitly
// - /v1/qa/run performs anchor forced validation via reverse glossary lookup
// - Detects wrong-language anchors like «T:Cracked Rift» in id-ID and replaces with id-ID glossary value
// - Returns maskSummary + finalize

import {
  normalizeLang,
  getParsedBody,
  escapeRegExp,
} from "../utils/common.mjs";

import {
  ensureGlossaryLoaded,
} from "../cache/global.mjs";

import {
  mergeSourceTextMapsFromCache,
} from "../glossary/index.mjs";

import {
  colIndexToA1,
  batchUpdateValuesA1,
} from "../google/sheets.mjs";

import {
  GlossaryQaNextSchema,
  ApplySchema,
  UpdateSchema,
} from "./schemas.mjs";

/* ---------------- Helpers ---------------- */

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra;
  return e;
}

function toJson(res, status, payload) {
  res.status(status).json(payload);
}

function handleErr(res, e) {
  toJson(res, Number(e?.status) || 500, {
    ok: false,
    error: String(e?.message ?? e),
    extra: e?.extra,
  });
}

function pickSheet(v) {
  return String(v?.sheet ?? "Glossary").trim() || "Glossary";
}

function normalizeBody(body) {
  const b = body && typeof body === "object" ? body : {};
  if (b.category == null) b.category = "";
  if (b.sheet == null) b.sheet = "Glossary";
  return b;
}

// NBSP + zero-width + BOM 제거
function strip(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
    .trim();
}

/* ---------------- Core Apply Logic (SHARED) ---------------- */

async function handleApply(req, res) {
  const body = normalizeBody(getParsedBody(req));
  const v = ApplySchema.parse(body);

  const sheet = pickSheet(v);
  const cache = await ensureGlossaryLoaded({ sheetName: sheet, forceReload: false });

  const sourceLangKey = normalizeLang(v.sourceLang);
  if (!sourceLangKey) throw httpError(400, "apply sourceLang is required.");

  const srcCol = cache.langIndex[sourceLangKey];
  if (srcCol == null) throw httpError(400, "Missing sourceLang column");

  const updates = [];
  const results = [];

  for (const entry of v.entries) {
    const rowIndex = Number(entry.rowIndex);
    const sourceText = strip(entry.sourceText);

    if (!Number.isFinite(rowIndex) || rowIndex < 2) {
      results.push({ rowIndex, status: "skipped", reason: "invalid_rowIndex" });
      continue;
    }

    const rowArrIdx = rowIndex - 2;
    if (rowArrIdx < 0 || rowArrIdx >= cache.rawRows.length) {
      results.push({ rowIndex, status: "skipped", reason: "rowIndex_out_of_range" });
      continue;
    }

    const rawRow = cache.rawRows[rowArrIdx] || [];
    const actualSrc = strip(rawRow[srcCol]);

    if (actualSrc !== sourceText) {
      results.push({ rowIndex, status: "skipped", reason: "source_mismatch" });
      continue;
    }

    let updated = 0;

    for (const [lang, valRaw] of Object.entries(entry.translations || {})) {
      const langKey = normalizeLang(lang);
      const val = strip(valRaw);
      if (!langKey || !val) continue;

      const colIdx = cache.langIndex[langKey];
      if (colIdx == null) continue;

      const a1 = `${sheet}!${colIndexToA1(colIdx)}${rowIndex}`;
      updates.push({ range: a1, values: [[val]] });
      updated += 1;
    }

    results.push({
      rowIndex,
      updatedCellsPlanned: updated,
      status: updated ? "success" : "no_op",
    });
  }

  const writeRes = await batchUpdateValuesA1(updates);
  await ensureGlossaryLoaded({ sheetName: sheet, forceReload: true });

  toJson(res, 200, {
    ok: true,
    sheet,
    plannedUpdates: updates.length,
    updatedCells: writeRes.updatedCells,
    updatedRanges: writeRes.updatedRanges,
    results,
  });
}

/* ---------------- Routes ---------------- */

export function registerRoutes(app) {

  /* ---------- Health ---------- */

  app.get("/health", (_req, res) => {
    toJson(res, 200, { ok: true });
  });

  /* ---------- Glossary Update ---------- */

  app.post("/v1/glossary/update", async (req, res) => {
    try {
      const body = normalizeBody(getParsedBody(req));
      const v = UpdateSchema.parse(body);

      const sheet = pickSheet(v);
      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: true,
      });

      toJson(res, 200, {
        ok: true,
        sheet: cache.sheetName,
        glossaryLoadedAt: cache.loadedAt,
        rawRowCount: cache.rawRowCount,
        categoriesCount: cache.byCategoryBySource.size,
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  /* ---------- QA Next ---------- */

  app.post("/v1/glossary/qa/next", async (req, res) => {
    try {
      const body = normalizeBody(getParsedBody(req));
      const v = GlossaryQaNextSchema.parse(body);

      const sheet = pickSheet(v);
      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: Boolean(v.forceReload),
      });

      const sourceLangKey = normalizeLang(v.sourceLang);
      const targetLangKey = normalizeLang(v.targetLang);

      const srcCol = cache.langIndex[sourceLangKey];
      const tgtCol = cache.langIndex[targetLangKey];

      if (srcCol == null) throw httpError(400, "Missing sourceLang column");
      if (tgtCol == null) throw httpError(400, "Missing targetLang column");

      const categoryKey =
        v.category && String(v.category).trim()
          ? String(v.category).trim().toLowerCase()
          : null;

      const limit = Number(v.limit ?? 50);
      let start = Number(v.cursor ?? 0);

      const items = [];

      for (let i = start; i < cache.entries.length; i++) {
        const entry = cache.entries[i];
        const row = cache.rawRows[i] || [];
        const rowIndex = i + 2;

        if (categoryKey) {
          const c = String(entry?.category ?? "").trim().toLowerCase();
          if (c !== categoryKey) continue;
        }

        const sourceText = strip(row[srcCol]);
        const targetText = strip(row[tgtCol]);

        if (!sourceText || !targetText) continue;

        items.push({ rowIndex, sourceText, targetText });

        if (items.length >= limit) {
          start = i + 1;
          break;
        }
      }

      toJson(res, 200, {
        ok: true,
        sheet: cache.sheetName,
        sourceLang: v.sourceLang,
        targetLang: v.targetLang,
        cursorNext: start < cache.entries.length ? String(start) : null,
        items,
      });

    } catch (e) {
      handleErr(res, e);
    }
  });

  /* ---------- Mask Endpoint (기존 유지) ---------- */

  app.post("/v1/translate/mask", async (req, res) => {
    try {
      const body = getParsedBody(req) || {};

      const sheet = String(body.sheet ?? "Glossary").trim();
      const targetLangKey = normalizeLang(body.targetLang);
      const texts = Array.isArray(body.texts)
        ? body.texts.map((x) => String(x ?? ""))
        : [];

      if (!targetLangKey) throw httpError(400, "targetLang is required.");
      if (!texts.length) throw httpError(400, "texts must be non-empty array.");

      const cache = await ensureGlossaryLoaded({
        sheetName: sheet,
        forceReload: false,
      });

      const categories = Array.from(cache.byCategoryBySource.keys());

      // 기존 방식 그대로: ko-KR 기준 source map (필요 시)
      const sourceTextMap = mergeSourceTextMapsFromCache(cache, "ko-kr", categories);

      const termSet = new Set();
      for (const entries of sourceTextMap.values()) {
        for (const e of entries || []) {
          const t = String(e?.translations?.[targetLangKey] ?? "").trim();
          if (t) termSet.add(t);
        }
      }

      const targetTerms = Array.from(termSet).sort((a, b) => b.length - a.length);

      const compiled = targetTerms.map((term) => ({
        term,
        re: new RegExp(escapeRegExp(term), "g"),
      }));

      let nextId = 1;
      const masks = [];
      const textsMasked = [];

      for (const raw of texts) {
        let out = String(raw ?? "");

        for (const { term, re } of compiled) {
          out = out.replace(re, () => {
            const id = nextId++;
            const token = `{mask:${id}}`;
            masks.push({ id, anchor: token, restore: term });
            return token;
          });
        }

        textsMasked.push(out);
      }

      toJson(res, 200, {
        ok: true,
        sheet,
        targetLang: targetLangKey,
        textsMasked,
        masks,
        summary: {
          inputTexts: texts.length,
          masks: masks.length,
          uniqueTerms: targetTerms.length,
        },
      });

    } catch (e) {
      handleErr(res, e);
    }
  });

  /* =========================================================
     🔥 NEW: /v1/qa/run (Server-side full QA + Anchor forced validation)
     핵심 수정:
       - QA 시트(요청 sheet)와 Glossary 시트("Glossary")를 반드시 분리
       - reverseMap은 무조건 Glossary 시트에서 생성
       - targetText의 «T:... » anchor만 역매핑으로 강제 검증/교체
  ========================================================= */

  app.post("/v1/qa/run", async (req, res) => {
    try {
      const body = getParsedBody(req) || {};

      // QA 대상 시트
      const qaSheet = String(body.sheet ?? "").trim();
      const sourceLangKey = normalizeLang(body.sourceLang);
      const targetLangKey = normalizeLang(body.targetLang);
      const limit = Number(body.limit ?? 50);
      const cursor = Number(body.cursor ?? 0);

      if (!qaSheet) throw httpError(400, "sheet is required.");
      if (!sourceLangKey) throw httpError(400, "sourceLang is required.");
      if (!targetLangKey) throw httpError(400, "targetLang is required.");

      // ✅ 분리 로드: QA 시트 / Glossary 시트
      const qaCache = await ensureGlossaryLoaded({
        sheetName: qaSheet,
        forceReload: false,
      });

      const glossaryCache = await ensureGlossaryLoaded({
        sheetName: "Glossary",
        forceReload: false,
      });

      // QA 시트에서 읽을 컬럼
      const qaSrcCol = qaCache.langIndex[sourceLangKey];
      const qaTgtCol = qaCache.langIndex[targetLangKey];
      if (qaSrcCol == null) throw httpError(400, "Missing sourceLang column in QA sheet");
      if (qaTgtCol == null) throw httpError(400, "Missing targetLang column in QA sheet");

      // Glossary 시트에서 targetLang 컬럼 존재해야 함
      const gTgtCol = glossaryCache.langIndex[targetLangKey];
      if (gTgtCol == null) throw httpError(400, "Missing targetLang column in Glossary sheet");

      /* ---------- 1) QA 대상 수집 ---------- */

      const items = [];
      let nextCursor = cursor;

      for (let i = cursor; i < qaCache.entries.length; i++) {
        const row = qaCache.rawRows[i] || [];
        const rowIndex = i + 2;

        const sourceText = strip(row[qaSrcCol]);
        const targetText = strip(row[qaTgtCol]);

        if (!sourceText || !targetText) continue;

        items.push({ rowIndex, sourceText, targetText });

        if (items.length >= limit) {
          nextCursor = i + 1;
          break;
        }
      }

      /* ---------- 2) Glossary reverseMap 생성 (역매핑) ---------- */
      // reverseMap[valueInAnyLang] => { correct: targetLangValue, lang: thatValueLangKey }
      // IMPORTANT: This must be built from Glossary sheet, not QA sheet.

      // Glossary source 기준을 정함: 가능한 경우 sourceLangKey를 쓰고, 없으면 ko-kr로 폴백
      const glossarySourceKey = glossaryCache.langIndex[sourceLangKey] != null
        ? sourceLangKey
        : "ko-kr";

      const categories = Array.from(glossaryCache.byCategoryBySource.keys());
      const sourceTextMap = mergeSourceTextMapsFromCache(glossaryCache, glossarySourceKey, categories);

      const reverseMap = Object.create(null);

      for (const entries of sourceTextMap.values()) {
        for (const e of entries || []) {
          const translations = e?.translations || {};
          const correct = strip(translations[targetLangKey] ?? "");
          if (!correct) continue;

          // translations에 있는 모든 값(각 언어)을 역키로 등록
          for (const [langKeyRaw, valRaw] of Object.entries(translations)) {
            const langKey = normalizeLang(langKeyRaw);
            const val = strip(valRaw);
            if (!langKey || !val) continue;

            // 동일 키가 여러 번 들어오면 "긴 값 우선" 같은 정책을 둘 수 있지만,
            // 여기선 먼저 들어온 것을 유지(충돌 방지) + 완전 동일이면 상관 없음.
            if (reverseMap[val] == null) {
              reverseMap[val] = { correct, lang: langKey };
            }
          }

          // e.source가 별도로 존재하면 그것도 역키로 등록 (안전)
          const srcVal = strip(e?.source ?? "");
          if (srcVal && reverseMap[srcVal] == null) {
            reverseMap[srcVal] = { correct, lang: glossarySourceKey };
          }
        }
      }

      /* ---------- 3) Anchor 강제 검증 + 교체 ---------- */

      const finalize = [];
      const maskSummary = [];

      // «T:... » anchor 파서
      const anchorRegex = /«T:([^»]+)»/g;

      for (const item of items) {
        let modified = item.targetText;
        const applied = [];

        // matchAll 결과는 index 포함. 교체 시 index가 변하므로 안정적으로 처리:
        // - 원본 문자열을 기준으로 왼쪽부터 rebuild 하며 변경
        const matches = [...modified.matchAll(anchorRegex)];
        if (matches.length === 0) continue;

        let rebuilt = "";
        let lastIndex = 0;

        for (const m of matches) {
          const full = m[0];         // «T:Cracked Rift»
          const inner = strip(m[1]); // Cracked Rift
          const idx = Number(m.index ?? 0);

          // 앞부분 붙이기
          rebuilt += modified.slice(lastIndex, idx);

          const info = reverseMap[inner];

          if (info && info.lang !== targetLangKey) {
            // 잘못된 언어 anchor -> targetLang correct로 교체
            rebuilt += `«T:${info.correct}»`;

            applied.push({
              source: `${inner} (${info.lang})`,
              target: info.correct,
            });
          } else {
            // 정상/알 수 없음 -> 그대로 유지
            rebuilt += full;
          }

          lastIndex = idx + full.length;
        }

        // 나머지 꼬리 붙이기
        rebuilt += modified.slice(lastIndex);

        if (applied.length > 0) {
          maskSummary.push({
            rowIndex: item.rowIndex,
            applied,
          });
        }

        if (rebuilt !== item.targetText) {
          finalize.push({
            rowIndex: item.rowIndex,
            translation: rebuilt,
          });
        }
      }

      toJson(res, 200, {
        ok: true,
        cursorNext: nextCursor < qaCache.entries.length ? String(nextCursor) : null,
        hasFix: finalize.length > 0,
        maskSummary,
        finalize,
      });

    } catch (e) {
      handleErr(res, e);
    }
  });

  /* ---------- Apply ---------- */

  app.post("/run-apply", async (req, res) => {
    try {
      await handleApply(req, res);
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post("/v1/glossary/apply", async (req, res) => {
    try {
      await handleApply(req, res);
    } catch (e) {
      handleErr(res, e);
    }
  });

}
