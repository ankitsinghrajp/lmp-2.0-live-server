// Shared by the SSE controller and the Inngest function so the cache key,
// TTLs and "is this a valid stored response" check can never drift apart.
//
// The response shape is identical to Predicted Questions, so the parse and
// validity helpers are reused from there (one fix applies to both features).

export {
  parseCachedValue,
  isValidQuestionResponse,
} from "../../last_night_before_exam/predicted_questions/cache.js";

export const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
export const PENDING_TTL_SECONDS = 420;

// v2 = new question shape (questionText, options, formulas, ...).
// Old Redis entries (key without version, { question } only) and old MongoDB
// documents fail isValidQuestionResponse and are replaced after a successful run.
export const RESPONSE_VERSION = "v2";

export function createCacheKey(className, subject, chapter) {
  return ["lmp", "studyq", RESPONSE_VERSION, className, subject, chapter].join(
    ":"
  );
}