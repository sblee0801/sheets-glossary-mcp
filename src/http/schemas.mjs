/**
 * src/http/schemas.mjs
 * - REST/MCP 공용 Zod Schemas 모음
 *
 * NOTE (v3.1):
 * - candidates/batch: sourceLang은 en-US 또는 ko-KR 허용
 * - candidates/batch: category는 optional (없으면 ALL categories로 처리)
 * - apply: allowAnchorUpdate 지원(기존 유지)
 */

import { z } from "zod";

// ---------------- REST Schemas ----------------
export const InitSchema = z.object({
  category: z.string().min(1),
  sourceLang: z.string().min(1),
  targetLang: z.string().min(1),
});

export const ReplaceSchema = z
  .object({
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
  sessionId: z.string().min(1).optional(),
});

export const SuggestSchema = z.object({
  category: z.string().min(1),
  terms: z.array(z.string()).min(1).max(200),
  anchorLang: z.string().optional().default("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
  includeEvidence: z.boolean().optional().default(true),
  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  generateTargets: z.boolean().optional().default(false),
});

// ✅ candidates endpoint schema (MVP 유지)
export const CandidatesSchema = z.object({
  category: z.string().min(1),
  sourceText: z.string().min(1),
  sourceLang: z.string().optional().default("en-US"),
  targetLangs: z.array(z.string()).min(1).max(20),
  sources: z.array(z.enum(["iroWikiDb", "rateMyServer", "divinePride"])).optional(),
});

// ✅ candidates/batch endpoint schema
// - category: optional (omit => ALL categories)
// - sourceLang: en-US or ko-KR
// - sources: divinePride only (운영 고정)
export const CandidatesBatchSchema = z.object({
  category: z.string().optional(), // ✅ optional now
  sourceLang: z.string().optional().default("en-US"), // ✅ allow en-US/ko-KR (server validates normalized)
  sourceTexts: z.array(z.string().min(1)).min(1).max(500),
  targetLangs: z.array(z.string().min(1)).min(1).max(20),

  // ✅ 운영 정책: divinePride만 사용
  // - 생략 시 서버가 ["divinePride"]로 처리
  // - 지정 시에도 divinePride만 허용
  sources: z.array(z.enum(["divinePride"])).optional(),

  maxCandidatesPerLang: z.number().int().min(1).max(5).optional().default(2),
  includeEvidence: z.boolean().optional().default(true),
});

// ✅ apply endpoint schema
// - en-US anchor 기반 row match
// - category: optional filter
// - allowAnchorUpdate: en-US column update gate
export const ApplySchema = z.object({
  category: z.string().optional(), // ✅ optional filter
  sourceLang: z.string().optional().default("en-US"),
  entries: z
    .array(
      z.object({
        sourceText: z.string().min(1),
        translations: z.record(
          z.string(), // key: "ko-KR", "de-DE" 등
          z.string().trim().min(1) // value: 번역 문자열
        ),
      })
    )
    .min(1)
    .max(500),
  fillOnlyEmpty: z.boolean().optional().default(true),
  targetLangs: z.array(z.string().min(1)).optional(),

  // ✅ NEW: en-US(Anchor) 컬럼 수정 게이트
  allowAnchorUpdate: z.boolean().optional().default(false),
});
