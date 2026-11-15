/**
 * MCQ schema.
 *
 * Differences from the old schema (these caused most validation errors):
 *  - No minItems / maxItems: strict structured outputs handle them poorly and
 *    they contradicted "return fewer if you cannot find good ones". The count
 *    is enforced in code instead.
 *  - The correct answer is a zero-based INDEX (correctIndex), not a copy of the
 *    option text. Copying text character for character, including math, was the
 *    most common reason a whole response was rejected. The service turns the
 *    index into the `correct` text the frontend expects.
 *  - Math uses \( ... \) with doubled backslashes in the JSON, exactly like the
 *    Important Questions feature.
 */

const buildMcqItemSchema = ({ language }) => {
  const properties = {
    question: {
      type: "string",
      description: language
        ? "One complete, self-contained MCQ stem written entirely in the requested language. Plain text, no LaTeX. Never refer to a figure or to option letters."
        : "One complete, self-contained MCQ stem. Wrap every formula, symbol and number-with-unit in \\( ... \\). Never refer to a figure or to option letters.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      description: language
        ? "Exactly 4 distinct options in the requested language. Plain text, no labels such as (A) (B) A. or 1."
        : "Exactly 4 distinct options. No labels such as (A) (B) A. or 1. Every symbol, number-with-unit or expression is wrapped in \\( ... \\) just like the question.",
    },
    correctIndex: {
      type: "integer",
      enum: [0, 1, 2, 3],
      description:
        "Zero-based position of the correct option inside 'options' (0 = first option, 3 = last). It must point at the option you consider correct.",
    },
    explanation: {
      type: "string",
      description:
        "One or two sentences on why the correct option is right. Never mention option letters, numbers or positions.",
    },
    formula: {
      type: "string",
      description:
        "One primary standard formula in raw LaTeX with NO delimiters (every backslash doubled in the JSON), or an empty string. Never invent one.",
    },
  };

  // Language subjects never have a formula, so the field does not exist.
  // The service adds "formula": "" afterwards.
  if (language) delete properties.formula;

  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
};

const buildResponseSchema = (itemSchema) => ({
  type: "object",
  properties: {
    mcqs: {
      type: "array",
      items: itemSchema,
    },
  },
  required: ["mcqs"],
  additionalProperties: false,
});

export const mcqsResponseSchema = buildResponseSchema(
  buildMcqItemSchema({ language: false })
);

export const languageMcqsResponseSchema = buildResponseSchema(
  buildMcqItemSchema({ language: true })
);

export const getMcqsSchema = (isLanguage) =>
  isLanguage ? languageMcqsResponseSchema : mcqsResponseSchema;