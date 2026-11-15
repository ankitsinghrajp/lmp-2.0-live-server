/**
 * Response schema for quiz generation.
 *
 * Kept deliberately small:
 *  - No "id": the server numbers questions itself, so the model cannot get
 *    the numbering wrong and no tokens are spent on it.
 *  - No "chapter" / "class" / "subject": the server already knows them and
 *    adds them to the final quiz.
 *  - No fixed number of questions or per-type counts: the prompt asks for
 *    about 15, and the validator accepts any mix.
 */

const mcqSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: ["mcq"],
    },
    question: {
      type: "string",
      description:
        "The question text only. Do not include the options here.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      minItems: 4,
      maxItems: 4,
      description:
        "Exactly four different options, written without (A)/(B)/1./a) labels.",
    },
    answer: {
      type: "string",
      description:
        "The correct option, copied character for character from options.",
    },
  },
  required: ["type", "question", "options", "answer"],
};

const fillupSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: ["fillup"],
    },
    question: {
      type: "string",
      description: "A statement with one blank (______) to fill in.",
    },
    answer: {
      type: "string",
      description: "The single word or short phrase that fills the blank.",
    },
  },
  required: ["type", "question", "answer"],
};

const trueFalseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: ["true_false"],
    },
    question: {
      type: "string",
      description: "A factual statement that is clearly true or clearly false.",
    },
    answer: {
      type: "string",
      description:
        "True or False in the subject's language (English: True/False, Hindi: सत्य/असत्य, Sanskrit: आम्/न).",
    },
  },
  required: ["type", "question", "answer"],
};

export const quizResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      items: {
        anyOf: [mcqSchema, fillupSchema, trueFalseSchema],
      },
    },
  },
  required: ["questions"],
};