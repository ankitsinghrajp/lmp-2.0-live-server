// Shared by the SSE controller and the Inngest function so the cache key,
// TTLs and "is this a valid stored response" check can never drift apart.

export const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
export const PENDING_TTL_SECONDS = 420;

// v2 = new question shape (questionText, options, formulas, ...).
// Old Redis entries (key without version) and old MongoDB documents
// (question / questionType / marks / importance only) are ignored and replaced.
export const RESPONSE_VERSION = "v2";

export function createCacheKey(className, subject, chapter) {
  return [
    "lmp",
    "predicted",
    RESPONSE_VERSION,
    className,
    subject,
    chapter,
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

export function isValidQuestionResponse(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      Array.isArray(data.questions) &&
      data.questions.length > 0 &&
      data.questions.every(
        (question) =>
          question &&
          typeof question.questionText === "string" &&
          Array.isArray(question.options) &&
          Array.isArray(question.formulas) &&
          Array.isArray(question.tables) &&
          Array.isArray(question.diagrams) &&
          Array.isArray(question.graphs) &&
          Array.isArray(question.subQuestions) &&
          typeof question.questionType === "string" &&
          Number.isInteger(question.marks) &&
          typeof question.importance === "string"
      )
  );
}