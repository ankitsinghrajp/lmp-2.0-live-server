import katex from "katex";

import { importantQuestionsOpenAI } from "../config/importantQuestionsOpenAI.js";

import {
  deduplicateRankedPyqs,
  selectYearDiverseEvidence,
} from "../utils/important_questions/duplicateDetection.util.js";

import {
  getCompleteQuestionText,
  rankPyqs,
} from "../utils/important_questions/questionContent.util.js";

import {
  generatedQuestionSchema,
} from "../utils/important_questions/schema.utils.js";

import {
  isSameClass,
  normalizeClass,
  validateInput,
  sanitizeGeneratedQuestion,
  getQuestionContentIssues,
  validateGeneratedQuestion,
} from "../utils/important_questions/validation.utils.js";

import {
  normalizeQuestionForDeduplication,
} from "../utils/important_questions/duplicateDetection.util.js";

// NOTE: Hindi and Sanskrit no longer use retrieval (no RAG), so the
// multilingual retrieval service is not imported any more.
import { retrievePyqs } from "./pyqRetrieval.service.js";

const MODEL = "gpt-4o-mini";
const DEFAULT_TOP_K = 50;
const MAX_CONTEXT_QUESTIONS = 15;
const MAX_GENERATED_QUESTIONS = 15;
const GENERATION_TEMPERATURE = 0.4;

// Question-type mix. MCQs are capped both in the prompt and in code.
const MAX_MCQ_QUESTIONS = 4;
const TARGET_SHORT_ANSWER = 5;
const TARGET_LONG_ANSWER = 5;
const TARGET_CASE_BASED = 3;

// Hindi / Sanskrit / English (no RAG): small, book + chapter based set.
// These subjects never get MCQs: any question with options is dropped.
const MAX_LANGUAGE_QUESTIONS = 6;
const LANGUAGE_GENERATION_TEMPERATURE = 0.3;

// LaTeX repair settings
const MAX_REPAIR_ATTEMPTS = 2;
// true  -> questions that still fail KaTeX after all repairs are NOT sent to the frontend
// false -> they are sent anyway (frontend fallback must handle them)
const DROP_UNFIXABLE_QUESTIONS = true;

// Optional safety net: convert inline "Label: a, b; Label: x, y." data into a
// Markdown table without an LLM call. OFF: the prompt/schema must do this job.
const ENABLE_INLINE_TABLE_FALLBACK = false;

const generatedQuestionsResponseSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: generatedQuestionSchema,
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

/**
 * Dedicated schema for Hindi / Sanskrit / English (no MCQs).
 * Built from the shared schema WITHOUT touching it, so other subjects are
 * unaffected. The "options" field does not exist here, so the model cannot
 * produce answer choices at all. The service adds "options": [] afterwards so
 * the frontend and validators still receive the shape they expect.
 */
const languageQuestionSchema = (() => {
  const schema = structuredClone(generatedQuestionSchema);

  delete schema.properties.options;
  schema.required = schema.required.filter((key) => key !== "options");

  schema.properties.questionText.description =
    "Main question statement only, written entirely in the requested language. Plain text, no LaTeX. It must be a descriptive question that is answered in sentences, never a multiple-choice question and never refer to options or choices.";
  schema.properties.formulas.description = "Always [] for language subjects.";
  schema.properties.tables.description = "Always [] for language subjects.";
  schema.properties.diagrams.description = "Always [] for language subjects.";
  schema.properties.graphs.description = "Always [] for language subjects.";
  schema.properties.subQuestions.description =
    "Optional descriptive sub-questions in the requested language, WITHOUT labels such as (a) or (i). Usually []. Never options or choices.";

  return schema;
})();

const languageQuestionsResponseSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: languageQuestionSchema,
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

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

/* -------------------------------------------------------------------------- */
/*                         LaTeX validation + repair                          */
/* -------------------------------------------------------------------------- */

const STRING_FIELDS = ["questionText"];
const ARRAY_FIELDS = [
  "options",
  "formulas",
  "tables",
  "diagrams",
  "graphs",
  "subQuestions",
];

// Matches \( ... \) (group 1) and \[ ... \] (group 2)
const MATH_RE = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;

