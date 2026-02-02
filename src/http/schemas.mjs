// src/http/schemas.mjs
import { z } from "zod";

/**
 * Optional trimmed string:
 * - null/undefined/"" -> undefined
 * - string -> trimmed (if non-empty)
 */
const OptTrimmedStr = z
  .preprocess((v) => {
    if (v == null) return undefined;
    if (typeof v === "string") {
      const s = v.trim();
      return s ? s : undefined;
    }
    return v;
  }, z.string().min(1))
  .optional();

/**
 * Required trimmed string:
 * - string -> trimmed and min(1)
 */
const ReqTrimmedStr = z.preprocess((v) => {
  if (typeof v === "string") return v.trim();
  return v;
}, z.string().min(1));

/**
 * ✅ Category normalization (critical)
 * - undefined/null -> ""
 * - string -> trim (empty allowed)
 */
const CategoryStr = z.preprocess((v) => {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  return v;
}, z.string());

/**
 * Sheet optional (defaulting happens in routes via pickSheet)
 */
const SheetOpt = OptTrimmedStr;

/**
 * ✅ Texts normalization
 * - string -> [string]
 * - null/undefined -> [] (min(1) will fail if required)
 */
const TextsParam = z.preprocess(
  (v) => {
    if (v == null) return [];
    if (typeof v === "string") return [v];
    return v;
  },
  z.array(z.string()).min(1).max(500)
);

// ---------------- REST Schemas ----------------
export const InitSchema = z.object({
  sheet: SheetOpt,
  category: CategoryStr.optional().default(""),
  sourceLang: ReqTrimmedStr,
  targetLang: ReqTrimmedStr,
});

export const ReplaceSchema = z
  .object({
    sheet: SheetOpt,
    sessionId: OptTrimmedStr,

    category: CategoryStr.optional().default(""),

    sourceLang: OptTrimmedStr,
    targetLang: OptTrimmedStr,

    texts: TextsParam, // ✅ already min(1)/max(500)

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
  sheet: SheetOpt,
  sessionId: OptTrimmedStr,
});

export const SuggestSchema = z.object({
  sheet: SheetOpt,
  category: CategoryStr.optional().default(""),

  terms: z.array(z.string()).min(1).max(200),
  anchorLang: OptTrimmedStr.default("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
  includeEvidence: z.boolean().optional().default(true),
  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  generateTargets: z.boolean().optional().default(false),
});

export const CandidatesSchema = z.object({
  sheet: SheetOpt,
  category: CategoryStr.optional().default(""),

  sourceText: z.string().min(1),
  sourceLang: OptTrimmedStr.default("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
});

export const CandidatesBatchSchema = z.object({
  sheet: SheetOpt,
  category: CategoryStr.optional().default(""),

  sourceLang: z.enum(["en-US", "ko-KR", "th-TH"]).optional().default("en-US"),
  sourceTexts: z.array(z.string().min(1)).min(1).max(500),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),
  sources: z.array(z.enum(["divinePride"])).optional(),
  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  includeEvidence: z.boolean().optional().default(true),
});

export const ApplySchema = z.object({
  sheet: SheetOpt,
  category: CategoryStr.optional().default(""),

  sourceLang: z.enum(["en-US", "ko-KR", "th-TH"]).optional().default("en-US"),
  entries: z
    .array(
      z.object({
        rowIndex: z.number().int().min(2).optional(),
        sourceText: z.string().min(1),
        translations: z.record(z.string(), z.string().trim().min(1)),
      })
    )
    .min(1)
    .max(500),
  fillOnlyEmpty: z.boolean().optional().default(true),
  targetLangs: z.array(z.string().min(1)).optional(),
  allowAnchorUpdate: z.boolean().optional().default(false),
});

export const PendingNextSchema = z.object({
  sheet: SheetOpt,
  category: CategoryStr.optional().default(""),

  sourceLang: z.enum(["en-US", "ko-KR", "th-TH"]).optional().default("en-US"),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),

  limit: z.number().int().min(1).max(500).optional().default(100),
  forceReload: z.boolean().optional().default(false),

  excludeRowIndexes: z.array(z.number().int().min(2)).max(5000).optional(),
});
