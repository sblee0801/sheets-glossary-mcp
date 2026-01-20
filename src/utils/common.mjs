/**
 * src/utils/common.mjs
 * - 여러 모듈에서 공통으로 쓰는 유틸 함수 모음
 * - 상태(캐시) 없음: 순수 유틸 성격 유지
 */

import crypto from "crypto";

// ---------------- Normalize ----------------
export function normalizeHeader(h) {
  return String(h ?? "").trim().toLowerCase();
}

export function normalizeLang(lang) {
  if (!lang) return "";
  return String(lang).trim().toLowerCase().replace(/_/g, "-");
}

// ---------------- String helpers ----------------
export function escapeRegExp(s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------- Session / time ----------------
export function newSessionId() {
  return crypto.randomUUID?.() ?? crypto.randomBytes(16).toString("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------------- Body parsing ----------------
export function getParsedBody(req) {
  if (req.body == null) return undefined;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return req.body;
    }
  }
  return req.body;
}

// ---------------- Validation helpers ----------------
export function assertAllowedSourceLang(sourceLangKey) {
  if (sourceLangKey !== "ko-kr" && sourceLangKey !== "en-us") {
    const err = new Error("sourceLang must be ko-KR or en-US");
    err.status = 400;
    throw err;
  }
}

export function isLikelyEnglish(s) {
  const t = String(s ?? "").trim();
  if (!t) return false;
  const ascii = t.replace(/[^\x00-\x7F]/g, "");
  const ratio = ascii.length / Math.max(1, t.length);
  return ratio > 0.95;
}
