export const memoryBoosterSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    boosters: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: ["acronym", "story", "pattern"],
            description:
              "Exactly one booster of each type: acronym, story, pattern.",
          },
          content: {
            type: "string",
            description:
              "Plain-text booster. acronym: the abbreviation, then what each letter stands for, one per line. story: 3 to 5 short sentences. pattern: a short sequence, grouping or comparison, one item per line. Math only inside $...$ with single backslashes (none for Hindi, Sanskrit and English subjects). No Markdown headings or code fences.",
          },
        },
        required: ["type", "content"],
      },
    },
  },
  required: ["boosters"],
};