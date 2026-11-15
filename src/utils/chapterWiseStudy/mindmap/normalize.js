import { CONTENT_VERSION } from "./cache.js";

export const MIN_NODES = 8;
export const MAX_NODES = 60;
export const MAX_DEPTH = 3; // levels below the root
export const MAX_LABEL = 60;
export const MAX_NOTE = 180;

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/[$\\]/g, "")
    .replace(/^(?:[-*•#>]+|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * Turns the model's flat list into a clean tree:
 *  - drops empty / duplicate nodes
 *  - keeps exactly one root; other roots and nodes with a missing parent
 *    are attached to the root
 *  - drops cycles, anything deeper than MAX_DEPTH and anything over MAX_NODES
 *  - re-numbers ids in reading order ("1", "2", ...) and builds the edges
 *
 * Throws when the result is unusable, so the caller can retry.
 */
export function normalizeMindMap(raw) {
  const list = Array.isArray(raw?.nodes) ? raw.nodes : [];
  const items = new Map();

  for (const entry of list) {
    const id = String(entry?.id ?? "").trim();
    const label = cleanText(entry?.label, MAX_LABEL);

    if (!id || !label || items.has(id)) continue;

    const parentRaw = entry?.parentId == null ? "" : String(entry.parentId).trim();

    items.set(id, {
      id,
      label,
      note: cleanText(entry?.note, MAX_NOTE),
      parentId: parentRaw && parentRaw !== id ? parentRaw : null,
    });
  }

  if (items.size < MIN_NODES) {
    throw new Error(`Mind map has too few valid nodes (${items.size}).`);
  }

  const root = [...items.values()].find((item) => item.parentId === null);
  if (!root) throw new Error("Mind map has no root node.");

  const children = new Map([...items.keys()].map((id) => [id, []]));

  for (const item of items.values()) {
    if (item.id === root.id) continue;

    const parent =
      item.parentId && items.has(item.parentId) ? item.parentId : root.id;

    children.get(parent).push(item.id);
  }

  // Breadth-first: shallow nodes win when the size cap is reached.
  const keep = new Set([root.id]);
  const depth = new Map([[root.id, 0]]);
  const queue = [root.id];

  for (let i = 0; i < queue.length && keep.size < MAX_NODES; i++) {
    const id = queue[i];
    if (depth.get(id) >= MAX_DEPTH) continue;

    for (const child of children.get(id)) {
      if (keep.has(child)) continue;
      if (keep.size >= MAX_NODES) break;

      keep.add(child);
      depth.set(child, depth.get(id) + 1);
      queue.push(child);
    }
  }

  // Depth-first output keeps every branch together, in the model's order.
  const nodes = [];
  const edges = [];

  const walk = (id, parentNewId) => {
    const item = items.get(id);
    const newId = String(nodes.length + 1);

    nodes.push({ id: newId, label: item.label, note: item.note });

    if (parentNewId) {
      edges.push({
        id: `e${parentNewId}-${newId}`,
        source: parentNewId,
        target: newId,
      });
    }

    for (const child of children.get(id)) {
      if (keep.has(child)) walk(child, newId);
    }
  };

  walk(root.id, null);

  if (nodes.length < MIN_NODES) {
    throw new Error(`Mind map has too few connected nodes (${nodes.length}).`);
  }

  return { version: CONTENT_VERSION, title: nodes[0].label, nodes, edges };
}