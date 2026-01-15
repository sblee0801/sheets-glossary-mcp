import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { google } from "googleapis";

/**
 * ============================================================
 * Sheets Glossary Replace Server (Cloud Run, Node.js ESM)
 *
 * 핵심 요구사항 반영:
 * - Glossary는 "세션당 1회" 로드하고, 사용자가 업데이트 요청 전까지 고정
 * - TERM(V열)은 완전히 무시 (ko-KR과 동일하므로)
 * - 행이 5000개면 5000개를 "온전히" 로드 (중복 제거/필터로 삭제하지 않음)
 * - 치환은 category + ko-KR 기준으로 수행 (Phase 1)
 * - 대량 texts[]를 한번에 처리
 *
 * 엔드포인트:
 * - POST /v1/session/init
 * - POST /v1/translate/replace
 * - POST /v1/glossary/update
 * - GET  /healthz
 * ============================================================
 */

const PORT = Number(process.env.PORT || 8080);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Glossary";

/**
 * 사용자 시트 구조(스크린샷 기준):
 * A: KEY
 * I: 분류
 * K~U: 국가별 번역 데이터(ko-KR 포함)
 * V: TERM (사용 안 함)
 *
 * ✅ TERM을 완전히 무시하므로 범위는 A:U까지만 읽습니다.
 */
const SHEET_RANGE = process.env.SHEET_RANGE || `${SHEET_NAME}!A:U`;

if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is missing. Check env.");
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing. Check env.");

// ---------------- Helpers ----------------
function normalizeHeader(h) {
  return String(h ?? "").trim().toLowerCase();
}
function normalizeLang(lang) {
  if (!lang) return "";
  return String(lang).trim().toLowerCase().replace(/_/g, "-");
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function newSessionId() {
  return crypto.randomUUID?.() ?? crypto.randomBytes(16).toString("hex");
}

// ---------------- Google Sheets Read ----------------
async function readSheetRange() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
  });

  const values = res.data.values || [];
  if (values.length < 1) return { header: [], rows: [] };

  const header = (values[0] || []).map((h) => String(h ?? "").trim());
  const rows = values.slice(1);

  return { header, rows };
}

/**
 * Glossary 로드 (A:U)
 * - ✅ 행 삭제/중복 제거 없음: "온전히" 로드
 * - 필수 헤더: KEY, 분류, ko-KR
 * - TERM은 범위에 없고, 설령 있어도 사용하지 않음
 */
async function loadGlossaryAll() {
  const { header, rows } = await readSheetRange();
  if (!header.length) {
    return {
      header: [],
      entries: [],
      rawRowCount: 0,
      langIndex: {},
      loadedAt: new Date().toISOString(),
    };
  }

  const norm = header.map(normalizeHeader);

  // KEY / 분류 인덱스 (헤더명 기준)
  const idxKey = norm.indexOf("key");
  const idxCategory = norm.indexOf("분류"); // 사용 시트가 "분류"로 되어 있다고 가정

  if (idxKey < 0) throw new Error("헤더에 KEY가 없습니다. A열 헤더가 'KEY'인지 확인하세요.");
  if (idxCategory < 0)
    throw new Error("헤더에 분류가 없습니다. I열 헤더가 '분류'인지 확인하세요.");

  // 언어 컬럼 인덱스 맵 생성
  // - A:U 범위 내의 언어 컬럼(ko-kr, en-us, zh-cn, ...)을 헤더 기반으로 매핑
  // - 비언어 컬럼은 제외 목록으로 제거
  const excluded = new Set([
    "key",
    "분류",
    "category",
    "term", // 혹시 범위 안에 있어도 제외
    "len",
    "length",
    "gt_lang",
    "note",
    "notes",
    "번역메모",
    "클리펀트",
    "우선순위",
    "priority",
    "src_lang",
    "match_type",
    "atch_type",
    "src_len",
    "trg_len",
  ]);

  const langIndex = {};
  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    if (!h) continue;
    if (excluded.has(h)) continue;
    langIndex[h] = i; // ex) "ko-kr" -> col index
  }

  // ko-KR은 치환 기준(소스) 컬럼이므로 필수
  if (langIndex["ko-kr"] == null) {
    throw new Error("헤더에 ko-KR이 없습니다. 언어 컬럼 헤더가 'ko-KR'인지 확인하세요.");
  }

  // ✅ 행을 온전히 로드: 필터링 없이 그대로 entries에 넣음
  // (다만 rows의 컬럼 길이가 짧을 수 있으니 안전하게 접근)
  const entries = rows.map((r, rowIdx) => {
    const key = String(r[idxKey] ?? "").trim();
    const category = String(r[idxCategory] ?? "").trim();

    const translations = {};
    for (const [langKey, colIdx] of Object.entries(langIndex)) {
      const v = String(r[colIdx] ?? "").trim();
      // 비어있는 번역도 "온전히" 로드 관점에서는 보존할 수 있으나,
      // 실제 치환에는 필요 없으므로 값이 있을 때만 저장 (메모리 최적화)
      if (v) translations[langKey] = v;
    }

    const ko = String(r[langIndex["ko-kr"]] ?? "").trim();

    return {
      // 행 추적/디버깅을 위해 row index 유지(1-based sheet row는 +2)
      _rowIndex: rowIdx + 2,
      key,
      category,
      ko, // ko-KR 원문
      translations, // 타겟 언어 포함
    };
  });

  return {
    header,
    entries,
    rawRowCount: rows.length,
    langIndex,
    loadedAt: new Date().toISOString(),
  };
}

