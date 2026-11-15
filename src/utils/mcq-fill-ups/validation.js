import {
  getLanguage,
  getTrueFalseAnswers,
  isLanguageSubject,
} from "./language.js";

/**
 * Per-question validation.
 *
 * - There are NO required counts: any number of MCQs, fill-ups and
 *   True/False questions is accepted.
 * - Each question is checked on its own, so one bad question never forces the
 *   whole quiz to be regenerated.
 * - LaTeX rules stay strict.
 * - Cheap, deterministic fixes (broken JSON escapes, answer written as "B",
 *   "true." instead of "True", ...) are applied first and cost nothing.
 */

// A quiz with fewer valid questions than this is treated as a failure.
export const MIN_QUESTIONS = 5;

const QUESTION_TYPES = ["mcq", "fillup", "true_false"];

/* -------------------------------------------------------------------------- */
/*                          Free, deterministic repairs                       */
/* -------------------------------------------------------------------------- */

/**
 * The model writes JSON, so a LaTeX backslash must arrive doubled. When it
 * arrives single, JSON turns "\frac" into <FF>rac, "\times" into <TAB>imes,
 * "\beta" into <BS>eta, and so on. This puts the backslash back.
 */
export function fixLatexEscapes(text) {
  if (typeof text !== "string") return text;

  return text
    .replace(/\f(?=[a-zA-Z])/g, "\\f")
    .replace(/\t(?=[a-zA-Z])/g, "\\t")
    .replace(/\x08(?=[a-zA-Z])/g, "\\b")
    .replace(/\r(?=[a-zA-Z])/g, "\\r")
    .replace(/\v(?=[a-zA-Z])/g, "\\v")
    // \neq, \neg, \nabla, \not, \newline, \nu
    .replace(/\n(?=(?:eq|eg|abla|ot|ewline|u)\b)/g, "\\n")
    // Over-escaped commands: \\frac -> \frac
    .replace(/\\\\(?=[a-zA-Z]{2,})/g, "\\");
}

const clean = (value) =>
  typeof value === "string" ? fixLatexEscapes(value).trim() : value;

function canonicalTrueFalse(answer, language) {
  const [trueWord, falseWord] = getTrueFalseAnswers(language);

  const stripped = answer.trim().replace(/[\s.।!"'“”]+$/u, "");

  if (stripped === trueWord || stripped === falseWord) return stripped;

  // Accept English / yes-no answers and map them to the subject's words.
  const lower = stripped.toLowerCase();
  if (lower === "true" || lower === "yes") return trueWord;
  if (lower === "false" || lower === "no") return falseWord;

  return answer.trim();
}

function canonicalMcqAnswer(answer, options) {
  if (!Array.isArray(options)) return answer;

  const exact = options.find((option) => option === answer);
  if (exact !== undefined) return exact;

  const trimmed = options.find((option) => option.trim() === answer.trim());
  if (trimmed !== undefined) return trimmed;

  // Answer written as a letter: "B", "(b)", "b)"
  const letter = answer.trim().match(/^\(?([A-Da-d])\)?[.):]?$/);
  if (letter) {
    const position = "abcd".indexOf(letter[1].toLowerCase());
    if (options[position] !== undefined) return options[position];
  }

  const loose = options.find(
    (option) => option.trim().toLowerCase() === answer.trim().toLowerCase()
  );
  return loose !== undefined ? loose : answer;
}

/** Returns a cleaned copy of a raw model question. Never throws. */
function sanitizeQuestion(raw, language) {
  const question = {
    type: raw.type,
    question: clean(raw.question),
    answer: clean(raw.answer),
  };

  if (raw.type === "mcq") {
    question.options = Array.isArray(raw.options)
      ? raw.options.map(clean)
      : raw.options;

    if (typeof question.answer === "string") {
      question.answer = canonicalMcqAnswer(question.answer, question.options);
    }
  }

  if (raw.type === "true_false" && typeof question.answer === "string") {
    question.answer = canonicalTrueFalse(question.answer, language);
  }

  return question;
}

/* -------------------------------------------------------------------------- */
/*                              LaTeX rules (strict)                          */
/* -------------------------------------------------------------------------- */

function findLatexIssues(label, value) {
  const issues = [];

  if (typeof value !== "string") return issues;

  if (/\\\(|\\\)|\\\[|\\\]/.test(value)) {
    issues.push(`${label}: Use only $...$ and $$...$$ delimiters.`);
  }

  const withoutDisplay = value.replace(/\$\$[\s\S]*?\$\$/g, "");

  if (withoutDisplay.includes("$$")) {
    issues.push(`${label}: Unclosed display math delimiter.`);
  }

  const withoutInline = withoutDisplay.replace(
    /\$(?!\$)[^\n$]*?\$(?!\$)/g,
    ""
  );

  if (withoutInline.includes("$")) {
    issues.push(`${label}: Unclosed inline math delimiter.`);
  }

  if (/\\[a-zA-Z]+/.test(withoutInline)) {
    issues.push(`${label}: LaTeX command found outside math delimiters.`);
  }

  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    issues.push(`${label}: Unexpected control character detected.`);
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*                               Question validation                          */
/* -------------------------------------------------------------------------- */

const isFilledString = (value) =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Validates ONE question.
 *
 * @returns {{ valid: boolean, issues: string[], question: object | null }}
 *   `question` is the cleaned version (also returned when invalid, so a
 *   repair request can show the model a tidy copy). null if it was not an
 *   object at all.
 */
export function validateQuestion(raw, { subject } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, issues: ["Question must be an object."], question: null };
  }

  const language = getLanguage(subject);
  const question = sanitizeQuestion(raw, language);
  const issues = [];

  if (!QUESTION_TYPES.includes(question.type)) {
    issues.push(`Invalid question type: ${question.type}.`);
    return { valid: false, issues, question };
  }

  if (!isFilledString(question.question)) {
    issues.push("Question text is empty.");
  }

  if (!isFilledString(question.answer)) {
    issues.push("Answer is empty.");
  }

  if (question.type === "mcq") {
    const { options } = question;

    if (!Array.isArray(options) || options.length !== 4) {
      issues.push("An MCQ must have exactly 4 options.");
    } else if (!options.every(isFilledString)) {
      issues.push("An MCQ option is empty or invalid.");
    } else {
      const unique = new Set(options.map((o) => o.trim().toLowerCase()));

      if (unique.size !== 4) {
        issues.push("An MCQ has duplicate options.");
      }

      if (isFilledString(question.answer) && !options.includes(question.answer)) {
        issues.push("The MCQ answer must exactly match one of its options.");
      }
    }
  }

  if (
    question.type === "true_false" &&
    isFilledString(question.answer) &&
    !getTrueFalseAnswers(language).includes(question.answer)
  ) {
    issues.push(
      `The True/False answer must be one of: ${getTrueFalseAnswers(language).join(", ")}.`
    );
  }

  // LaTeX is checked for every subject except Hindi / Sanskrit / English.
  if (!isLanguageSubject(subject)) {
    issues.push(...findLatexIssues("Question", question.question));
    issues.push(...findLatexIssues("Answer", question.answer));

    if (Array.isArray(question.options)) {
      question.options.forEach((option, index) => {
        issues.push(...findLatexIssues(`Option ${index + 1}`, option));
      });
    }
  }

  return { valid: issues.length === 0, issues, question };
}