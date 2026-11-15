// Shared by the SSE controller and the Inngest function so the cache key,
// TTLs and "is this a valid stored response" check can never drift apart.

export const REQUIRED_STEPS = 6;
export const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
export const PENDING_TTL_SECONDS = 420;

// v2 = markdown-streamed generation. Old Redis entries (no version in the key)
// are ignored and replaced.
export const RESPONSE_VERSION = "v2";

export function createCacheKey(className, subject, chapter) {
  return ["lmp", "aicoach", RESPONSE_VERSION, className, subject, chapter].join(
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

export function isValidCoachResponse(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      Array.isArray(data.steps) &&
      data.steps.length === REQUIRED_STEPS &&
      data.steps.every(
        (step) =>
          step &&
          Number.isInteger(step.priority) &&
          typeof step.action === "string" &&
          step.action.trim().length > 0 &&
          typeof step.formula === "string"
      )
  );
}


export function createPendingKey(className, subject, chapter) {
  return `${createCacheKey(className, subject, chapter)}:pending`;
}