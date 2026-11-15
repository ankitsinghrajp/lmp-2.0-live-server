import katex from "katex";

import { importantQuestionsOpenAI } from "../../config/importantQuestionsOpenAI.js";
import { getQuestionContentIssues } from "../important_questions/validation.utils.js";

const REPAIR_MODEL = "gpt-4o-mini";
const MAX_REPAIR_ATTEMPTS = 2;

// Matches \( ... \) (group 1) and \[ ... \] (group 2)
const MATH_RE = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;

// LaTeX-looking things that must never appear outside a math span.
const STRAY_LATEX_RE =
  /\\[a-zA-Z]+|\\[()[\]]|[A-Za-z0-9})]_[{A-Za-z0-9]|\^[{0-9A-Za-z-]|\$|[₀-₉⁰-⁹⁺⁻→⇌]/;

const repairSchema = {
  type: "object",
  properties: {
    fixed: { type: "string" },
  },
  required: ["fixed"],
  additionalProperties: false,
};

const repairSystemPrompt = String.raw`You fix broken LaTeX / Markdown in one CBSE previous-year question. You receive the question text and the problems found in it.

1. Fix syntax only. Do not change the wording, numbers, units or meaning. Do not solve, complete or add anything.
2. Every formula, equation, reaction, chemical formula, symbol and number-with-unit must be inside \( ... \) (inline) or \[ ... \] (display). Never use $.
3. Chemistry: one math span per reaction, e.g. \(\mathrm{2H_2 + O_2 \rightarrow 2H_2O}\). Use \mathrm, \rightarrow, \rightleftharpoons, \mathrm{(aq)}. Never \ce, never Unicode subscripts or arrows.
4. Never use \text. Fix unbalanced braces, unknown commands, and unbalanced or missing delimiters.
5. A table must be a Markdown table with a header row and a separator row (| --- | --- |), one row per line. Keep all cell data exactly as given; never invent data.
6. Every number with a unit, Greek letter and degree sign must be inside math, e.g. \(5\,\mu\mathrm{C}\), \(30^\circ\). Join units with \, never \times.
7. Keep line breaks (sub-parts and options each on their own line).
8. In your JSON output every LaTeX backslash is doubled: \\( \\mathrm \\frac \\rightarrow.
9. Return the whole corrected question in "fixed".`;

const digitsOf = (s) => String(s).replace(/\D/g, "");

/**
 * Cheap, deterministic fixes. These cost nothing and clear most of the
 * "model wrote bad LaTeX" cases before KaTeX or the repair LLM is involved.
 */
export function fixString(text) {
  let s = String(text ?? "");

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

/** KaTeX errors + formula notation that sits outside a math span. */
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

function collectProblems(text) {
  const problems = findLatexProblems(text);

  // Delimiter balance and "$" usage (shared with the Important Questions pipeline).
  const issues = getQuestionContentIssues({
    questionText: text,
    options: [],
    formulas: [],
    tables: [],
    diagrams: [],
    graphs: [],
    subQuestions: [],
  });

  for (const issue of issues) problems.push(issue.error);

  // Tables live inside the question string for PYQs: check their shape here.
  const lines = text.split("\n");
  const hasTableRows = lines.some((line) => /^\s*\|.*\|\s*$/.test(line));
  const hasSeparator = lines.some((line) => /^\s*\|?\s*:?-{3,}/.test(line));

  if (hasTableRows && !hasSeparator) {
    problems.push(
      "A Markdown table needs a separator row such as | --- | --- | after the header row."
    );
  }

  return [...new Set(problems)];
}

async function repairWithLlm(text, problems) {
  const response = await importantQuestionsOpenAI.chat.completions.create({
    model: REPAIR_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: repairSystemPrompt },
      { role: "user", content: JSON.stringify({ question: text, problems }) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "pyq_latex_fix",
        strict: true,
        schema: repairSchema,
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LaTeX repair returned an empty response");
  }

  const { fixed } = JSON.parse(content);

  if (typeof fixed !== "string" || !fixed.trim()) {
    throw new Error("LaTeX repair returned an empty question");
  }

  // Guard: a repair must never change a number.
  if (digitsOf(fixed) !== digitsOf(text)) {
    console.warn("[PYQ RAG] LaTeX repair rejected: numbers changed");
    return text;
  }

  return fixed;
}

/**
 * deterministic fix -> KaTeX/shape check -> (LLM repair -> fix -> check) x N
 * Returns the valid text, or null if it could not be fixed.
 */
export async function validateAndRepairText(text, label = "question") {
  let current = fixString(text);

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const problems = collectProblems(current);

    if (!problems.length) {
      if (attempt > 0) {
        console.log(
          `[PYQ RAG] ${label} repaired after ${attempt} LLM attempt(s)`
        );
      }
      return current;
    }

    if (attempt === MAX_REPAIR_ATTEMPTS) {
      console.error(
        `[PYQ RAG] ${label} still invalid after repairs:`,
        problems
      );
      return null;
    }

    try {
      current = fixString(await repairWithLlm(current, problems));
    } catch (error) {
      console.error(
        `[PYQ RAG] Repair call failed for ${label}:`,
        error.message
      );
      return null;
    }
  }

  return null;
}