// src/utils/common.mjs
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
  if (sourceLangKey !== "ko-kr" && sourceLangKey !== "en-us" && sourceLangKey !== "th-th") {
    const err = new Error("sourceLang must be ko-KR, en-US, or th-TH");
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

// ---------------- Line break handling ----------------
// 줄바꿈 문자를 <br> 태그로 변환하는 함수
export function formatTextWithLineBreaks(text) {
  if (typeof text === 'string') {
    return text.replace(/\n/g, "<br>");
  }
  return text;
}
