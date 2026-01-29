/**
 * src/http/schemas.mjs
 * - REST Zod Schemas
 *
 * FIX:
 * 1) CustomGPT/Connector가 optional string에 null/undefined/""을 보낼 수 있음
 * 2) 특히 category는 누락(undefined)되면 "expected string, received undefined"가 자주 발생
 *    => category는 항상 string(빈문자 허용)으로 normalize하여 downstream이 안정적으로 처리하게 함
 * 3) pending/next에 excludeRowIndexes 유지
 * 4) (보너스) texts가 단일 string으로 올 때 array로 normalize
 */

import { z } from "zod";

/**
 * Helpers
 * - Optional trimmed string: null/undefined/"" -> undefined
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
 * Helpers
 * - Required trimmed string: trims and requires min(1)
 */
const ReqTrimmedStr = z.preprocess((v) => {
  if (typeof v === "string") return v.trim();
  return v;
}, z.string().min(1));

/**
 * ✅ Category normalization (most important)
 * - CustomGPT가 category를:
 *   - 아예 누락(undefined) / null / "" 로 보낼 수 있음
 * - 서버 로직은 보통:
 *   - "" (or falsy) => ALL 처리
 * - 따라서 schema 레벨에서 category는 "항상 string"으로 보장:
 *   - null/undefined -> ""
 *   - string -> trim (빈 문자열 유지)
 */
const CategoryStr = z.preprocess((v) => {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  // 이상 타입이 오면 z.string()에서 에러
  return v;
}, z.string());

/**
 * Sheet optional
 * - defaulting happens in routes via pickSheet()
 */
const SheetOpt = OptTrimmedStr;

/**
 * ✅ texts normalization (connector가 단일 문자열로 보낼 때 방어)
 * - string -> [string]
 * - null/undefined -> [] (이후 min(1)에서 잡힘)
 */
const TextsArray = z.preprocess((v) => {
  if (v == null) return [];
  if (typeof v === "string") return [v];
  return v;
}, z.array(z.string()));

// ---------------- REST Schemas ----------------
export const InitSchema = z.object({
  sheet: SheetOpt,
  // ✅ FIX: Init에서도 category 누락 허용 + 항상 string으로 normalize
  // routes에서 "" => ALL/세션 기본 카테고리 없음 처리 가능
  category: CategoryStr.optional().default(""),
  sourceLang: ReqTrimmedStr,
  targetLang: ReqTrimmedStr,
});

export const ReplaceSchema = z
  .object({
    sheet: SheetOpt,
    sessionId: OptTrimmedStr,

    // ✅ FIX: category는 항상 string (빈 문자열 허용)
    category: CategoryStr.optional().default(""),

    sourceLang: OptTrimmedStr,
    targetLang: OptTrimmedStr,

    // texts도 커넥터 방어: string -> [string]
    texts: TextsArray.min(1),

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

  // ✅ FIX: Suggest도 커넥터에서 category 누락될 수 있으니 string normalize
  // (Suggest가 category 필수 정책이어도, 서버에서 ""을 받은 뒤 처리로 강제할 수 있음)
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

  // ✅ FIX
  category: CategoryStr.optional().default(""),

  sourceText: z.string().min(1),
  sourceLang: OptTrimmedStr.default("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
});

export const CandidatesBatchSchema = z.object({
  sheet: SheetOpt,

  // ✅ FIX: batch도 category normalize
  category: CategoryStr.optional().default(""),

  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  sourceTexts: z.array(z.string().min(1)).min(1).max(500),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),
  sources: z.array(z.enum(["divinePride"])).optional(),
  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  includeEvidence: z.boolean().optional().default(true),
});

export const ApplySchema = z.object({
  sheet: SheetOpt,

  // ✅ FIX: apply도 category normalize
  category: CategoryStr.optional().default(""),

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
  sheet: SheetOpt,

  // ✅ FIX
  category: CategoryStr.optional().default(""),

  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),

  limit: z.number().int().min(1).max(500).optional().default(100),
  forceReload: z.boolean().optional().default(false),

  /**
   * ✅ excludeRowIndexes
   * - client can pass rows to skip (already processed in the current run)
   */
  excludeRowIndexes: z.array(z.number().int().min(2)).max(5000).optional(),
});

// ---------------- QA ----------------
export const GlossaryQaNextSchema = z.object({
  sheet: SheetOpt,

  // ✅ FIX
  category: CategoryStr.optional().default(""),

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

  // ✅ FIX: 여기서 터졌던 케이스 방어 (undefined/null/"" -> "")
  category: CategoryStr.optional().default(""),

  sourceLang: z.enum(["en-US", "ko-KR"]).optional().default("en-US"),
  targetLang: z.string().min(1),

  // ✅ texts도 커넥터 방어
  texts: TextsArray.min(1).max(500),

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