// ---------------- Session Cache (In-Memory) ----------------
/**
 * sessions.get(sessionId) = {
 *   sessionId,
 *   categoryKey, sourceLangKey, targetLangKey,
 *   glossary: { entries, rawRowCount, loadedAt, byCategoryKo },
 * }
 *
 * byCategoryKo:
 *   Map<categoryLower, Map<koString, entry[]>>  // ✅ 중복 보존 위해 배열
 */
const sessions = new Map();

function getSessionOrThrow(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) {
    const err = new Error("Invalid sessionId (session not found or expired).");
    err.status = 404;
    throw err;
  }
  return s;
}

function buildIndexPreserveDuplicates(entries) {
  const byCategoryKo = new Map();

  for (const e of entries) {
    const cat = String(e.category ?? "").trim().toLowerCase();
    if (!cat) continue;

    const ko = String(e.ko ?? "").trim();
    if (!ko) continue; // ko가 비면 치환 기준이 될 수 없으므로 인덱스에서는 제외 (entries 자체는 유지됨)

    if (!byCategoryKo.has(cat)) byCategoryKo.set(cat, new Map());
    const koMap = byCategoryKo.get(cat);

    if (!koMap.has(ko)) koMap.set(ko, []);
    koMap.get(ko).push(e); // ✅ 중복 보존
  }

  return byCategoryKo;
}

/**
 * Phase 1: Glossary 치환
 * - category는 세션에서 고정
 * - ko-KR 문자열이 텍스트에 포함되면 targetLang 값으로 치환
 * - 동일 category에서 동일 ko가 여러 행 존재(중복)해도, entries는 보존하되
 *   치환 결과는 "시트 상 먼저 등장한(배열[0]) 항목 중 target 번역이 있는 것"을 사용
 */
function replaceByGlossary({ text, targetLangKey, koMap }) {
  if (typeof text !== "string" || !text) {
    return { out: text ?? "", replacedTotal: 0 };
  }

  // 치환 우선순위: 긴 문자열부터 (부분 중첩 방지)
  const terms = Array.from(koMap.keys()).sort((a, b) => b.length - a.length);

  let out = text;
  let replacedTotal = 0;

  for (const ko of terms) {
    const candidates = koMap.get(ko) || [];

    // 중복 중 "타겟 번역이 존재하는 첫 후보" 선택 (결정적/안정적)
    let target = "";
    for (const c of candidates) {
      const v = c?.translations?.[targetLangKey];
      if (v && String(v).trim()) {
        target = String(v).trim();
        break;
      }
    }
    if (!target) continue; // 타겟이 없으면 치환 안 함

    const re = new RegExp(escapeRegExp(ko), "g");
    let localCount = 0;
    out = out.replace(re, () => {
      localCount += 1;
      return target;
    });
    replacedTotal += localCount;
  }

  return { out, replacedTotal };
}

// ---------------- HTTP App ----------------
const app = express();
app.use(express.json({ limit: "8mb" }));

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

/**
 * POST /v1/session/init
 * body: { category, sourceLang, targetLang }
 *
 * - Glossary를 1회 로드하고 sessionId 반환
 * - category는 세션 고정
 * - sourceLang은 정책상 "ko-KR"로 쓰는 게 일반적이지만, 현재 치환 기준은 ko-KR 고정
 */
