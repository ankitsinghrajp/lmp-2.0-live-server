export function validateInput({ className, subject, chapter }) {
  if (
    className == null ||
    !String(className).trim() ||
    subject == null ||
    !String(subject).trim() ||
    chapter == null ||
    !String(chapter).trim()
  ) {
    throw new Error("className, subject and chapter are required");
  }

  if (!normalizeClass(className)) {
    throw new Error(`Invalid className: ${className}`);
  }
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeClass(value) {
  const normalized = normalizeText(value);
  const match = normalized.match(
    /^(?:class\s+)?(\d{1,2})(?:st|nd|rd|th)?$/
  );

  return match ? String(Number(match[1])) : "";
}

export function isSameClass(recordClass, requestedClass) {
  const storedClass = normalizeClass(recordClass);
  const expectedClass = normalizeClass(requestedClass);

  return Boolean(
    storedClass &&
    expectedClass &&
    storedClass === expectedClass
  );
}

const QUESTION_ARRAY_FIELDS = [
  "options",
  "formulas",
  "tables",
  "diagrams",
  "graphs",
  "subQuestions",
];

const QUESTION_REQUIRED_FIELDS = [
  "questionText",
  ...QUESTION_ARRAY_FIELDS,
];

function validateQuestionShape(question) {
  if (!question || typeof question !== "object" || Array.isArray(question)) {
    throw new Error("Generated question must be a JSON object");
  }

  const actualFields = Object.keys(question);

  if (
    actualFields.length !== QUESTION_REQUIRED_FIELDS.length ||
    QUESTION_REQUIRED_FIELDS.some(
      (field) => !Object.prototype.hasOwnProperty.call(question, field)
    )
  ) {
    throw new Error("Generated question has an invalid structure");
  }

  if (
    typeof question.questionText !== "string" ||
    !question.questionText.trim()
  ) {
    throw new Error("Generated question has empty questionText");
  }

  for (const field of QUESTION_ARRAY_FIELDS) {
    if (
      !Array.isArray(question[field]) ||
      !question[field].every(
        (item) => typeof item === "string" && item.trim().length > 0
      )
    ) {
      throw new Error(
        `Generated question field "${field}" must be an array of non-empty strings`
      );
    }
  }
}

function validateMathString(value, fieldName) {
  const inlineOpen = (value.match(/\\\(/g) || []).length;
  const inlineClose = (value.match(/\\\)/g) || []).length;
  const displayOpen = (value.match(/\\\[/g) || []).length;
  const displayClose = (value.match(/\\\]/g) || []).length;

  if (
    inlineOpen !== inlineClose ||
    displayOpen !== displayClose ||
    /\$\$?/.test(value)
  ) {
    throw new Error(
      `Invalid LaTeX delimiters in generated question field "${fieldName}"`
    );
  }
}

function validateFormula(formula) {
  validateMathString(formula, "formulas");

  // A formula must not contain unescaped dollar-sign delimiters.
  if (formula.includes("$")) {
    throw new Error("Formulas must not use dollar-sign delimiters");
  }
}

function hasMarkdownTable(value) {
  return /\|[^\n]*\|\s*\n\s*\|?\s*:?-{3,}/.test(
    String(value ?? "")
  );
}

function validateTable(table) {
  if (!hasMarkdownTable(table)) {
    throw new Error(
      "Every table must be a Markdown table with a header and separator row"
    );
  }
}

/**
 * NON-THROWING cleanup that runs BEFORE any repair.
 * - Drops empty / non-string items from the array fields.
 * - Returns null if the question is not an object or has no questionText.
 * Fixable problems (math delimiters, tables) are NOT checked here, so they
 * can reach the repair step instead of killing the whole request.
 */
export function sanitizeGeneratedQuestion(question) {
  if (!question || typeof question !== "object" || Array.isArray(question)) {
    return null;
  }

  const questionText =
    typeof question.questionText === "string"
      ? question.questionText.trim()
      : "";

  if (!questionText) {
    return null;
  }

  const clean = { questionText };

  for (const field of QUESTION_ARRAY_FIELDS) {
    const value = question[field];

    clean[field] = Array.isArray(value)
      ? value.filter(
          (item) => typeof item === "string" && item.trim().length > 0
        )
      : [];
  }

  return clean;
}

/**
 * NON-THROWING check of everything validateGeneratedQuestion enforces for
 * content: balanced math delimiters, no "$", Markdown table shape.
 * Returns [{ path, text, error }] using the same path format the repair step
 * uses ("questionText", "options.2", "tables.0", ...).
 */
export function getQuestionContentIssues(question) {
  const issues = [];

  const check = (path, text, fn) => {
    try {
      fn(text);
    } catch (error) {
      issues.push({ path, text, error: error.message });
    }
  };

  check("questionText", question.questionText, (value) =>
    validateMathString(value, "questionText")
  );

  for (const field of QUESTION_ARRAY_FIELDS) {
    (question[field] ?? []).forEach((item, index) => {
      const path = `${field}.${index}`;

      check(path, item, (value) => validateMathString(value, field));

      if (field === "tables") {
        check(path, item, validateTable);
      }
    });
  }

  return issues;
}

/** Strict (throwing) validator. Use it as the FINAL gate after repair. */
export function validateGeneratedQuestion(question) {
  validateQuestionShape(question);

  // Validate math wherever it may appear.
  for (const field of QUESTION_REQUIRED_FIELDS) {
    const value = question[field];

    if (typeof value === "string") {
      validateMathString(value, field);
      continue;
    }

    for (const item of value) {
      validateMathString(item, field);
    }
  }

  for (const formula of question.formulas) {
    validateFormula(formula);
  }

  for (const table of question.tables) {
    validateTable(table);
  }

  return question;
}

/**
 * Strict validator for a whole response. Do NOT call this before the repair
 * step: it throws on the first bad question. Kept for other callers.
 */
export function validateGeneratedQuestions(result) {
  if (!result || !Array.isArray(result.questions)) {
    throw new Error(
      "Generated response must contain a questions array"
    );
  }

  if (result.questions.length === 0) {
    throw new Error("OpenAI returned no generated questions");
  }

  for (const question of result.questions) {
    validateGeneratedQuestion(question);
  }

  return result;
}