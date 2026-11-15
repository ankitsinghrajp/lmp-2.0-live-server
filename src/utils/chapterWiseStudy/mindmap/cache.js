/**
 * Shared by the controller AND the Inngest function so both build the same
 * keys and apply the same "is this stored mind map usable" check.
 *
 * Stored value (Redis and Mongo `content`):
 *   { version: 2, title, nodes: [{ id, label, note }], edges: [{ id, source, target }] }
 */
import { getLanguageInfo } from "../../last_night_before_exam/predicted_questions/language.js";

// v2 = tree without coordinates (layout is done in the browser).
// Old v1 entries (nodes with x/y) are never served: they live under other keys
// and fail the version check in the database.
export const RESPONSE_VERSION = "v2";
export const CONTENT_VERSION = 2;
export const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const PENDING_TTL_SECONDS = 240;
export const ERROR_TTL_SECONDS = 60;

/** Language subjects ("Hindi: Kshitij Part 2") are keyed by the FULL subject. */
export const resolveCacheSubject = (rawSubject, mainSubject) =>
  getLanguageInfo(rawSubject) ? String(rawSubject).trim() : mainSubject;

export const createMindMapCacheKey = (className, subject, chapter) =>
  ["lmp", "mindmap", RESPONSE_VERSION, className, subject, chapter].join(":");

export const pendingKeyOf = (cacheKey) => `${cacheKey}:pending`;
export const errorKeyOf = (cacheKey) => `${cacheKey}:error`;

export function parseCachedValue(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function isValidMindMap(data) {
  if (!data || typeof data !== "object" || data.version !== CONTENT_VERSION) {
    return false;
  }
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) return false;
  if (data.nodes.length < 2) return false;

  const ids = new Set();

  for (const node of data.nodes) {
    if (
      !node ||
      typeof node.id !== "string" ||
      typeof node.label !== "string" ||
      !node.label.trim()
    ) {
      return false;
    }
    ids.add(node.id);
  }

  return data.edges.every(
    (edge) => edge && ids.has(edge.source) && ids.has(edge.target)
  );
}

/** Strips extra fields so the frontend always gets the same shape. */
export const normalizeMindMapContent = (data) => ({
  version: CONTENT_VERSION,
  title: typeof data.title === "string" ? data.title : data.nodes[0].label,
  nodes: data.nodes.map(({ id, label, note }) => ({
    id,
    label,
    note: typeof note === "string" ? note : "",
  })),
  edges: data.edges.map(({ id, source, target }) => ({ id, source, target })),
});