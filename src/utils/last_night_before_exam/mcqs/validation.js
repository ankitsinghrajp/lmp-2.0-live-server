import katex from "katex";

/**
 * MCQ validation.
 *
 * Same philosophy as Important / Predicted Questions: nothing here throws for a
 * "soft" problem. Each MCQ is
 *   sanitize -> deterministic fix -> KaTeX check -> (LLM repair -> fix -> check) x N
 * and an MCQ that still fails is dropped on its own, so one bad MCQ can never
 * fail the whole request.
 *
 * Problems that used to reject the whole response and are now fixed silently:
 *  - "correct" not matching an option text   -> the model gives correctIndex
 *  - explanation mentioning option letters   -> those sentences are removed
 *  - option labels such as (A) / B.          -> stripped
 *  - Roman glosses in Hindi / Sanskrit       -> stripped
 *  - bad formula                             -> dropped (formula is optional)
 *  - wrong count of MCQs                     -> extra ones ignored, fewer accepted
 */

const LOG = "[MCQs]";

const MIN_QUESTION_LENGTH = 10;
const MAX_QUESTION_LENGTH = 1500;
const MAX_FORMULA_LENGTH = 250;
const MAX_REPAIR_ATTEMPTS = 2;
const SIMILARITY_LIMIT = 0.75;

// Matches \( ... \) (group 1) and \[ ... \] (group 2)
const MATH_RE = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;

