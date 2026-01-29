/**
 * src/http/schemas.mjs
 * - REST Zod Schemas
 * - FIX:
 *   1) Allow category=null coming from CustomGPT (normalize to undefined)
 *   2) Add excludeRowIndexes to pending/next to support client-side skip + dedupe
 */

import { z } from "zod";

/**
 * Helpers
 * - CustomGPT Actions sometimes send null for optional strings.
 * - Normalize: null/undefined/"" -> undefined, and trim strings.
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

const SheetOpt = OptTrimmedStr; // defaulting happens in routes via pickSheet()

// ---------------- REST Schemas ----------------
export const InitSchema = z.object({
  sheet: SheetOpt, // ✅ allow sheet
  category: z.string().min(1),
  sourceLang: z.string().min(1),
  targetLang: z.string().min(1),
});

export const ReplaceSchema = z
  .object({
    sheet: SheetOpt, // ✅ allow sheet
    sessionId: OptTrimmedStr,
    category: OptTrimmedStr, // ✅ allow null/"" safely
    sourceLang: OptTrimmedStr,
    targetLang: OptTrimmedStr,
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
  sheet: SheetOpt, // ✅ allow sheet
  sessionId: OptTrimmedStr,
});

export const SuggestSchema = z.object({
  sheet: SheetOpt,
  category: z.string().min(1),
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
  category: z.string().min(1),
  sourceText: z.string().min(1),
  sourceLang: OptTrimmedStr.default("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
});

export const CandidatesBatchSchema = z.object({
  sheet: SheetOpt,
  category: OptTrimmedStr, // ✅ allow null/"" safely
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  sourceTexts: z.array(z.string().min(1)).min(1).max(500),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),
  sources: z.array(z.enum(["divinePride"])).optional(),
  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  includeEvidence: z.boolean().optional().default(true),
});

export const ApplySchema = z.object({
  sheet: SheetOpt, // ✅ Trans sheet apply 가능
  category: OptTrimmedStr, // ✅ allow null/"" safely
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
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
  sheet: SheetOpt, // ✅ 핵심 (Trans6 조회 문제 해결)
  category: OptTrimmedStr, // ✅ allow null/"" safely

  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),

  limit: z.number().int().min(1).max(500).optional().default(100),
  forceReload: z.boolean().optional().default(false),

  /**
   * ✅ NEW: excludeRowIndexes
   * - client can pass rows to skip (e.g., already processed in the current run)
   * - server may also use its internal recent-applied gate separately
   */
  excludeRowIndexes: z.array(z.number().int().min(2)).max(5000).optional(),
});

// ---------------- QA ----------------
export const GlossaryQaNextSchema = z.object({
  sheet: SheetOpt,
  category: OptTrimmedStr, // ✅ allow null/"" safely
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLang: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional().default(100),
  cursor: OptTrimmedStr,
  forceReload: z.boolean().optional().default(false),
});

// ---------------- Mask (read / processing) ----------------
export const MaskSchema = z.object({
  sheet: SheetOpt, // operating sheet (Trans5/Trans6 etc)
  glossarySheet: OptTrimmedStr.default("Glossary"),

  category: OptTrimmedStr, // ✅ allow null/"" safely
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLang: z.string().min(1),

  texts: z.array(z.string()).min(1).max(500),

  maskStyle: z.enum(["braces"]).optional().default("braces"),
  restoreStrategy: z.enum(["glossaryTarget", "anchor"]).optional().default("glossaryTarget"),

  caseSensitive: z.boolean().optional().default(true),
  wordBoundary: z.boolean().optional().default(true),

  forceReload: z.boolean().optional().default(false),
});

// ---------------- Mask Apply (WRITE) ----------------
/**
 * POST /v1/translate/mask/apply
 * - 마스킹된 결과를 <targetLang>-Masking 컬럼에 업로드
 */
export const MaskApplySchema = z.object({
  sheet: z.string().min(1), // Trans sheet
  targetLang: z.string().min(1), // ex) id-ID
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