// LaTeX-looking things that must never appear outside a math span.
const STRAY_LATEX_RE =
  /\\[a-zA-Z]+|\\[()[\]]|[A-Za-z0-9})]_[{A-Za-z0-9]|\^[{0-9A-Za-z-]|\$|[₀-₉⁰-⁹⁺⁻→⇌]/;

/** A question is an MCQ when it has a non-empty options array. */
const isMcq = (question) =>
  Array.isArray(question?.options) && question.options.length > 0;

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

/**
 * Cheap, deterministic fixes. These cost nothing and clear most of the
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
    .replace(/\n(?=(?:eq|abla|ot|ewline|leq|geq|mid|ightarrow|u)\b)/g, "\\n");

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

  // KaTeX + stray-LaTeX problems
  for (const { path, value } of getQuestionFields(question)) {
    for (const problem of findLatexProblems(value)) {
      add(path, value, problem);
    }
  }

  // Delimiter balance, "$" usage and Markdown table shape (validation.utils)
  for (const { path, text, error } of getQuestionContentIssues(question)) {
    add(path, text, error);
  }

  return [...byPath.values()];
}

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
 * Asks gpt-4o-mini to repair only the failing fields. Returns a NEW question.
 * A fix is rejected if it changes any digit (guards against changed values).
 */
async function repairQuestionWithLlm(question, issues) {
  const response = await importantQuestionsOpenAI.chat.completions.create({
    model: MODEL,
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
      console.warn(
        `[Important Questions RAG] Repair rejected for "${path}": numbers changed`
      );
      continue;
    }

    setQuestionField(repaired, path, fixed);
  }

  return repaired;
}

/**
 * deterministic fix -> KaTeX check -> (LLM repair -> deterministic fix -> check) x N
 * Returns the valid question, or null if it could not be fixed.
 */
async function validateAndRepairQuestion(question, index) {
  let current = mapQuestionStrings(question, fixString);

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const issues = collectLatexIssues(current);

    if (!issues.length) {
      // Final strict gate (shape + delimiters + tables). Should always pass here.
      try {
        validateGeneratedQuestion(current);
      } catch (error) {
        console.error(
          `[Important Questions RAG] Question ${index + 1} failed final validation:`,
          error.message
        );
        return null;
      }

      if (attempt > 0) {
        console.log(
          `[Important Questions RAG] Question ${index + 1} repaired after ${attempt} LLM attempt(s)`
        );
      }
      return current;
    }

    if (attempt === MAX_REPAIR_ATTEMPTS) {
      console.error(
        `[Important Questions RAG] Question ${index + 1} still invalid after repairs:`,
        issues.map((i) => ({ path: i.path, error: i.error }))
      );
      return null;
    }

    try {
      const repaired = await repairQuestionWithLlm(current, issues);
      current = mapQuestionStrings(repaired, fixString);
    } catch (error) {
      console.error(
        `[Important Questions RAG] Repair call failed for question ${index + 1}:`,
        error.message
      );
      return null;
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*                                  Prompts                                   */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt({ requestedClass, subject, chapter }) {
  const mcqTarget = Math.max(
    0,
    MAX_GENERATED_QUESTIONS -
      TARGET_SHORT_ANSWER -
      TARGET_LONG_ANSWER -
      TARGET_CASE_BASED
  );

  return String.raw`You are a CBSE exam expert. Generate NEW practice questions for exactly this syllabus unit:

CLASS: ${requestedClass}
SUBJECT: ${subject}
CHAPTER: ${chapter}

SCOPE (most important, overrides everything else)
1. Every question must test a concept from the chapter "${chapter}" of Class ${requestedClass} ${subject}, at the level of that class.
2. The PYQ evidence is only a hint about concepts and question styles. Ignore any evidence item that does not belong to this class, subject and chapter.
3. Use only the vocabulary, data and question styles that are normal for ${subject}. Do not borrow topics or data formats from any other subject or chapter.
3b. Use only topics that are part of the current NCERT/CBSE syllabus for this chapter. Do not ask about topics that are outside the Class ${requestedClass} ${subject} syllabus.
4. If fewer than ${MAX_GENERATED_QUESTIONS} good questions exist, return fewer. Never pad.

CONTENT
5. Write at most ${MAX_GENERATED_QUESTIONS} distinct, complete questions. Never copy evidence verbatim, never use incomplete evidence, never invent missing data.
6. Questions only: no answers, solutions, hints, probabilities or exam-appearance claims. If a question asks students to balance, derive, prove or complete something, leave it unsolved. Any equation you state in full must be correct.
7. The evidence is raw, unformatted text. Rewrite its notation in LaTeX; never copy its formatting.

FORMAT
8. Wrap every formula, equation, symbol, chemical formula and number-with-unit (including Greek letters and degrees) as \( ... \) inline or \[ ... \] display. Never use $, \text or \ce. Never leave notation such as \mathrm, \rightarrow, _ or ^ outside \( \).
9. Write units with \mathrm and a thin space \, between value and unit, and between units. Never use \times between units.
10. In the JSON output every LaTeX backslash is doubled: \\( \\mathrm \\theta \\frac \\rightarrow.
11. "formulas" is almost always []. Fill it ONLY when the question itself gives an equation to work on. Never put an answer, result, solution step, or the formula the student should use. If the question asks students to write, balance or derive an equation, "formulas" must be [] and the equation must not appear anywhere.
12. "tables" is almost always []. Use it only when the question genuinely needs tabulated data that fits ${subject} and "${chapter}". Format: one Markdown table per item, with a header row, a separator row, and data rows joined by \n. questionText must only refer to the table and never repeat its values.
13. subQuestions have no (a)/(b) or (i)/(ii) labels.

QUESTION TYPES (very important)
14. Default to descriptive questions with "options": []. Use CBSE-style short-answer (2-3 marks), long-answer (4-6 marks), "find / prove / show that / evaluate / solve / derive / explain" questions, and case-based or application questions with subQuestions.
15. At most ${MAX_MCQ_QUESTIONS} of the questions may be multiple-choice (non-empty "options"). Every other question MUST have "options": []. Never turn a question that can be asked descriptively into an MCQ.
16. Aim for roughly: ${TARGET_SHORT_ANSWER} short-answer, ${TARGET_LONG_ANSWER} long-answer, ${TARGET_CASE_BASED} case-based/application questions with subQuestions, and at most ${mcqTarget} MCQs. Where possible, match the mix of "questionType" and "marks" seen in the PYQ evidence.
17. Do not write trivial one-step questions (for example "find AB" for two given 2x2 matrices) unless that is the normal 2-mark style of this chapter. Prefer multi-step, exam-level questions.
18. In an MCQ, every option that contains a symbol, number-with-unit, matrix or expression must be wrapped in \( ... \) just like the question text. Keep all options of one MCQ in the same style. Options keep their (A) (B) (C) (D) labels.`;
}

function buildUserPrompt({ requestedClass, subject, chapter, pyqEvidence }) {
  return `CLASS: ${requestedClass}
SUBJECT: ${subject}
CHAPTER: ${chapter}

RAW PYQ EVIDENCE (unformatted; may include off-topic items, ignore those; rewrite notation in LaTeX):
${JSON.stringify(pyqEvidence)}

Generate up to ${MAX_GENERATED_QUESTIONS} new questions that belong strictly to Class ${requestedClass} ${subject}, chapter "${chapter}". Wrap every number with a unit and every symbol in \\( ... \\). Keep "formulas" and "tables" as [] unless the question itself needs them.

Make at most ${MAX_MCQ_QUESTIONS} of them MCQs. All the other questions must be descriptive (short-answer, long-answer or case-based) with "options": [].`;
}

/* -------------------------------------------------------------------------- */
/*              Class 9 / 11 prompts (no RAG, same output format)             */
/* -------------------------------------------------------------------------- */

function buildNoRagSystemPrompt({ requestedClass, subject, chapter }) {
  const mcqTarget = Math.max(
    0,
    MAX_GENERATED_QUESTIONS -
      TARGET_SHORT_ANSWER -
      TARGET_LONG_ANSWER -
      TARGET_CASE_BASED
  );

  return String.raw`You are a CBSE exam expert. Generate NEW practice questions for exactly this syllabus unit:

CLASS: ${requestedClass}
SUBJECT: ${subject}
CHAPTER: ${chapter}

SCOPE (most important, overrides everything else)
1. Every question must test a concept from the chapter "${chapter}" of Class ${requestedClass} ${subject}, at the level of that class.
2. No previous-year question evidence is provided. Use your own knowledge of the current NCERT/CBSE syllabus for this chapter to decide which concepts and question styles are important.
3. Use only the vocabulary, data and question styles that are normal for ${subject}. Do not borrow topics or data formats from any other subject or chapter.
3b. Use only topics that are part of the current NCERT/CBSE syllabus for this chapter. Do not ask about topics that are outside the Class ${requestedClass} ${subject} syllabus.
4. If fewer than ${MAX_GENERATED_QUESTIONS} good questions exist, return fewer. Never pad.

CONTENT
5. Write at most ${MAX_GENERATED_QUESTIONS} distinct, complete questions. Never invent missing data.
6. Questions only: no answers, solutions, hints, probabilities or exam-appearance claims. If a question asks students to balance, derive, prove or complete something, leave it unsolved. Any equation you state in full must be correct.
7. Write all notation in LaTeX.

FORMAT
8. Wrap every formula, equation, symbol, chemical formula and number-with-unit (including Greek letters and degrees) as \( ... \) inline or \[ ... \] display. Never use $, \text or \ce. Never leave notation such as \mathrm, \rightarrow, _ or ^ outside \( \).
9. Write units with \mathrm and a thin space \, between value and unit, and between units. Never use \times between units.
10. In the JSON output every LaTeX backslash is doubled: \\( \\mathrm \\theta \\frac \\rightarrow.
11. "formulas" is almost always []. Fill it ONLY when the question itself gives an equation to work on. Never put an answer, result, solution step, or the formula the student should use. If the question asks students to write, balance or derive an equation, "formulas" must be [] and the equation must not appear anywhere.
12. "tables" is almost always []. Use it only when the question genuinely needs tabulated data that fits ${subject} and "${chapter}". Format: one Markdown table per item, with a header row, a separator row, and data rows joined by \n. questionText must only refer to the table and never repeat its values.
13. subQuestions have no (a)/(b) or (i)/(ii) labels.

QUESTION TYPES (very important)
14. Default to descriptive questions with "options": []. Use CBSE-style short-answer (2-3 marks), long-answer (4-6 marks), "find / prove / show that / evaluate / solve / derive / explain" questions, and case-based or application questions with subQuestions.
15. At most ${MAX_MCQ_QUESTIONS} of the questions may be multiple-choice (non-empty "options"). Every other question MUST have "options": []. Never turn a question that can be asked descriptively into an MCQ.
16. Aim for roughly: ${TARGET_SHORT_ANSWER} short-answer, ${TARGET_LONG_ANSWER} long-answer, ${TARGET_CASE_BASED} case-based/application questions with subQuestions, and at most ${mcqTarget} MCQs. Where possible, follow the usual CBSE mix of question types and marks for this chapter.
17. Do not write trivial one-step questions (for example "find AB" for two given 2x2 matrices) unless that is the normal 2-mark style of this chapter. Prefer multi-step, exam-level questions.
18. In an MCQ, every option that contains a symbol, number-with-unit, matrix or expression must be wrapped in \( ... \) just like the question text. Keep all options of one MCQ in the same style. Options keep their (A) (B) (C) (D) labels.`;
}

function buildNoRagUserPrompt({ requestedClass, subject, chapter }) {
  return `CLASS: ${requestedClass}
SUBJECT: ${subject}
CHAPTER: ${chapter}

Generate up to ${MAX_GENERATED_QUESTIONS} new questions that belong strictly to Class ${requestedClass} ${subject}, chapter "${chapter}". Wrap every number with a unit and every symbol in \\( ... \\). Keep "formulas" and "tables" as [] unless the question itself needs them.

Make at most ${MAX_MCQ_QUESTIONS} of them MCQs. All the other questions must be descriptive (short-answer, long-answer or case-based) with "options": [].`;
}

/* -------------------------------------------------------------------------- */
/*                     Hindi / Sanskrit prompts (no RAG)                      */
/* -------------------------------------------------------------------------- */

/**
 * Subjects for these languages arrive as "<Language>: <Book name>", e.g.
 *   "Hindi: Kshitij Part 2", "Sanskrit: Shemushi part 2",
 *   "English: First Flight", "English: Workbook CBSE".
 * The chapter is the lesson / unit inside that book.
 *
 * Detection looks at the language part of the SUBJECT only (the text before
 * the colon), so a chapter title or another subject can never trigger it.
 */
const LANGUAGE_CONFIG = {
  Hindi: {
    answerLanguage: "Hindi (Devanagari script)",
    scriptRule:
      "Write the entire question, including every sub-question, in Hindi using Devanagari script only. Do not write any English or Roman-script (transliterated) words.",
  },
  Sanskrit: {
    answerLanguage: "Sanskrit (Devanagari script)",
    scriptRule:
      "Write the entire question, including every sub-question, in Sanskrit using Devanagari script only. Do not write any English, Hindi or Roman-script (transliterated) words.",
  },
  English: {
    answerLanguage: "English",
    scriptRule:
      "Write the entire question, including every sub-question, in English only. Do not write any Hindi or other-language text, except a word or line that is part of the lesson itself.",
  },
};

/**
 * Last line of defence: catches multiple-choice style stems that carry no
 * options array, e.g. "Choose the correct option: ..." / "सही विकल्प चुनें".
 */
const LANGUAGE_MCQ_STEM_RE =
  /multiple[- ]choice|which of the following|\b(?:choose|select|pick|tick)\b[^.?!]{0,40}\b(?:correct|right|appropriate|best)\b|\boptions?\b|\(\s*[A-D]\s*\)|विकल्प|सही उत्तर (?:चुन|का चयन)|निम्नलिखित में से (?:कौन|सही)|चिनुत|चयनं कुरुत/i;

function looksLikeMcqStem(question) {
  const text = [question?.questionText, ...(question?.subQuestions ?? [])]
    .filter((value) => typeof value === "string")
    .join(" ");

  return LANGUAGE_MCQ_STEM_RE.test(text);
}

function parseLanguageSubject(subject) {
  const rawSubject = String(subject ?? "").normalize("NFKC").trim();
  const colonIndex = rawSubject.indexOf(":");

  const prefix = (
    colonIndex >= 0 ? rawSubject.slice(0, colonIndex) : rawSubject
  ).toLowerCase();

  let language = null;
  if (/\bsanskrit\b/.test(prefix)) language = "Sanskrit";
  else if (/\bhindi\b/.test(prefix)) language = "Hindi";
  else if (/\benglish\b/.test(prefix)) language = "English";

  if (!language) return null;

  let book =
    colonIndex >= 0
      ? rawSubject.slice(colonIndex + 1).trim()
      : rawSubject.replace(new RegExp(`\\b${language}\\b`, "i"), "").trim();

  if (!book) book = "the prescribed NCERT/CBSE textbook";

  return { language, book };
}

function buildLanguageSystemPrompt({ requestedClass, language, book, chapter }) {
  const { answerLanguage, scriptRule } = LANGUAGE_CONFIG[language];

  return String.raw`You are a CBSE ${language} exam expert. Generate NEW practice questions from exactly one lesson / unit of a prescribed textbook:

CLASS: ${requestedClass}
SUBJECT: ${language}
TEXTBOOK: ${book}
LESSON / UNIT (story, poem, play, prose piece, or a grammar / writing unit): ${chapter}

SCOPE (most important, overrides everything else)
1. Every question must be based only on the lesson "${chapter}" from the textbook "${book}" of Class ${requestedClass}. Do not use any other lesson or any other book.
2. Base the questions on what is actually in that lesson: its story, poem or content, characters, events, poet or author, central idea, theme, message, vocabulary and the language points taught in it. If the unit is a grammar or writing unit, ask questions on that topic at Class ${requestedClass} level.
3. Do not invent plot points, characters, facts or quotations. If you are not certain of a detail, do not use it. Quote a line from the lesson only if you are sure it is accurate and you quote it completely. Never leave a quotation unfinished or cut off.
4. If you cannot reliably recall this lesson, return fewer questions (or none) rather than guessing. Never pad.

LANGUAGE (strict)
5. ${scriptRule}
6. All questions in this response must be in ${answerLanguage}. Never mix languages inside a question.

CONTENT
7. Write between 5 and ${MAX_LANGUAGE_QUESTIONS} distinct, complete questions. Never write more than ${MAX_LANGUAGE_QUESTIONS}.
8. Questions only: no answers, solutions, hints, model answers or exam-appearance claims.
9. Every question must be fully self-contained and make sense without any option list. Questions must be at the level of Class ${requestedClass} and in the style of CBSE board papers for ${language}.

FORMAT
10. This is a language subject: no formulas. Do not use LaTeX, \( \), $ or math notation. "formulas", "tables", "diagrams" and "graphs" must all be [].
11. subQuestions are optional. Use them only for a question that genuinely has parts (for example a question on a given extract or a case). They have no (a)/(b) or (i)/(ii) labels. Otherwise "subQuestions" is [].
12. Keep the JSON valid and use the exact fields required by the schema.

QUESTION TYPES (strict)
13. NO multiple-choice questions at all. There is no "options" field in the output. Never write options, choices, (A) (B) (C) (D) lists, or phrases such as "choose the correct option", "सही विकल्प चुनें" or "which of the following". Do not write fill-in-the-blank or match-the-following questions that need a list of choices.
14. Use only descriptive questions: short-answer (2-3 marks), long-answer (4-5 marks) on theme, character, message, summary or opinion, and, where it fits the lesson, a question with subQuestions.
15. Avoid trivial one-word questions. Prefer questions that check understanding of the lesson.`;
}

function buildLanguageUserPrompt({ requestedClass, language, book, chapter }) {
  const { answerLanguage } = LANGUAGE_CONFIG[language];

  return `CLASS: ${requestedClass}
SUBJECT: ${language}
TEXTBOOK: ${book}
LESSON / UNIT: ${chapter}

Generate 5 to ${MAX_LANGUAGE_QUESTIONS} new practice questions strictly from the lesson "${chapter}" of the textbook "${book}" (Class ${requestedClass}). Write every question only in ${answerLanguage}. No LaTeX, no formulas, no tables. Do NOT write any MCQ or any question that needs answer choices: every question must be a descriptive question answered in sentences.`;
}

/**
 * RAG routing (Hindi / Sanskrit / English are handled before this check).
 *  - Class 9 and 11: never use RAG.
 *  - Class 10: RAG only for mathematics, science, social science.
 *  - Class 12: RAG only for the subjects listed below.
 *  - Any other class: RAG as before.
 * Everything that does not use RAG goes through the no-RAG prompt.
 */
const NO_RAG_CLASSES = new Set([9, 11]);

const RAG_SUBJECTS_BY_CLASS = {
  10: ["mathematics", "science", "social science"],
  12: [
    "physics",
    "chemistry",
    "mathematics",
    "biology",
    "accountancy",
    "history",
    "geography",
    "sociology",
    "political science",
    "economics",
    "business studies",
    "informatics practices",
  ],
};

function classNumber(value) {
  const match = String(value ?? "").match(/\d+/);
  return match ? Number(match[0]) : NaN;
}

function shouldSkipRag(requestedClass, className, subject) {
  const classNum = Number.isNaN(classNumber(requestedClass))
    ? classNumber(className)
    : classNumber(requestedClass);

  if (NO_RAG_CLASSES.has(classNum)) return true;

  const ragSubjects = RAG_SUBJECTS_BY_CLASS[classNum];
  if (!ragSubjects) return false; // other classes keep using RAG

  const normalizedSubject = String(subject ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ");

  const allowed = ragSubjects.some((name) => normalizedSubject.includes(name));

  return !allowed;
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const normText = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Unicode-safe duplicate key (keeps Devanagari letters and marks).
 * Used only for Hindi/Sanskrit, where an ASCII-only normaliser would
 * collapse every question into an empty string.
 */
const normUnicodeText = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Generic subject check. Records without a subject are kept. */
function isSameSubject(recordSubject, requestedSubject) {
  if (!recordSubject) return true;

  const a = normText(recordSubject);
  const b = normText(requestedSubject);

  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Pulls COMPLETE question objects out of a streamed
 * {"questions":[{...},{...}]} response, one at a time, as soon as each
 * object's closing brace arrives. String/escape aware, so braces inside
 * question text (e.g. \mathrm{H_2O}) never confuse it.
 */
function createQuestionExtractor(onQuestionObject) {
  let arrayStarted = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let buffer = "";

  const trackString = (ch) => {
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = false;
    }
  };

  return function push(chunk) {
    for (const ch of chunk) {
      // Before the questions array: skip to its opening "["
      if (!arrayStarted) {
        if (inString) trackString(ch);
        else if (ch === '"') inString = true;
        else if (ch === "[") arrayStarted = true;
        continue;
      }

      // Between question objects: wait for the next "{"
      if (depth === 0) {
        if (ch === "{") {
          depth = 1;
          buffer = "{";
        }
        continue;
      }

      // Inside a question object
      buffer += ch;

      if (inString) {
        trackString(ch);
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;

        if (depth === 0) {
          let parsed = null;

          try {
            parsed = JSON.parse(buffer);
          } catch (error) {
            console.error(
              "[Important Questions RAG] Skipped an unparseable streamed question:",
              error.message
            );
          }

          buffer = "";
          if (parsed) onQuestionObject(parsed);
        }
      }
    }
  };
}

/**
 * Deterministic safety net: if the model left grouped data inline, e.g.
 *   "Find the median: Marks: 0-10, 10-20; Frequencies: 5, 10."
 * and returned no table, move the data into a Markdown table.
 * No LLM call. Skipped when a table already exists, the lists differ in
 * length, or the lists contain math (commas inside \( \) would be unsafe).
 */
const INLINE_DATA_RE =
  /^([\s\S]*?)\s*([A-Z][A-Za-z ]{0,30}):\s*([^;:]+);\s*([A-Z][A-Za-z ]{0,30}):\s*([^;:]+?)\.?\s*$/;

function moveInlineDataToTable(question) {
  if (question.tables.length) return question;

  const match = question.questionText.match(INLINE_DATA_RE);
  if (!match) return question;

  const [, intro, label1, list1, label2, list2] = match;

  if (list1.includes("\\") || list2.includes("\\") || !intro.trim()) {
    return question;
  }

  const split = (s) =>
    s.split(",").map((x) => x.trim().replace(/\|/g, "/")).filter(Boolean);

  const left = split(list1);
  const right = split(list2);

  if (left.length < 2 || left.length !== right.length) return question;

  const table = [
    `| ${label1.trim()} | ${label2.trim()} |`,
    "| --- | --- |",
    ...left.map((value, i) => `| ${value} | ${right[i]} |`),
  ].join("\n");

  return { ...question, questionText: intro.trim(), tables: [table] };
}

/* -------------------------------------------------------------------------- */
/*                       RAG prompt preparation (unchanged)                    */
/* -------------------------------------------------------------------------- */

/**
 * Steps 1-5 of the original pipeline (retrieve -> filter -> rank/dedupe ->
 * year-diverse evidence -> prompts). Used for every subject except
 * Hindi and Sanskrit.
 */
async function prepareRagPrompts({
  className,
  subject,
  chapter,
  topK,
  requestedClass,
}) {
  const requestedTopK = Math.min(
    Math.max(Number(topK) || DEFAULT_TOP_K, DEFAULT_TOP_K),
    100
  );

  // 1. Retrieve historical questions from Pinecone.
  const retrievalArgs = {
    query: `${chapter} important CBSE previous-year questions`,
    className,
    subject,
    chapter,
    topK: Math.min(requestedTopK, 50),
    candidatePool: 100,
  };

  const retrievedQuestions = await retrievePyqs(retrievalArgs);

  if (!retrievedQuestions.length) {
    throw new Error("No questions retrieved from Pinecone");
  }

  // 2. Keep records belonging to the requested class.
  const sameClassQuestions = retrievedQuestions.filter((question) =>
    isSameClass(question.className, requestedClass)
  );

  if (!sameClassQuestions.length) {
    throw new Error(
      `Pinecone returned ${retrievedQuestions.length} records, but none matched Class ${requestedClass}.`
    );
  }

  // 2b. Drop records that belong to a different subject (generic check, so it
  //     works for any subject). Falls back to the class-only set if that
  //     would leave nothing, e.g. when records carry no subject metadata.
  const subjectMatchedQuestions = sameClassQuestions.filter((question) =>
    isSameSubject(question.subject, subject)
  );

  const scopedQuestions = subjectMatchedQuestions.length
    ? subjectMatchedQuestions
    : sameClassQuestions;

  // 3. Rank and deduplicate the retrieved PYQs.
  const rankedQuestions = rankPyqs(scopedQuestions);
  const deduplicatedQuestions = deduplicateRankedPyqs(rankedQuestions);

  if (!deduplicatedQuestions.length) {
    throw new Error(
      `No usable questions were found for Class ${requestedClass}.`
    );
  }

  // 4. Select evidence from different years.
  const relevantQuestions = selectYearDiverseEvidence(
    deduplicatedQuestions,
    MAX_CONTEXT_QUESTIONS
  );

  // 5. Prepare concise historical evidence for the LLM.
  const pyqEvidence = relevantQuestions.map((question) => ({
    id: String(question.id ?? question.questionId ?? ""),
    question: getCompleteQuestionText(question),
    year: question.year ?? question.paperYear ?? null,
    marks: question.marks ?? null,
    questionType: question.questionType ?? question.type ?? null,
  }));

  console.log(
    `[Important Questions RAG] Sending ${pyqEvidence.length} PYQs to OpenAI`
  );

  return {
    systemPrompt: buildSystemPrompt({ requestedClass, subject, chapter }),
    userPrompt: buildUserPrompt({
      requestedClass,
      subject,
      chapter,
      pyqEvidence,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/*                                Main service                                */
/* -------------------------------------------------------------------------- */

export async function generateImportantQuestionsWithRag({
  className,
  subject,
  chapter,
  topK = 20,
  onQuestion,
}) {
  validateInput({ className, subject, chapter });

  const requestedClass = normalizeClass(className);

  // Hindi / Sanskrit / English: NO RAG (book + chapter prompt).
  // Class 9 / 11, and class 10 / 12 subjects outside the RAG list: NO RAG
  // (same prompt, no PYQ evidence).
  // Everything else keeps the original retrieval pipeline.
  const languageInfo = parseLanguageSubject(subject);
  const isLanguageSubject = Boolean(languageInfo);

  let systemPrompt;
  let userPrompt;

  if (isLanguageSubject) {
    const { language, book } = languageInfo;

    console.log(
      `[Important Questions] ${language} detected (book: "${book}", chapter: "${chapter}"). Skipping RAG.`
    );

    systemPrompt = buildLanguageSystemPrompt({
      requestedClass,
      language,
      book,
      chapter,
    });
    userPrompt = buildLanguageUserPrompt({
      requestedClass,
      language,
      book,
      chapter,
    });
  } else if (shouldSkipRag(requestedClass, className, subject)) {
    // NO RAG (class 9 / 11, or class 10 / 12 subject outside the RAG list).
    // Same prompt rules and same response format, but without PYQ evidence.
    console.log(
      `[Important Questions] Skipping RAG for Class ${requestedClass} "${subject}".`
    );

    systemPrompt = buildNoRagSystemPrompt({ requestedClass, subject, chapter });
    userPrompt = buildNoRagUserPrompt({ requestedClass, subject, chapter });
  } else {
    ({ systemPrompt, userPrompt } = await prepareRagPrompts({
      className,
      subject,
      chapter,
      topK,
      requestedClass,
    }));
  }

  const maxQuestions = isLanguageSubject
    ? MAX_LANGUAGE_QUESTIONS
    : MAX_GENERATED_QUESTIONS;
  const maxMcqQuestions = isLanguageSubject ? 0 : MAX_MCQ_QUESTIONS;

  // 6. Stream the generation. Every question is checked the moment it is
  //    complete: valid ones go to the frontend immediately, invalid ones are
  //    repaired in the background without blocking the others.
  const stream = await importantQuestionsOpenAI.chat.completions.create({
    model: MODEL,
    stream: true,
    temperature: isLanguageSubject
      ? LANGUAGE_GENERATION_TEMPERATURE
      : GENERATION_TEMPERATURE,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: isLanguageSubject
          ? "generated_language_practice_questions"
          : "generated_practice_questions",
        strict: true,
        schema: isLanguageSubject
          ? languageQuestionsResponseSchema
          : generatedQuestionsResponseSchema,
      },
    },
  });

  const seen = new Set();
  const tasks = [];
  const finalQuestions = []; // { index, question }

  let receivedCount = 0;
  let acceptedCount = 0;
  let mcqCount = 0;
  let removedGeneratedDuplicateCount = 0;
  let removedExtraMcqCount = 0;
  let unfixableCount = 0;
  let refusal = "";

  const emitQuestion = (index, question) => {
    finalQuestions.push({ index, question });

    if (typeof onQuestion !== "function") return;

    try {
      onQuestion({ section: "questions", index, item: question });
    } catch (error) {
      console.error(
        `[Important Questions RAG] onQuestion failed for question ${index + 1}:`,
        error.message
      );
    }
  };

  const processQuestion = async (question, index) => {
    let fixed = null;

    try {
      fixed = await validateAndRepairQuestion(question, index);
    } catch (error) {
      console.error(
        `[Important Questions RAG] Validation crashed for question ${index + 1}:`,
        error.message
      );
    }

    if (fixed) {
      emitQuestion(index, fixed);
      return;
    }

    unfixableCount += 1;

    if (!DROP_UNFIXABLE_QUESTIONS) {
      emitQuestion(index, mapQuestionStrings(question, fixString));
    }
  };

  const handleStreamedQuestion = (rawQuestion) => {
    receivedCount += 1;

    if (process.env.DEBUG_IMPORTANT_QUESTIONS) {
      console.log(
        `[IQ raw ${receivedCount}] tables=${rawQuestion?.tables?.length ?? "n/a"}`,
        JSON.stringify(rawQuestion).slice(0, 400)
      );
    }

    if (acceptedCount >= maxQuestions) return;

    let incomingQuestion = rawQuestion;

    if (isLanguageSubject) {
      // No MCQs for Hindi/Sanskrit/English: drop MCQ-style stems and force
      // "options" to [] (the language schema has no options field).
      if (looksLikeMcqStem(rawQuestion)) {
        removedExtraMcqCount += 1;
        return;
      }

      incomingQuestion = { ...rawQuestion, options: [] };
    }

    const question = sanitizeGeneratedQuestion(incomingQuestion);
    if (!question) return;

    // Hindi/Sanskrit/English use a Unicode-safe key; others keep the original.
    const normalized = isLanguageSubject
      ? normUnicodeText(question.questionText)
      : normalizeQuestionForDeduplication(question.questionText);

    if (!normalized || seen.has(normalized)) {
      removedGeneratedDuplicateCount += 1;
      return;
    }

    // Hard cap on MCQs (0 for Hindi/Sanskrit/English, so none ever pass).
    // The prompt asks for few/no MCQs, this guarantees it even if the model
    // ignores the instruction. Extra MCQs are dropped here, so they never
    // reach validation, repair or the frontend.
    if (isMcq(question)) {
      if (mcqCount >= maxMcqQuestions) {
        removedExtraMcqCount += 1;
        return;
      }
      mcqCount += 1;
    }

    seen.add(normalized);

    const index = acceptedCount;
    acceptedCount += 1;

    // Not awaited: this question is checked/repaired while the model keeps
    // generating the next ones. Dedupe above used the original text; inline
    // grouped data is moved into a Markdown table before validation.
    tasks.push(
      processQuestion(
        ENABLE_INLINE_TABLE_FALLBACK ? moveInlineDataToTable(question) : question,
        index
      )
    );
  };

  const pushChunk = createQuestionExtractor(handleStreamedQuestion);

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;

    if (delta?.refusal) refusal += delta.refusal;
    if (delta?.content) pushChunk(delta.content);
  }

  // Wait for any repairs that are still running.
  await Promise.all(tasks);

  if (!receivedCount) {
    throw new Error(
      refusal
        ? `OpenAI refused the Important Questions request: ${refusal}`
        : "OpenAI returned an empty Important Questions response"
    );
  }

  if (!finalQuestions.length) {
    throw new Error(
      "No valid questions could be generated. Please retry generation."
    );
  }

  // Keep generation order in the returned value (useful for caching).
  const questions = finalQuestions
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.question);

  console.log(
    `[Important Questions RAG] Received=${receivedCount}, ` +
      `removedDuplicates=${removedGeneratedDuplicateCount}, ` +
      `removedExtraMcqs=${removedExtraMcqCount}, ` +
      `unfixableLatex=${unfixableCount}, ` +
      `sent=${questions.length}`
  );

  // 7. Return only the simplified question response.
  return {
    questions,
  };
}