// LaTeX-looking things that must never appear outside a math span.
const STRAY_LATEX_RE =
  /\\[a-zA-Z]+|\\[()[\]]|[A-Za-z0-9})]_[{A-Za-z0-9]|\^[{0-9A-Za-z-]|\$|[₀-₉⁰-⁹⁺⁻→⇌]/;

const LABEL_RE = /^\s*(?:\([A-Da-d]\)|\([कखगघ]\)|[A-Da-d][.)])\s+/;

// "Option B", "choice 2", "(B)", "विकल्प 1", "first option" ...
const OPTION_REF_RE =
  /(?:\b(?:[Oo]ption|[Cc]hoice)\s+\(?[A-D1-4]\)?|विकल्प\s*\(?[A-Da-d1-4]\)?)(?![\p{L}\p{N}])|\([A-D]\)|\b(?:first|second|third|fourth|last)\s+(?:option|choice)\b/u;

// Options that refer to other options must keep their position.
const NO_SHUFFLE_RE =
  /\b(?:above|both|all of|none of|neither)\b|उपरोक्त|दोनों|सभी|कोई नहीं|उभौ|सर्वे/i;

const hasDevanagari = (text) => /[ऀ-ॿ]/.test(text);

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

/**
 * NON-THROWING cleanup that runs BEFORE any repair. Returns null when the MCQ
 * cannot be used at all (not an object, no stem, not exactly 4 options, no
 * valid correctIndex). Everything fixable is fixed instead of failing.
 */
export function sanitizeMcq(raw, { isLanguage = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const question = typeof raw.question === "string" ? raw.question.trim() : "";

  if (
    question.length < MIN_QUESTION_LENGTH ||
    question.length > MAX_QUESTION_LENGTH
  ) {
    return null;
  }

  if (!Array.isArray(raw.options)) return null;

  let options = raw.options.map((o) => (typeof o === "string" ? o.trim() : ""));

  if (options.length !== 4 || options.some((o) => !o)) return null;

  // Strip "(A)", "B." ... only when ALL four options carry a label.
  // Otherwise an option like "A. P. J. Abdul Kalam" would be damaged.
  if (options.every((o) => LABEL_RE.test(o))) {
    options = options.map((o) => o.replace(LABEL_RE, "").trim());
    if (options.some((o) => !o)) return null;
  }

  const correctIndex = Number(raw.correctIndex);

  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
    return null;
  }

  return {
    question,
    options,
    correctIndex,
    explanation:
      typeof raw.explanation === "string" ? raw.explanation.trim() : "",
    formula: isLanguage || typeof raw.formula !== "string" ? "" : raw.formula,
  };
}

/* -------------------------------------------------------------------------- */
/*                         Field helpers (text fields)                        */
/* -------------------------------------------------------------------------- */

/** Returns [{ path, value }] for every text field that may contain math. */
function getMcqFields(mcq) {
  const fields = [
    { path: "question", value: mcq.question },
    { path: "explanation", value: mcq.explanation },
  ];

  mcq.options.forEach((value, index) => {
    fields.push({ path: `options.${index}`, value });
  });

  return fields.filter((field) => typeof field.value === "string");
}

function setMcqField(mcq, path, value) {
  const [key, index] = path.split(".");

  if (index === undefined) {
    mcq[key] = value;
  } else if (key === "options" && Array.isArray(mcq.options)) {
    mcq.options[Number(index)] = value;
  }
}

function mapMcqStrings(mcq, fn) {
  const next = structuredClone(mcq);

  for (const { path, value } of getMcqFields(next)) {
    setMcqField(next, path, fn(value));
  }

  return next;
}

/* -------------------------------------------------------------------------- */
/*                         Deterministic text fixing                          */
/* -------------------------------------------------------------------------- */

/** Unicode symbols that are safe to convert inside a math span. */
const cleanMathSymbols = (tex) =>
  tex
    .replace(/\\ce\s*\{/g, "\\mathrm{")
    .replace(/\\degree(?![a-zA-Z])/g, "^\\circ")
    .replace(/\\(?:textbf|textit|textrm|text|mbox)\s*\{/g, "\\mathrm{")
    .replace(/\\(?:qquad|quad)(?![a-zA-Z])/g, "\\,")
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
    .replace(/\\mathrm\{([^{}]*?)\s*\\times\s*([^{}]*?)\}/g, "\\mathrm{$1\\,$2}");

/** JSON escape corruption and double escapes. */
const repairEscapes = (text) =>
  String(text ?? "")
    // \frac -> <FF>rac, \times -> <TAB>imes, \beta -> <BS>eta,
    // \rho -> <CR>ho, \vec -> <VT>ec, \neq -> <LF>eq
    .replace(/\f(?=[a-zA-Z])/g, "\\f")
    .replace(/\t(?=[a-zA-Z])/g, "\\t")
    .replace(/\x08(?=[a-zA-Z])/g, "\\b")
    .replace(/\r(?=[a-zA-Z])/g, "\\r")
    .replace(/\v(?=[a-zA-Z])/g, "\\v")
    .replace(/\n(?=(?:eq|abla|ot|ewline|leq|geq|mid|ightarrow|u)\b)/g, "\\n")
    // Double-escaped commands: \\mathrm -> \mathrm, \\( -> \(
    .replace(/\\\\(?=[a-zA-Z]{2,}|[()[\]])/g, "\\");

function fixString(text) {
  return repairEscapes(text).replace(MATH_RE, (full, inline, display) =>
    inline !== undefined
      ? `\\(${cleanMathSymbols(inline)}\\)`
      : `\\[${cleanMathSymbols(display)}\\]`
  );
}

/**
 * Language subjects: no math at all. Strips math delimiters, and for
 * Hindi / Sanskrit also Roman glosses in brackets, e.g. "कवि (Poet)" -> "कवि".
 */
function fixLanguageText(text, devanagari) {
  let s = String(text ?? "")
    .replace(/\\[()[\]]/g, "")
    .replace(/\$/g, "");

  if (devanagari) {
    s = s.replace(/\s*\([^()]*[A-Za-z][^()]*\)/g, "");
  }

  return s
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .trim();
}

/** Formula: raw LaTeX, no delimiters, single line. */
function sanitizeFormula(raw) {
  const value = repairEscapes(raw)
    .replace(/\r?\n+/g, " ")
    .trim()
    .replace(/^\\\(([\s\S]*)\\\)$/, "$1")
    .replace(/^\\\[([\s\S]*)\\\]$/, "$1")
    .replace(/\$/g, "");

  return cleanMathSymbols(value).replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------------------------- */
/*                              LaTeX / content checks                        */
/* -------------------------------------------------------------------------- */

const renderError = (tex, displayMode) => {
  try {
    katex.renderToString(tex, {
      throwOnError: true,
      displayMode,
      strict: "ignore",
      trust: false,
    });
    return null;
  } catch (error) {
    return error.message;
  }
};

/** Returns a list of human-readable problems for one string. */
function findLatexProblems(text) {
  const problems = [];

  for (const match of text.matchAll(MATH_RE)) {
    const isDisplay = match[2] !== undefined;
    const tex = (match[1] ?? match[2]).trim();
    const error = renderError(tex, isDisplay);

    if (error) problems.push(`KaTeX failed on "${tex}": ${error}`);
  }

  const outsideMath = text.replace(MATH_RE, " ");

  if (STRAY_LATEX_RE.test(outsideMath)) {
    problems.push(
      "Formula notation (LaTeX command, _ or ^, $, or a Unicode subscript/arrow) appears outside a \\( ... \\) or \\[ ... \\] span."
    );
  }

  const count = (re) => (text.match(re) || []).length;

  if (
    count(/\\\(/g) !== count(/\\\)/g) ||
    count(/\\\[/g) !== count(/\\\]/g)
  ) {
    problems.push("Unbalanced \\( \\) or \\[ \\] delimiters.");
  }

  return problems;
}

/** Returns [{ path, text, error }] for every failing field of an MCQ. */
function collectLatexIssues(mcq) {
  const issues = [];

  for (const { path, value } of getMcqFields(mcq)) {
    const problems = findLatexProblems(value);

    if (problems.length) {
      issues.push({ path, text: value, error: problems.join(" | ") });
    }
  }

  return issues;
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

const repairSystemPrompt = String.raw`You fix broken LaTeX in CBSE multiple-choice questions. You receive failing text fields (a question stem, an answer option or an explanation) together with the KaTeX error for each.

1. Fix syntax only. Do not change the wording, numbers, units or meaning. Do not solve, balance, complete or add anything. Keep each option a separate answer choice.
2. Every formula, equation, reaction, chemical formula, symbol and number-with-unit must be inside \( ... \) (inline) or \[ ... \] (display). Never use $.
3. Chemistry: one math span per reaction, e.g. \(\mathrm{2H_2 + O_2 \rightarrow 2H_2O}\). Use \mathrm, \rightarrow, \rightleftharpoons, \mathrm{(aq)}. Never \ce, never Unicode subscripts or arrows.
4. Never use \text. Fix unbalanced braces, unknown commands, and unbalanced or missing delimiters.
4b. Every number with a unit, Greek letter and degree sign must be inside math, e.g. \(5\,\mu\mathrm{C}\), \(E = 300\,\mathrm{N/C}\), \(30^\circ\). Join units with \, never \times.
5. In your JSON output every LaTeX backslash is doubled: \\( \\mathrm \\frac \\rightarrow.
6. Return every field you were given, using exactly the same "path" values.`;

const digitsOf = (s) => s.replace(/\D/g, "");

/**
 * Asks the model to repair only the failing fields. Returns a NEW MCQ.
 * A fix is rejected if it changes any digit (guards against changed values).
 */
async function repairMcqWithLlm(mcq, issues, { client, model }) {
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
  const repaired = structuredClone(mcq);

  for (const { path, fixed } of fixes) {
    const before = original.get(path);

    if (before === undefined) continue; // model invented a path

    if (digitsOf(fixed) !== digitsOf(before)) {
      console.warn(`${LOG} Repair rejected for "${path}": numbers changed`);
      continue;
    }

    setMcqField(repaired, path, fixed);
  }

  return repaired;
}

/* -------------------------------------------------------------------------- */
/*                              Building the result                           */
/* -------------------------------------------------------------------------- */

// Comparison key for "are these options distinct", ignoring math delimiters.
const optionKey = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\\[()[\]]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");

function shuffle(array) {
  const copy = [...array];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

/**
 * Explanation must not point at option positions (options get shuffled).
 * Sentences that do are removed; if nothing is left (or the model wrote no
 * explanation) a plain fallback is used.
 */
function cleanExplanation(explanation, correct) {
  const text = String(explanation ?? "").trim();

  if (text && !OPTION_REF_RE.test(text)) return text;

  const kept = text
    .split(/(?<=[.!?।])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !OPTION_REF_RE.test(sentence));

  return kept.length ? kept.join(" ") : `The correct answer is ${correct}.`;
}

/** Turns a validated working MCQ into the final frontend shape. */
function buildFinalMcq(current, { isLanguage }) {
  const { options } = current;

  if (new Set(options.map(optionKey)).size !== 4) {
    return { error: "options are not distinct" };
  }

  const correct = options[current.correctIndex];

  if (typeof correct !== "string" || !correct) {
    return { error: "correctIndex does not point at an option" };
  }

  // Formula is optional: an unusable one is dropped, never an error.
  let formula = "";

  if (!isLanguage && current.formula) {
    const candidate = sanitizeFormula(current.formula);

    if (
      candidate &&
      candidate.length <= MAX_FORMULA_LENGTH &&
      !/[^\x20-\x7E]/.test(candidate) &&
      !renderError(candidate, false)
    ) {
      formula = candidate;
    }
  }

  // Remove "correct answer is always B/C" bias.
  const finalOptions = options.some((o) => NO_SHUFFLE_RE.test(o))
    ? options
    : shuffle(options);

  return {
    mcq: {
      question: current.question,
      options: finalOptions,
      correct,
      explanation: cleanExplanation(current.explanation, correct),
      formula,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                               Public validator                             */
/* -------------------------------------------------------------------------- */

/**
 * Returns the final MCQ { question, options, correct, explanation, formula },
 * or null if it must be dropped.
 *
 * options: { client, model, isLanguage, languageKey }
 *  - client / model: OpenAI client and model used for LaTeX repair
 *  - isLanguage: Hindi / Sanskrit / English (no math, no repair, no LLM call)
 */
export async function validateAndRepairMcq(mcq, index, options) {
  const { client, model, isLanguage = false, languageKey = null } = options;

  // Language subjects: plain text only. Clean it and check the script.
  if (isLanguage) {
    const devanagari = languageKey === "hindi" || languageKey === "sanskrit";
    const cleaned = mapMcqStrings(mcq, (text) =>
      fixLanguageText(text, devanagari)
    );

    if (!cleaned.question || cleaned.options.some((o) => !o)) return null;

    if (devanagari && !hasDevanagari(cleaned.question)) {
      console.error(
        `${LOG} MCQ ${index + 1} dropped: no Devanagari text in a ${languageKey} question`
      );
      return null;
    }

    const built = buildFinalMcq(cleaned, { isLanguage: true });

    if (built.error) {
      console.error(`${LOG} MCQ ${index + 1} dropped: ${built.error}`);
      return null;
    }

    return built.mcq;
  }

  let current = mapMcqStrings(mcq, fixString);

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const issues = collectLatexIssues(current);

    if (!issues.length) {
      const built = buildFinalMcq(current, { isLanguage: false });

      if (built.error) {
        console.error(`${LOG} MCQ ${index + 1} dropped: ${built.error}`);
        return null;
      }

      if (attempt > 0) {
        console.log(
          `${LOG} MCQ ${index + 1} repaired after ${attempt} LLM attempt(s)`
        );
      }

      return built.mcq;
    }

    if (attempt === MAX_REPAIR_ATTEMPTS) {
      console.error(
        `${LOG} MCQ ${index + 1} still invalid after repairs:`,
        issues.map((i) => ({ path: i.path, error: i.error }))
      );
      return null;
    }

    try {
      const repaired = await repairMcqWithLlm(current, issues, {
        client,
        model,
      });
      current = mapMcqStrings(repaired, fixString);
    } catch (error) {
      console.error(
        `${LOG} Repair call failed for MCQ ${index + 1}:`,
        error.message
      );
      return null;
    }
  }

  return null;
}