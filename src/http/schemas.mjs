/**
 * src/http/schemas.mjs
 * - REST/MCP 공용 Zod Schemas 모음
 *
 * ✅ 2026-01 changes
 * - Add sheet pass-through for Multi-Sheet (Glossary, Trans1~TransN)
 * - Add masking schemas (mask, mask/fromSheet, mask/apply)
 * - Add QA schema placeholder (glossary/qa/next) - route는 다음 단계에서 연결
 */

import { z } from "zod";

// ---------------- REST Schemas ----------------
export const InitSchema = z
  .object({
    sheet: z.string().min(1).optional(),
    category: z.string().min(1),
    sourceLang: z.string().min(1),
    targetLang: z.string().min(1),
  })
  .strict();

export const ReplaceSchema = z
  .object({
    sheet: z.string().min(1).optional(),

    sessionId: z.string().min(1).optional(),
    category: z.string().optional(),

    sourceLang: z.string().min(1).optional(),
    targetLang: z.string().min(1).optional(),

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
  )
  .strict();

export const UpdateSchema = z
  .object({
    sheet: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

// ✅ candidates/batch endpoint schema (운영 고정: divinePride만 허용)
export const CandidatesBatchSchema = z
  .object({
    sheet: z.string().min(1).optional(),

    category: z.string().optional(), // optional filter (ALL if omitted)
    sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
    sourceTexts: z.array(z.string().min(1)).min(1).max(500),
    targetLangs: z.array(z.string().min(1)).min(1).max(20),

    sources: z.array(z.enum(["divinePride"])).optional(),
    maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
    includeEvidence: z.boolean().optional().default(true),
  })
  .strict();

// ✅ apply endpoint schema (WRITE)
// - sourceLang can be en-US or ko-KR (row match will follow sourceLang)
// - allowAnchorUpdate controls writing to en-US column
export const ApplySchema = z
  .object({
    sheet: z.string().min(1).optional(),

    category: z.string().optional(), // optional filter; omit => ALL
    sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
    entries: z
      .array(
        z.object({
          sourceText: z.string().min(1),
          translations: z.record(z.string(), z.string().trim().min(1)),
        })
      )
      .min(1)
      .max(500),
    fillOnlyEmpty: z.boolean().optional().default(true),
    targetLangs: z.array(z.string().min(1)).optional(),
    allowAnchorUpdate: z.boolean().optional().default(false),
  })
  .strict();

// ✅ pending/next endpoint schema (read-only)
export const PendingNextSchema = z
  .object({
    sheet: z.string().min(1).optional(),

    category: z.string().optional(), // optional filter; omit => ALL
    sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
    targetLangs: z.array(z.string().min(1)).min(1).max(20),
    limit: z.number().int().min(1).max(500).optional().default(100),
    forceReload: z.boolean().optional().default(false),
  })
  .strict();

// ---------------- NEW: Mask Schemas ----------------

/**
 * ✅ /v1/translate/mask
 * - 입력 texts를 glossary 기반으로 마스킹해서 반환 (검수용)
 * - 응답 payload 폭발 방지: includeMap 기본 false
 */
export const MaskSchema = z
  .object({
    sheet: z.string().min(1).optional(),

    category: z.string().optional(),
    sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
    targetLang: z.string().min(1),

    texts: z.array(z.string()).min(1).max(2000),

    maskStyle: z.enum(["braces", "plain"]).optional().default("braces"),
    restoreStrategy: z.literal("glossaryTarget").optional().default("glossaryTarget"),

    includeMap: z.boolean().optional().default(false),
  })
  .strict();

/**
 * ✅ /v1/translate/mask/fromSheet
 * - sheet에서 sourceLang 컬럼을 읽고 glossary 기반 마스킹 수행
 * - 결과만 반환 (WRITE 없음)
 */
export const MaskFromSheetSchema = z
  .object({
    sheet: z.string().min(1),

    category: z.string().optional(),

    sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
    targetLang: z.string().min(1),

    limit: z.number().int().min(1).max(500).optional().default(100),
    cursor: z.number().int().min(0).optional().default(0),

    onlyIfMaskingEmpty: z.boolean().optional().default(true),

    // override header names if needed
    sourceHeader: z.string().min(1).optional(),
    maskingHeader: z.string().min(1).optional(),
  })
  .strict();

/**
 * ✅ /v1/translate/mask/apply
 * - 검수 후 마스킹 컬럼에 업로드
 */
export const MaskApplySchema = z
  .object({
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

    fillOnlyEmpty: z.boolean().optional().default(true),

    maskingHeader: z.string().min(1).optional(),
  })
  .strict();
