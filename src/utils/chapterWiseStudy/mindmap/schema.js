/**
 * Flat tree. Strict structured output is more reliable with a flat list than
 * with a deeply recursive schema. The service rebuilds and validates the tree.
 */
export const mindMapResponseSchema = {
  type: "object",
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: 'Short unique id such as "1", "2", "3".',
          },
          parentId: {
            type: ["string", "null"],
            description:
              "The id of the parent node. null ONLY for the single root node (the chapter).",
          },
          label: {
            type: "string",
            description:
              "Node name only, at most 6 words. Plain text: no numbering, no sentences, no markdown, no LaTeX.",
          },
          note: {
            type: "string",
            description:
              "One short sentence (at most 20 words) explaining the node: definition, meaning or key point. Plain text.",
          },
        },
        required: ["id", "parentId", "label", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["nodes"],
  additionalProperties: false,
};