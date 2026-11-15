export const generatedQuestionSchema = {
  type: "object",
  properties: {
    questionText: {
      type: "string",
      description:
        "Main question statement only. Wrap every formula, symbol and number-with-unit in \\( ... \\). If the question uses tabulated data, refer to it (e.g. 'from the following data') and put the data in 'tables'.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Options in original order. Same math-wrapping rules as questionText.",
    },
    formulas: {
      type: "array",
      items: { type: "string" },
      description:
        "Usually []. Only an equation the question itself GIVES as data for the student to work on. Never an answer, solution step, or a formula needed to solve the question.",
    },
    tables: {
      type: "array",
      items: { type: "string" },
      description:
        "Usually []. Only when the question needs tabulated data that fits the given subject and chapter. Each item is one Markdown table: header row, separator row (| --- | --- |), then data rows, joined by \\n. Never invent data.",
    },
    diagrams: {
      type: "array",
      items: { type: "string" },
      description: "Text description of a required diagram, never the diagram itself.",
    },
    graphs: {
      type: "array",
      items: { type: "string" },
      description: "Text description of a required graph: axes, variables, units.",
    },
    subQuestions: {
      type: "array",
      items: { type: "string" },
      description:
        "Sub-questions in order, WITHOUT labels such as (a) or (i); the UI adds them. Do not repeat the main question.",
    },
  },
  required: ["questionText", "options", "formulas", "tables", "diagrams", "graphs", "subQuestions"],
  additionalProperties: false,
};