/**
 * Predicted Questions schema.
 *
 * Same question shape as the Important Questions feature
 * (questionText, options, formulas, tables, diagrams, graphs, subQuestions)
 * plus three metadata fields: questionType, marks, importance.
 *
 * No minItems / maxItems: strict structured outputs handle them poorly, and the
 * question count is enforced in code instead.
 */

// Descriptive types only: no MCQ and no Assertion Reason.
export const QUESTION_TYPES = [
  "Short Answer",
  "Long Answer",
  "Numerical",
  "Case Based",
  "Source Based",
];

// Hindi / Sanskrit / English: descriptive questions only.
export const LANGUAGE_QUESTION_TYPES = ["Short Answer", "Long Answer"];

export const OBJECTIVE_TYPES = ["MCQ", "Assertion Reason"];

export const IMPORTANCE_LEVELS = ["Very High", "High"];

const buildQuestionSchema = ({ language }) => {
  const properties = {
    questionText: {
      type: "string",
      description: language
        ? "Main question statement only, written entirely in the requested language. Plain text, no LaTeX. It must be a descriptive question answered in sentences, never a multiple-choice question and never refer to options or choices."
        : "Main question statement only. Wrap every formula, symbol and number-with-unit in \\( ... \\). For a case-based question this is the full case / passage. Never a multiple-choice question and never refer to options or choices. If the question uses tabulated data, refer to it (e.g. 'from the following data') and put the data in 'tables'.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      description:
        "Always []. There are no multiple-choice questions.",
    },
    formulas: {
      type: "array",
      items: { type: "string" },
      description: language
        ? "Always [] for language subjects."
        : "Usually []. Only an equation the question itself GIVES as data for the student to work on. Never an answer, solution step, or a formula needed to solve the question.",
    },
    tables: {
      type: "array",
      items: { type: "string" },
      description: language
        ? "Always [] for language subjects."
        : "Usually []. Only when the question needs tabulated data that fits the given subject and chapter. Each item is one Markdown table: header row, separator row (| --- | --- |), then data rows, joined by \\n. Never invent data.",
    },
    diagrams: {
      type: "array",
      items: { type: "string" },
      description: language
        ? "Always [] for language subjects."
        : "Usually []. Text description of a required diagram, never the diagram itself.",
    },
    graphs: {
      type: "array",
      items: { type: "string" },
      description: language
        ? "Always [] for language subjects."
        : "Usually []. Text description of a required graph: axes, variables, units.",
    },
    subQuestions: {
      type: "array",
      items: { type: "string" },
      description: language
        ? "Optional descriptive sub-questions in the requested language, WITHOUT labels such as (a) or (i). Usually []. Never options or choices."
        : "Sub-questions in order, WITHOUT labels such as (a) or (i); the UI adds them. Used for case-based / source-based questions. Do not repeat the main question. Descriptive only, never options.",
    },
    questionType: {
      type: "string",
      enum: language ? LANGUAGE_QUESTION_TYPES : QUESTION_TYPES,
      description: "Type of the question.",
    },
    marks: {
      type: "integer",
      enum: [1, 2, 3, 4, 5, 6],
      description:
        "Short Answer = 2 or 3; Numerical = 2 to 5; Long Answer = 4 to 6; Case Based / Source Based = 4.",
    },
    importance: {
      type: "string",
      enum: IMPORTANCE_LEVELS,
      description:
        "'Very High' for core, very frequently tested patterns (at least 3 questions), otherwise 'High'.",
    },
  };

  // Language subjects never get answer choices, so the field does not exist.
  // The service adds "options": [] afterwards.
  if (language) delete properties.options;

  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
};

const buildResponseSchema = (questionSchema) => ({
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: questionSchema,
    },
  },
  required: ["questions"],
  additionalProperties: false,
});

export const predictedQuestionsResponseSchema = buildResponseSchema(
  buildQuestionSchema({ language: false })
);

export const languagePredictedQuestionsResponseSchema = buildResponseSchema(
  buildQuestionSchema({ language: true })
);

export const getPredictedQuestionsSchema = (isLanguage) =>
  isLanguage
    ? languagePredictedQuestionsResponseSchema
    : predictedQuestionsResponseSchema;