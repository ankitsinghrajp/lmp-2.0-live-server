/**
 * Shared by the controller AND the Inngest function.
 * Stored value (Redis): { markdown: "**Concept**\nline\n\n$$ ... $$\n\n**Next**..." }
 * Stored value (Mongo): the same markdown as a plain string (same as before,
 * so notes already in the database keep working).
 */
import { getLanguageInfo } from "../../last_night_before_exam/predicted_questions/language.js";

// v2 = single Markdown string. Old Redis keys had no version and are never read.
export const RESPONSE_VERSION = "v2";
export const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const PENDING_TTL_SECONDS = 300;

/**
 * Language subjects ("Hindi: Kshitij Part 2") are keyed by the FULL subject so
 * two books with the same lesson name never share an entry.
 */
export const resolveCacheSubject = (rawSubject, mainSubject) =>
  getLanguageInfo(rawSubject) ? String(rawSubject).trim() : mainSubject;

export const createNotesCacheKey = (className, subject, chapter) =>
  ["lmp", "shortnotes", RESPONSE_VERSION, className, subject, chapter].join(":");

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

/** Accepts a Markdown string (Mongo) or { markdown } (Redis). Returns { markdown } or null. */
export function toNotesContent(value) {
  if (typeof value === "string") return { markdown: value };
  if (value && typeof value === "object" && typeof value.markdown === "string") {
    return { markdown: value.markdown };
  }
  return null;
}

export function isValidNotesResponse(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      typeof data.markdown === "string" &&
      data.markdown.trim().length >= 30 &&
      /\*\*[^*\n]+\*\*/.test(data.markdown) &&
      !CONTROL_CHARS_RE.test(data.markdown)
  );
}

/** Strips extra fields so the frontend always gets the same shape. */
export const normalizeNotesContent = (data) => ({ markdown: data.markdown });