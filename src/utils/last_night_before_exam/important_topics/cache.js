/**
 * Shared by the controller AND the Inngest function so both always build the
 * same cache key and apply the same "is this cached value usable" check.
 * Stored value: { markdown: "## Topic\n\nExplanation...\n\n$$\nformula\n$$ ..." }
 */

// v3 = Markdown format. Old v2 (topics array) cache entries are never served.
export const RESPONSE_VERSION = "v3";
export const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const PENDING_TTL_SECONDS = 300;

export const createTopicsCacheKey = (className, subject, chapter) =>
  ["lmp", "impTopics", RESPONSE_VERSION, className, subject, chapter].join(":");

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

export function isValidTopicsResponse(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      typeof data.markdown === "string" &&
      data.markdown.trim() &&
      /^## /m.test(data.markdown) &&
      !CONTROL_CHARS_RE.test(data.markdown)
  );
}

/** Strips Mongo-only / extra fields so the frontend always gets the same shape. */
export function normalizeTopicsContent(data) {
  return { markdown: data.markdown };
}