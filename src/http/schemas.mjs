/**
 * src/http/schemas.mjs
 * - REST/MCP 공용 Zod Schemas 모음
 */

import { z } from "zod";

/**
 * 공통: 멀티 시트 지원을 위해 모든 endpoint schema에 sheet를 optional로 받는다.
 * (Zod 기본 동작상 정의되지 않은 키는 strip되므로, sheet를 스키마에 넣지 않으면 서버에서 항상 Glossary로 fallback됨)
 */

// ---------------- REST Schemas ----------------
export const InitSchema = z.object({
  sheet: z.string().optional(), // ✅ FIX: allow sheet
  category: z.string().min(1),
  sourceLang: z.string().min(1),
  targetLang: z.string().min(1),
});

export const ReplaceSchema = z
  .object({
    sheet: z.string().optional(), // ✅ FIX: allow sheet
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
  );

export const UpdateSchema = z.object({
  sheet: z.string().optional(), // ✅ FIX: allow sheet
  sessionId: z.string().min(1).optional(),
});

export const SuggestSchema = z.object({
  sheet: z.string().optional(),
  category: z.string().min(1),
  terms: z.array(z.string()).min(1).max(200),
  anchorLang: z.string().optional().default("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
  includeEvidence: z.boolean().optional().default(true),
  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  generateTargets: z.boolean().optional().default(false),
});

export const CandidatesSchema = z.object({
  sheet: z.string().optional(),
  category: z.string().min(1),
  sourceText: z.string().min(1),
  sourceLang: z.string().optional().default("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
});

export const CandidatesBatchSchema = z.object({
  sheet: z.string().optional(),
  category: z.string().optional(),
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  sourceTexts: z.array(z.string().min(1)).min(1).max(500),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),
  sources: z.array(z.enum(["divinePride"])).optional(),
  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  includeEvidence: z.boolean().optional().default(true),
});

export const ApplySchema = z.object({
  sheet: z.string().optional(), // ✅ Trans sheet apply 가능
  category: z.string().optional(),
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
  sheet: z.string().optional(), // ✅ 핵심 (Trans6 조회 문제 해결)
  category: z.string().optional(),
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),
  limit: z.number().int().min(1).max(500).optional().default(100),
  forceReload: z.boolean().optional().default(false),
});

// ---------------- QA ----------------
export const GlossaryQaNextSchema = z.object({
  sheet: z.string().optional(),
  category: z.string().optional(),
  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLang: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional().default(100),
  cursor: z.string().optional(),
  forceReload: z.boolean().optional().default(false),
});

// ---------------- Mask (read / processing) ----------------
export const MaskSchema = z.object({
  sheet: z.string().optional(), // operating sheet (Trans5/Trans6 etc)
  glossarySheet: z.string().optional().default("Glossary"),

  category: z.string().optional(),
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
  sheet: z.string().min(1),          // Trans sheet
  targetLang: z.string().min(1),     // ex) id-ID
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
