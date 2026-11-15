export const CACHE_TTL_SECONDS = 60 * 60 * 24 * 2;
export const PENDING_TTL_SECONDS = 120;

// Same key as before, so summaries already cached in Redis and Mongo stay valid.
export function createCacheKey(className, subject, chapter) {
  return `lmp:smartsummary:${className}:${subject}:${chapter}`;
}

export function isValidSummaryResponse(data) {
  return (
    data &&
    typeof data === "object" &&
    typeof data.summary === "string" &&
    data.summary.trim().length > 0
  );
}