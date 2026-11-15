import katex from "katex";
import {
  QUESTION_TYPES,
  LANGUAGE_QUESTION_TYPES,
  OBJECTIVE_TYPES,
  IMPORTANCE_LEVELS,
} from "./schema.js";

/**
 * Predicted Questions validation.
 *
 * Same philosophy as Important Questions: nothing here throws for a "soft"
 * problem. Each question is
 *   sanitize -> deterministic fix -> KaTeX check -> (LLM repair -> fix -> check) x N
 * and a question that still fails is dropped on its own, so one bad question
 * can never fail the whole request.
 */

const LOG = "[Predicted Questions]";

const MIN_TEXT_LENGTH = 10;
const MAX_TEXT_LENGTH = 3000;
const SIMILARITY_LIMIT = 0.75;
const MAX_REPAIR_ATTEMPTS = 2;

const STRING_FIELDS = ["questionText"];
const ARRAY_FIELDS = [
  "options",
  "formulas",
  "tables",
  "diagrams",
  "graphs",
  "subQuestions",
];
const LANGUAGE_EMPTY_FIELDS = [
  "options",
  "formulas",
  "tables",
  "diagrams",
  "graphs",
];

// Matches \( ... \) (group 1) and \[ ... \] (group 2)
const MATH_RE = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;

