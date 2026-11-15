export const aiCoachSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    steps: {
      type: "array",
      minItems: 6,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          priority: {
            type: "integer",
            enum: [1, 2, 3, 4, 5, 6],
            description:
              "Unique rank from 1 (most important) to 6 (least important). Each number is used exactly once.",
          },
          action: {
            type: "string",
            description:
              "One specific, exam-focused revision instruction in 1-2 sentences. Names what to revise or practise, never the full derivation or answer. Math only inside inline $...$ (none for Hindi, Sanskrit and English subjects). No Markdown.",
          },
          formula: {
            type: "string",
            description:
              "One standard formula for this step in raw LaTeX with single backslashes and no dollar delimiters, or an empty string if none applies. Always empty for Hindi, Sanskrit and English.",
          },
        },
        required: ["priority", "action", "formula"],
      },
    },
  },
  required: ["steps"],
};