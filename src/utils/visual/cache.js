import { createHash } from "node:crypto";

// v4: results are now Markdown (```mermaid block). Older keys are ignored.
export const CACHE_VERSION = "v4";
export const VISUAL_TYPES = ["diagram", "graph"];

export function parseCachedValue(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export const isValidVisual = (data) =>
  Boolean(data) &&
  typeof data === "object" &&
  VISUAL_TYPES.includes(data.type) &&
  data.format === "text/markdown" &&
  typeof data.mermaid === "string" &&
  data.mermaid.trim().length > 0 &&
  typeof data.markdown === "string" &&
  data.markdown.startsWith("```mermaid");

export function createVisualKeys({ type, description, subject, className }) {
  const contentHash = createHash("sha256")
    .update(JSON.stringify({ type, description, subject, className }))
    .digest("hex");

  return {
    contentHash,
    cacheKey: `lmp:visual:${CACHE_VERSION}:${contentHash}`,
    pendingKey: `lmp:visual:${CACHE_VERSION}:pending:${contentHash}`,
  };
}