// LaTeX-looking things that must never appear outside a math span.
const STRAY_LATEX_RE =
  /\\[a-zA-Z]+|\\[()[\]]|[A-Za-z0-9})]_[{A-Za-z0-9]|\^[{0-9A-Za-z-]|\$|[₀-₉⁰-⁹⁺⁻→⇌]/;

/**
 * Catches multiple-choice style stems that carry no options array, e.g.
 * "Choose the correct option: ..." / "सही विकल्प चुनें" (language subjects).
 */
const LANGUAGE_MCQ_STEM_RE =
  /multiple[- ]choice|which of the following|\b(?:choose|select|pick|tick)\b[^.?!]{0,40}\b(?:correct|right|appropriate|best)\b|\boptions?\b|\(\s*[A-D]\s*\)|विकल्प|सही उत्तर (?:चुन|का चयन)|निम्नलिखित में से (?:कौन|सही)|चिनुत|चयनं कुरुत/i;

const hasDevanagari = (text) => /[\u0900-\u097F]/.test(text);

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

/** A question is objective (MCQ / Assertion Reason) when it has options. */
export const isObjectiveQuestion = (question) =>
  Array.isArray(question?.options) && question.options.length > 0;

/** True when (A) (B) (C) (D) options are typed inside the question text. */
export function hasInlineOptions(question) {
  const text = [question?.questionText, ...(question?.subQuestions ?? [])]
    .filter((value) => typeof value === "string")
    .join("\n");

  return /\(A\)[\s\S]*\(B\)[\s\S]*\(C\)[\s\S]*\(D\)/.test(text);
}

export function looksLikeMcqStem(question) {
  const text = [question?.questionText, ...(question?.subQuestions ?? [])]
    .filter((value) => typeof value === "string")
    .join(" ");

  return LANGUAGE_MCQ_STEM_RE.test(text);
}

/* -------------------------------------------------------------------------- */
/*                              Duplicate tracking                            */
/* -------------------------------------------------------------------------- */

const normUnicodeText = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenSet = (s) =>
  new Set(
    normUnicodeText(s)
      .split(" ")
      .filter((word) => word.length > 1)
  );

const similarity = (a, b) => {
  if (!a.size || !b.size) return 0;

  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;

  return shared / (a.size + b.size - shared);
};

/**
 * register(text) returns true when the text is new, false when it is an exact
 * or near duplicate of an earlier one. Duplicates are dropped silently.
 */
export function createDuplicateTracker() {
  const keys = new Set();
  const tokenSets = [];

  return {
    register(text) {
      const key = normUnicodeText(text);
      if (!key || keys.has(key)) return false;

      const tokens = tokenSet(text);

      for (const other of tokenSets) {
        if (similarity(tokens, other) >= SIMILARITY_LIMIT) return false;
      }

      keys.add(key);
      tokenSets.push(tokens);
      return true;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Sanitizing                                */
/* -------------------------------------------------------------------------- */

const defaultMarks = (type) => {
  if (OBJECTIVE_TYPES.includes(type)) return 1;
  if (type === "Short Answer") return 2;
  if (type === "Long Answer") return 5;
  if (type === "Numerical") return 3;
  return 4; // Case Based / Source Based
};

const normalizeMarks = (type, marks) => {
  if (OBJECTIVE_TYPES.includes(type)) return 1;
  if (type === "Short Answer") return Math.min(Math.max(marks, 2), 3);
  if (type === "Long Answer") return Math.min(Math.max(marks, 4), 6);
  return marks;
};

const inferType = (question, marks, isLanguage) => {
  if (isLanguage) return marks >= 4 ? "Long Answer" : "Short Answer";
  if (question.options.length) return "MCQ";
  if (question.subQuestions.length) return "Case Based";
  return marks >= 4 ? "Long Answer" : "Short Answer";
};

/**
 * NON-THROWING cleanup that runs BEFORE any repair. Returns null when the
 * question cannot be used at all (not an object, no text, objective question
 * without options). Everything else (bad type, bad marks, bad importance) is
 * quietly corrected instead of failing the request.
 */
export function sanitizePredictedQuestion(raw, { isLanguage = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const questionText =
    typeof raw.questionText === "string" ? raw.questionText.trim() : "";

  if (
    questionText.length < MIN_TEXT_LENGTH ||
    questionText.length > MAX_TEXT_LENGTH
  ) {
    return null;
  }

  const clean = { questionText };

  for (const field of ARRAY_FIELDS) {
    if (isLanguage && LANGUAGE_EMPTY_FIELDS.includes(field)) {
      clean[field] = [];
      continue;
    }

    clean[field] = Array.isArray(raw[field])
      ? raw[field].filter(isNonEmptyString).map((item) => item.trim())
      : [];
  }

  const allowedTypes = isLanguage ? LANGUAGE_QUESTION_TYPES : QUESTION_TYPES;

  let marks = Number(raw.marks);
  let questionType =
    typeof raw.questionType === "string" ? raw.questionType.trim() : "";

  if (!allowedTypes.includes(questionType)) {
    questionType = inferType(
      clean,
      Number.isInteger(marks) ? marks : 0,
      isLanguage
    );
  }

  if (!isLanguage) {
    const objectiveType = OBJECTIVE_TYPES.includes(questionType);

    // A question with options is an MCQ even if the model labelled it otherwise.
    if (clean.options.length && !objectiveType) questionType = "MCQ";

    // An "MCQ" with no options has an incomplete stem. Drop it.
    if (objectiveType && !clean.options.length) return null;
  }

  if (!Number.isInteger(marks) || marks < 1 || marks > 6) {
    marks = defaultMarks(questionType);
  }

  clean.questionType = questionType;
  clean.marks = normalizeMarks(questionType, marks);
  clean.importance = IMPORTANCE_LEVELS.includes(raw.importance)
    ? raw.importance
    : "High";

  return clean;
}

/* -------------------------------------------------------------------------- */
/*                          Field helpers (core fields)                       */
/* -------------------------------------------------------------------------- */

/** Returns [{ path, value }] for every string field of a question. */
function getQuestionFields(question) {
  const fields = [];

  for (const key of STRING_FIELDS) {
    if (typeof question[key] === "string") {
      fields.push({ path: key, value: question[key] });
    }
  }

  for (const key of ARRAY_FIELDS) {
    (question[key] ?? []).forEach((value, index) => {
      if (typeof value === "string") {
        fields.push({ path: `${key}.${index}`, value });
      }
    });
  }

  return fields;
}

function setQuestionField(question, path, value) {
  const [key, index] = path.split(".");

  if (index === undefined) {
    question[key] = value;
  } else if (Array.isArray(question[key])) {
    question[key][Number(index)] = value;
  }
}

function mapQuestionStrings(question, fn) {
  const next = structuredClone(question);

  for (const { path, value } of getQuestionFields(next)) {
    setQuestionField(next, path, fn(value));
  }

  return next;
}

/* -------------------------------------------------------------------------- */
/*                         Deterministic text fixing                          */
/* -------------------------------------------------------------------------- */

/**
 * Cheap, deterministic fixes. They cost nothing and clear most of the
 * "model wrote bad LaTeX" cases before KaTeX or the repair LLM is involved.
 */
function fixString(text) {
  let s = text;

  // JSON escape corruption: \frac -> <FF>rac, \times -> <TAB>imes,
  // \beta -> <BS>eta, \rho -> <CR>ho, \vec -> <VT>ec, \neq -> <LF>eq
  s = s
    .replace(/\f(?=[a-zA-Z])/g, "\\f")
    .replace(/\t(?=[a-zA-Z])/g, "\\t")
    .replace(/\x08(?=[a-zA-Z])/g, "\\b")
    .replace(/\r(?=[a-zA-Z])/g, "\\r")
    .replace(/\v(?=[a-zA-Z])/g, "\\v")
    .replace(
      /\n(?=(?:eq|abla|ot|ewline|leq|geq|mid|ightarrow|u)\b)/g,
      "\\n"
    );

  // Double-escaped commands: \\mathrm -> \mathrm, \\( -> \(
  s = s.replace(/\\\\(?=[a-zA-Z]{2,}|[()[\]])/g, "\\");

  // Unicode symbols that are safe to convert inside math spans
  s = s.replace(MATH_RE, (full, inline, display) => {
    const clean = (tex) =>
      tex
        .replace(/(\d)\s*°/g, "$1^\\circ")
        .replace(/°/g, "^\\circ")
        .replace(/×/g, "\\times ")
        .replace(/÷/g, "\\div ")
        .replace(/²/g, "^2")
        .replace(/³/g, "^3")
        .replace(/→/g, "\\rightarrow ")
        .replace(/⇌/g, "\\rightleftharpoons ")
        .replace(/[μµ]/g, "\\mu ")
        // unit products: \mathrm{C \times m} -> \mathrm{C\,m}
        .replace(
          /\\mathrm\{([^{}]*?)\s*\\times\s*([^{}]*?)\}/g,
          "\\mathrm{$1\\,$2}"
        );

    return inline !== undefined
      ? `\\(${clean(inline)}\\)`
      : `\\[${clean(display)}\\]`;
  });

  return s;
}

/** Language subjects: no math at all. Strip any math delimiters the model adds. */
const fixLanguageText = (text) =>
  String(text ?? "")
    .replace(/\\[()[\]]/g, "")
    .replace(/\$/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/* -------------------------------------------------------------------------- */
/*                              LaTeX / content checks                        */
/* -------------------------------------------------------------------------- */

function validateMathString(value) {
  const inlineOpen = (value.match(/\\\(/g) || []).length;
  const inlineClose = (value.match(/\\\)/g) || []).length;
  const displayOpen = (value.match(/\\\[/g) || []).length;
  const displayClose = (value.match(/\\\]/g) || []).length;

  if (
    inlineOpen !== inlineClose ||
    displayOpen !== displayClose ||
    /\$\$?/.test(value)
  ) {
    throw new Error("Invalid or unbalanced LaTeX delimiters");
  }
}

function hasMarkdownTable(value) {
  return /\|[^\n]*\|\s*\n\s*\|?\s*:?-{3,}/.test(String(value ?? ""));
}

function validateTable(table) {
  if (!hasMarkdownTable(table)) {
    throw new Error(
      "Every table must be a Markdown table with a header and separator row"
    );
  }
}

/** Returns a list of human-readable problems for one string. */
function findLatexProblems(text) {
  const problems = [];

  for (const match of text.matchAll(MATH_RE)) {
    const isDisplay = match[2] !== undefined;
    const tex = (match[1] ?? match[2]).trim();

    try {
      katex.renderToString(tex, {
        throwOnError: true,
        displayMode: isDisplay,
        strict: "ignore",
        trust: false,
      });
    } catch (error) {
      problems.push(`KaTeX failed on "${tex}": ${error.message}`);
    }
  }

  const outsideMath = text.replace(MATH_RE, " ");

  if (STRAY_LATEX_RE.test(outsideMath)) {
    problems.push(
      "Formula notation (LaTeX command, _ or ^, $, or a Unicode subscript/arrow) appears outside a \\( ... \\) or \\[ ... \\] span."
    );
  }

  return problems;
}

/** Delimiter balance, "$" usage and Markdown table shape. */
function getContentIssues(question) {
  const issues = [];

  const check = (path, text, fn) => {
    try {
      fn(text);
    } catch (error) {
      issues.push({ path, text, error: error.message });
    }
  };

  check("questionText", question.questionText, validateMathString);

  for (const field of ARRAY_FIELDS) {
    (question[field] ?? []).forEach((item, index) => {
      const path = `${field}.${index}`;

      check(path, item, validateMathString);
      if (field === "tables") check(path, item, validateTable);
    });
  }

  return issues;
}

/** Returns [{ path, text, error }] for every failing field of a question. */
function collectLatexIssues(question) {
  const byPath = new Map();

  const add = (path, text, error) => {
    const existing = byPath.get(path);

    if (existing) {
      existing.error += ` | ${error}`;
    } else {
      byPath.set(path, { path, text, error });
    }
  };

  for (const { path, value } of getQuestionFields(question)) {
    for (const problem of findLatexProblems(value)) {
      add(path, value, problem);
    }
  }

  for (const { path, text, error } of getContentIssues(question)) {
    add(path, text, error);
  }

  return [...byPath.values()];
}

/** Final strict gate. Should always pass once collectLatexIssues is empty. */
function assertFinalQuestion(question) {
  if (!isNonEmptyString(question.questionText)) {
    throw new Error("Empty questionText");
  }

  for (const field of ARRAY_FIELDS) {
    if (
      !Array.isArray(question[field]) ||
      !question[field].every(isNonEmptyString)
    ) {
      throw new Error(`Field "${field}" must be an array of non-empty strings`);
    }
  }

  if (
    OBJECTIVE_TYPES.includes(question.questionType) &&
    question.options.length < 2
  ) {
    throw new Error("Objective question needs at least two options");
  }

  for (const issue of getContentIssues(question)) {
    throw new Error(`${issue.path}: ${issue.error}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                                  LLM repair                                */
/* -------------------------------------------------------------------------- */

const latexFixResponseSchema = {
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

const repairSystemPrompt = String.raw`You fix broken LaTeX in CBSE practice questions. You receive failing text fields together with the KaTeX error for each.

1. Fix syntax only. Do not change the wording, numbers, units or meaning. Do not solve, balance, complete or add anything.
2. Every formula, equation, reaction, chemical formula, symbol and number-with-unit must be inside \( ... \) (inline) or \[ ... \] (display). Never use $.
3. Chemistry: one math span per reaction, e.g. \(\mathrm{2H_2 + O_2 \rightarrow 2H_2O}\). Use \mathrm, \rightarrow, \rightleftharpoons, \mathrm{(aq)}. Never \ce, never Unicode subscripts or arrows.
4. Never use \text. Fix unbalanced braces, unknown commands, and unbalanced or missing delimiters.
4a. A table must be a Markdown table with a header row and a separator row (| --- | --- |). Keep all cell data exactly as given; never invent data.
4b. Every number with a unit, Greek letter and degree sign must be inside math, e.g. \(5\,\mu\mathrm{C}\), \(E = 300\,\mathrm{N/C}\), \(30^\circ\). Join units with \, never \times.
5. In your JSON output every LaTeX backslash is doubled: \\( \\mathrm \\frac \\rightarrow.
6. Return every field you were given, using exactly the same "path" values.`;

const digitsOf = (s) => s.replace(/\D/g, "");

/**
 * Asks the model to repair only the failing fields. Returns a NEW question.
 * A fix is rejected if it changes any digit (guards against changed values).
 */
async function repairQuestionWithLlm(question, issues, { client, model }) {
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: repairSystemPrompt },
      { role: "user", content: JSON.stringify({ fields: issues }) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "latex_fixes",
        strict: true,
        schema: latexFixResponseSchema,
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LaTeX repair returned an empty response");
  }

  const { fixes } = JSON.parse(content);
  const original = new Map(issues.map((issue) => [issue.path, issue.text]));
  const repaired = structuredClone(question);

  for (const { path, fixed } of fixes) {
    const before = original.get(path);

    if (before === undefined) continue; // model invented a path

    if (digitsOf(fixed) !== digitsOf(before)) {
      console.warn(`${LOG} Repair rejected for "${path}": numbers changed`);
      continue;
    }

    setQuestionField(repaired, path, fixed);
  }

  return repaired;
}

/* -------------------------------------------------------------------------- */
/*                               Public validator                             */
/* -------------------------------------------------------------------------- */

/**
 * Returns the valid question (metadata untouched), or null if it must be dropped.
 *
 * options: { client, model, isLanguage, languageKey }
 *  - client / model: OpenAI client and model used for LaTeX repair
 *  - isLanguage: Hindi / Sanskrit / English (no math, no repair, no LLM call)
 */
export async function validateAndRepairQuestion(question, index, options) {
  const { client, model, isLanguage = false, languageKey = null } = options;

  // Language subjects: plain text only. Clean it and make sure it is in the
  // right script. No KaTeX, no repair call.
  if (isLanguage) {
    const cleaned = mapQuestionStrings(question, fixLanguageText);

    if (!cleaned.questionText) return null;

    if (
      (languageKey === "hindi" || languageKey === "sanskrit") &&
      !hasDevanagari(cleaned.questionText)
    ) {
      console.error(
        `${LOG} Question ${index + 1} dropped: no Devanagari text in a ${languageKey} question`
      );
      return null;
    }

    return cleaned;
  }

  let current = mapQuestionStrings(question, fixString);

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const issues = collectLatexIssues(current);

    if (!issues.length) {
      try {
        assertFinalQuestion(current);
      } catch (error) {
        console.error(
          `${LOG} Question ${index + 1} failed final validation:`,
          error.message
        );
        return null;
      }

      if (attempt > 0) {
        console.log(
          `${LOG} Question ${index + 1} repaired after ${attempt} LLM attempt(s)`
        );
      }

      return current;
    }

    if (attempt === MAX_REPAIR_ATTEMPTS) {
      console.error(
        `${LOG} Question ${index + 1} still invalid after repairs:`,
        issues.map((i) => ({ path: i.path, error: i.error }))
      );
      return null;
    }

    try {
      const repaired = await repairQuestionWithLlm(current, issues, {
        client,
        model,
      });
      current = mapQuestionStrings(repaired, fixString);
    } catch (error) {
      console.error(
        `${LOG} Repair call failed for question ${index + 1}:`,
        error.message
      );
      return null;
    }
  }

  return null;
}