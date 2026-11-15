// Shared by the SSE controller and the Inngest function so the cache key,
// TTLs and "is this a valid stored response" check can never drift apart.

export const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
export const PENDING_TTL_SECONDS = 420;

// v2 = new math format (\( ... \)) and streaming pipeline.
// Old Redis entries (key without version) and old MongoDB documents (math in
// $...$) are ignored and replaced.
export const RESPONSE_VERSION = "v2";

export function createCacheKey(className, subject, chapter) {
  return ["lmp", "mcqs", RESPONSE_VERSION, className, subject, chapter].join(
    ":"
  );
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

export function isValidMcqResponse(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      Array.isArray(data.mcqs) &&
      data.mcqs.length > 0 &&
      data.mcqs.every(
        (mcq) =>
          mcq &&
          typeof mcq.question === "string" &&
          Array.isArray(mcq.options) &&
          mcq.options.length === 4 &&
          mcq.options.every((o) => typeof o === "string") &&
          typeof mcq.correct === "string" &&
          mcq.options.includes(mcq.correct) &&
          typeof mcq.explanation === "string" &&
          typeof mcq.formula === "string" &&
          // Old-format documents used $...$ for math. Treat them as stale.
          !/\$/.test(mcq.question)
      )
  );
}