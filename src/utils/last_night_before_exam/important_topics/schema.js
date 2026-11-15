
export const importantTopicsResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: {
            type: "string",
            description:
              "Short and precise name of an important CBSE chapter topic. Plain text, no LaTeX.",
          },
          explanation: {
            type: "string",
            description:
              "Concise definition in 1-2 sentences on a single line. Wrap any formula, symbol or number-with-unit in $...$ only if math is necessary. In JSON every LaTeX backslash is doubled.",
          },
          formula: {
            type: "string",
            description:
              "One standard formula in raw LaTeX with NO dollar delimiters (in JSON every backslash is doubled), or an empty string if the topic has no standard formula. Always empty for Hindi and Sanskrit.",
          },
        },
        required: ["topic", "explanation", "formula"],
      },
    },
  },
  required: ["topics"],
};

export const topicFixResponseSchema = {
  type: "object",
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          fixed: { type: "string" },
        },
        required: ["path", "fixed"],
        additionalProperties: false,
      },
    },
  },
  required: ["fixes"],
  additionalProperties: false,
};