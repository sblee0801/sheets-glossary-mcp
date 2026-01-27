/**
 * src/http/schemas.mjs
 * - REST 공용 Zod Schemas 모음
 */

import { z } from "zod";

/**
 * CustomGPT/Actions에서 optional 필드가 null로 오는 케이스가 흔함.
 * 서버에서 null을 undefined로 정규화해서 1차부터 실패하지 않게 한다.
 */
const nullToUndefined = (schema) =>
  z.preprocess((v) => (v === null ? undefined : v), schema);

const optString = () => nullToUndefined(z.string()).optional();
const optStringDefault = (def) => nullToUndefined(z.string()).optional().default(def);

/**
 * ApplyEntry 정규화:
 * - translations가 없으면: (rowIndex/sourceText/translations 제외한) 나머지 키들을 translations 레코드로 승격
 * - translations가 배열이면: [{lang,text}] -> { [lang]: text }
 * - translations가 null이면: undefined로 처리 후 위 규칙 적용
 */
function normalizeApplyEntry(raw) {
  if (!raw || typeof raw !== "object") return raw;

  // shallow copy
  const obj = { ...raw };

  // normalize null -> undefined
  if (obj.translations === null) obj.translations = undefined;

  // case 1) translations as array -> record
  if (Array.isArray(obj.translations)) {
    const rec = {};
    for (const it of obj.translations) {
      if (!it || typeof it !== "object") continue;
      const lang = String(it.lang ?? it.language ?? "").trim();
      const text = String(it.text ?? it.value ?? "").trim();
      if (lang && text) rec[lang] = text;
    }
    obj.translations = rec;
    return obj;
  }

  // case 2) translations missing -> promote extra keys
  if (obj.translations === undefined) {
    const rec = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "rowIndex" || k === "sourceText" || k === "translations") continue;
      if (typeof v === "string" && v.trim()) rec[k] = v.trim();
    }
    if (Object.keys(rec).length > 0) obj.translations = rec;
  }

  return obj;
}

// ---------------- REST Schemas ----------------
export const InitSchema = z.object({
  sheet: optString(),
  category: z.string().min(1),
  sourceLang: z.string().min(1),
  targetLang: z.string().min(1),
});

export const ReplaceSchema = z
  .object({
    sheet: optString(),
    sessionId: optString(),
    category: optString(),
    sourceLang: optString(),
    targetLang: optString(),
    texts: z.array(z.string()).min(1),
    includeLogs: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    debug: z.boolean().optional(),
  })
  .refine(
    (v) => {
      if (v.sessionId) return true;
      return Boolean(v.sourceLang) && Boolean(v.targetLang);
    },
    { message: "If sessionId is not provided, sourceLang and targetLang are required." }
  );

export const UpdateSchema = z.object({
  sheet: optString(),
  sessionId: optString(),
});

export const SuggestSchema = z.object({
  sheet: optString(),
  category: z.string().min(1),
  terms: z.array(z.string()).min(1).max(200),
  anchorLang: optStringDefault("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
  includeEvidence: z.boolean().optional().default(true),
  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  generateTargets: z.boolean().optional().default(false),
});

export const CandidatesSchema = z.object({
  sheet: optString(),
  category: z.string().min(1),
  sourceText: z.string().min(1),
  sourceLang: optStringDefault("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
});

export const CandidatesBatchSchema = z.object({
  sheet: optString(),
  category: optString(),
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  sourceTexts: z.array(z.string().min(1)).min(1).max(500),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),
  sources: z.array(z.enum(["divinePride"])).optional(),
  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  includeEvidence: z.boolean().optional().default(true),
});

// ✅ ApplyEntry with normalization
const ApplyEntrySchema = z
  .preprocess(
    normalizeApplyEntry,
    z.object({
      rowIndex: z.number().int().min(2).optional(),
      sourceText: z.string().min(1),
      translations: z.record(z.string(), z.string().trim().min(1)).optional(),
    })
  )
  .superRefine((v, ctx) => {
    const t = v.translations ?? {};
    if (typeof t !== "object" || Array.isArray(t) || Object.keys(t).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "translations is required and must contain at least 1 non-empty item (record). Example: translations: { \"id-ID\": \"...\" }",
        path: ["translations"],
      });
    }
  });

export const ApplySchema = z.object({
  sheet: optString(),
  category: optString(),
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  entries: z.array(ApplyEntrySchema).min(1).max(500),
  fillOnlyEmpty: z.boolean().optional().default(true),
  targetLangs: z.array(z.string().min(1)).optional(),
  allowAnchorUpdate: z.boolean().optional().default(false),
});

export const PendingNextSchema = z.object({
  sheet: optString(),
  category: optString(),
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),
  limit: z.number().int().min(1).max(500).optional().default(100),
  forceReload: z.boolean().optional().default(false),
});

// ---------------- QA ----------------
export const GlossaryQaNextSchema = z.object({
  sheet: optString(),
  category: optString(),
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLang: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional().default(100),
  cursor: optString(),
  forceReload: z.boolean().optional().default(false),
});

// ---------------- Mask (read / processing) ----------------
export const MaskSchema = z.object({
  sheet: optString(),
  glossarySheet: optStringDefault("Glossary"),

  category: optString(), // category:null 허용 → undefined 정규화
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLang: z.string().min(1),

  texts: z.array(z.string()).min(1).max(500),

  maskStyle: z.enum(["braces"]).optional().default("braces"),
  restoreStrategy: z.enum(["glossaryTarget", "anchor"]).optional().default("glossaryTarget"),

  caseSensitive: z.boolean().optional().default(true),
  wordBoundary: z.boolean().optional().default(true),

  forceReload: z.boolean().optional().default(false),

  includeMasks: z.boolean().optional().default(true),
  includeRestore: z.boolean().optional().default(true),
  includeAnchor: z.boolean().optional().default(true),
});

// ---------------- Mask Apply (WRITE) ----------------
export const MaskApplySchema = z.object({
  sheet: z.string().min(1),
  targetLang: z.string().min(1),
  entries: z
    .array(
      z.object({
        rowIndex: z.number().int().min(2),
        maskedText: z.string().min(1),
      })
    )
    .min(1)
    .max(2000),
});
