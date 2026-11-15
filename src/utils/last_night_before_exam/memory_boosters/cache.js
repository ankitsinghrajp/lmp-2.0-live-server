/**
 * Shared by the controller AND the Inngest function so both always build the
 * same cache key and apply the same "is this cached value usable" check.
 * Stored value: { markdown: "## Acronym\n...\n\n## Story\n...\n\n## Pattern\n..." }
 */
import { getLanguageInfo } from "../predicted_questions/language.js";

// v3 = single Markdown string. Old JSON ({ boosters: [...] }) entries are never served.
export const RESPONSE_VERSION = "v3";
export const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const PENDING_TTL_SECONDS = 420;

/**
 * Language subjects ("Hindi: Kshitij Part 2") must be keyed by the FULL subject,
 * otherwise two books with the same lesson name would share one cache entry.
 * Other subjects keep using the main subject.
 */
export const resolveCacheSubject = (rawSubject, mainSubject) =>
  getLanguageInfo(rawSubject) ? String(rawSubject).trim() : mainSubject;

export const createBoostersCacheKey = (className, subject, chapter) =>
  ["lmp", "booster", RESPONSE_VERSION, className, subject, chapter].join(":");

export function parseCachedValue(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Newlines and tabs are normal in Markdown; other control characters mean corruption.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

export function isValidBoostersResponse(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      typeof data.markdown === "string" &&
      /^## Acronym\s*$/m.test(data.markdown) &&
      /^## Story\s*$/m.test(data.markdown) &&
      /^## Pattern\s*$/m.test(data.markdown) &&
      !CONTROL_CHARS_RE.test(data.markdown)
  );
}

/** Strips extra fields so the frontend always gets the same shape. */
export function normalizeBoostersContent(data) {
  return { markdown: data.markdown };
}