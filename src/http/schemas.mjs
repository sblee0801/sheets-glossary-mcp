// src/http/schemas.mjs
// - Minimal schemas for 2 Custom GPTs (Translate / QA)
// - sourceLang: en-US | ko-KR only
// - QA default limit: 100

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
 * ✅ Category normalization
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

// ---------------- Shared: /v1/glossary/update ----------------
export const UpdateSchema = z.object({
  sheet: SheetOpt,
});

// ---------------- QA: /v1/glossary/qa/next ----------------
export const GlossaryQaNextSchema = z.object({
  sheet: SheetOpt,
  category: CategoryStr.optional().default(""),

  // ✅ sourceLang only en-US | ko-KR
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLang: z.string().min(1),

  // ✅ default 100
  limit: z.number().int().min(1).max(500).optional().default(100),

  cursor: OptTrimmedStr,
  forceReload: z.boolean().optional().default(false),
});

// ---------------- QA: /v1/glossary/apply ----------------
export const ApplySchema = z.object({
  sheet: z.string().min(1),

  category: CategoryStr.optional().default(""),

  // ✅ sourceLang only en-US | ko-KR
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),

  entries: z
    .array(
      z.object({
        rowIndex: z.number().int().min(2),
        sourceText: z.string().min(1),
        translations: z.record(z.string(), z.string().trim().min(1)).refine(
          (m) => Object.keys(m).length > 0,
          { message: "translations must have at least 1 language entry" }
        ),
      })
    )
    .min(1)
    .max(500),
});

// ---------------- Translate: /v2/batch/run ----------------
export const BatchRunSchema = z.object({
  sheet: SheetOpt,
  category: CategoryStr.optional().default(""),

  // ✅ sourceLang only en-US | ko-KR
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLang: z.string().min(1),

  limit: z.number().int().min(1).max(500).optional().default(200),
  chunkSize: z.number().int().min(1).max(100).optional().default(25),

  fillOnlyEmpty: z.boolean().optional().default(true),
  upload: z.boolean().optional().default(true),

  forceReload: z.boolean().optional().default(false),
  excludeRowIndexes: z.array(z.number().int().min(2)).max(5000).optional(),

  // overwrite policy
  allowOverwrite: z.boolean().optional().default(false),

  // optional model override
  model: OptTrimmedStr,
});

// ---------------- Translate: /v2/batch/:id/anomalies ----------------
export const BatchAnomaliesQuerySchema = z.object({
  offset: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(500).optional().default(200),
});
