const conceptSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "Concept name only, a few words. No numbering, no bold markers. Wrap any symbol or chemical formula in inline $...$.",
    },
    explanation: {
      type: "array",
      items: { type: "string" },
      description:
        "1 or 2 short lines, one array item per line: only the definition, meaning or key idea. No examples, derivations, bullets or numbering. Wrap every symbol, chemical formula and number-with-unit in inline $...$.",
    },
    formulas: {
      type: "array",
      items: { type: "string" },
      description:
        "Usually []. Each item is ONE complete equation (or chemical equation) as raw LaTeX WITHOUT $ delimiters. Symbols only: no words, no \\text, no units. At most 2 items. Never an equation without explanation.",
    },
    table: {
      type: "string",
      description:
        "Usually ''. Only for statistical or tabulated data: ONE Markdown table, header row, separator row (| --- | --- |), then data rows joined by \\n. Never invent data.",
    },
  },
  required: ["name", "explanation", "formulas", "table"],
  additionalProperties: false,
};

export const shortNotesResponseSchema = {
  type: "object",
  properties: {
    concepts: { type: "array", items: conceptSchema },
  },
  required: ["concepts"],
  additionalProperties: false,
};

/**
 * Hindi / Sanskrit / English lessons: no math at all. Built from the shared
 * schema without touching it. The service adds formulas: [] and table: "".
 */
const languageConceptSchema = (() => {
  const schema = structuredClone(conceptSchema);

  delete schema.properties.formulas;
  delete schema.properties.table;
  schema.required = ["name", "explanation"];

  schema.properties.name.description =
    "Concept name only, a few words, in the requested language. Plain text, no numbering, no bold markers.";
  schema.properties.explanation.description =
    "1 or 2 short lines, one array item per line, in the requested language: only the meaning or key idea. Plain text. No bullets or numbering.";

  return schema;
})();

export const languageShortNotesResponseSchema = {
  type: "object",
  properties: {
    concepts: { type: "array", items: languageConceptSchema },
  },
  required: ["concepts"],
  additionalProperties: false,
};

export const latexFixResponseSchema = {
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