app.post("/v1/session/init", async (req, res) => {
  try {
    const category = String(req.body?.category ?? "").trim();
    const sourceLang = String(req.body?.sourceLang ?? "ko-KR").trim();
    const targetLang = String(req.body?.targetLang ?? "").trim();

    if (!category) return res.status(400).json({ ok: false, error: "category is required" });
    if (!targetLang) return res.status(400).json({ ok: false, error: "targetLang is required" });

    const categoryKey = category.toLowerCase();
    const sourceLangKey = normalizeLang(sourceLang);
    const targetLangKey = normalizeLang(targetLang);

    const loaded = await loadGlossaryAll();
    const byCategoryKo = buildIndexPreserveDuplicates(loaded.entries);

    if (!byCategoryKo.has(categoryKey)) {
      return res.status(400).json({
        ok: false,
        error: `Category not found in glossary index: ${category}`,
        hint: "분류(I열) 값이 정확히 일치하는지 확인하세요.",
      });
    }

    // 타겟 언어 컬럼 존재 여부는 '있으면 치환, 없으면 치환 없음'으로 처리 가능
    // 여기서는 명확하게 오류로 막지 않고 info로만 알려줌
    const hasTargetLangColumn = loaded.langIndex[targetLangKey] != null;

    const sessionId = newSessionId();
    sessions.set(sessionId, {
      sessionId,
      categoryKey,
      sourceLangKey,
      targetLangKey,
      glossary: {
        entries: loaded.entries, // ✅ 전체 행 보존(5000개면 5000개)
        rawRowCount: loaded.rawRowCount,
        loadedAt: loaded.loadedAt,
        byCategoryKo,
      },
    });

    return res.status(200).json({
      ok: true,
      sessionId,
      category: categoryKey,
      sourceLang: sourceLangKey,
      targetLang: targetLangKey,
      glossaryLoadedAt: loaded.loadedAt,
      rawRowCount: loaded.rawRowCount, // ✅ "온전히" 가져온 행 수
      hasTargetLangColumn,
      note: hasTargetLangColumn
        ? undefined
        : `Target language column '${targetLangKey}' not found in header. Replace will produce zero substitutions.`,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * POST /v1/translate/replace
 * body: { sessionId, texts: string[] }
 *
 * - Phase 1 (Glossary 치환)만 수행
 * - 세션 캐시 사용 (시트 재조회 없음)
 */
app.post("/v1/translate/replace", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const texts = req.body?.texts;

    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId is required" });
    if (!Array.isArray(texts) || texts.length < 1)
      return res.status(400).json({ ok: false, error: "texts[] is required" });

    const s = getSessionOrThrow(sessionId);

    const koMap = s.glossary.byCategoryKo.get(s.categoryKey);
    if (!koMap) {
      return res.status(400).json({
        ok: false,
        error: `Category index not found in session: ${s.categoryKey}`,
      });
    }

    const outTexts = [];
    let replacedTotal = 0;

    for (const t of texts) {
      const { out, replacedTotal: c } = replaceByGlossary({
        text: String(t ?? ""),
        targetLangKey: s.targetLangKey,
        koMap,
      });
      outTexts.push(out);
      replacedTotal += c;
    }

    return res.status(200).json({
      ok: true,
      sessionId,
      category: s.categoryKey,
      targetLang: s.targetLangKey,
      replacedTotal,
      texts: outTexts,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/**
 * POST /v1/glossary/update
 * body: { sessionId }
 *
 * - 사용자가 명시적으로 업데이트를 요청했을 때만 시트를 재조회
 * - 해당 세션의 캐시를 새로 고침
 */
app.post("/v1/glossary/update", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId is required" });

    const s = getSessionOrThrow(sessionId);

    const loaded = await loadGlossaryAll();
    const byCategoryKo = buildIndexPreserveDuplicates(loaded.entries);

    if (!byCategoryKo.has(s.categoryKey)) {
      return res.status(400).json({
        ok: false,
        error: `Category not found after reload: ${s.categoryKey}`,
      });
    }

    s.glossary = {
      entries: loaded.entries, // ✅ 전체 행 보존
      rawRowCount: loaded.rawRowCount,
      loadedAt: loaded.loadedAt,
      byCategoryKo,
    };
    sessions.set(sessionId, s);

    return res.status(200).json({
      ok: true,
      sessionId,
      category: s.categoryKey,
      targetLang: s.targetLangKey,
      glossaryLoadedAt: loaded.loadedAt,
      rawRowCount: loaded.rawRowCount,
    });
  } catch (e) {
    const status = e?.status ?? 500;
    return res.status(status).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`Sheet range: ${SHEET_RANGE}`);
  console.log(`TERM is ignored. 기준: category(I) + ko-KR(K)`);
});
