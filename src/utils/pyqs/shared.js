import { normalizeClass } from "../important_questions/validation.utils.js";

// Bump this when the stored shape/format changes. It is part of the Redis key
// and is stored inside `content.version`, so older (non-RAG) DB documents are
// ignored and replaced after the next successful generation.
export const RESPONSE_VERSION = "v2";

export const CACHE_TTL_SECONDS = 60 * 60 * 24 * 2;
export const PENDING_TTL_SECONDS = 420;

// A PYQ set must contain MIN..MAX questions.
export const MIN_PYQS = 10;
export const MAX_PYQS = 15;

/**
 * One cache-key builder used by BOTH the controller and the Inngest function,
 * so the two can never drift apart.
 * "12th", "12" and "Class 12" all map to the same key.
 */
export function createPyqCacheKey(className, subject, chapter, year) {
  const classKey = normalizeClass(className) || String(className).trim();

  return [
    "lmp",
    "pyq",
    RESPONSE_VERSION,
    classKey,
    subject,
    chapter,
    year,
  ].join(":");
}

export function parseCachedValue(value) {
  if (!value) return null;

  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** True only for a v2 PYQ response: { version, pyqs: [{ question, marks, ... }] } */
export function isCurrentPyqResponse(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      data.version === RESPONSE_VERSION &&
      Array.isArray(data.pyqs) &&
      data.pyqs.length > 0 &&
      data.pyqs.every(
        (item) =>
          item &&
          typeof item.question === "string" &&
          item.question.trim() &&
          Number.isFinite(Number(item.marks))
      )
  );
}