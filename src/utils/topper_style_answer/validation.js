/**
 * Topper Style Answer checks.
 *
 *  - Free, deterministic fixes run first (fences, math delimiters, stray
 *    symbols, table spacing, leading "Solution:" labels).
 *  - LaTeX and language rules are BLOCKING (the answer cannot be used).
 *  - Format and marks-length rules are SOFT: they trigger a rewrite, but if
 *    only soft problems remain after the last repair round the answer is
 *    still accepted (see the service).
 *  - If the optional `katex` package is installed, every formula is also
 *    render-tested.
 */

const DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
const INLINE_RE = /\$(?!\$)([^\n$]+?)\$(?!\$)/g;

// Code spans and math spans that plain-text fixes must never touch.
const PROTECTED_RE =
  /(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]+?\$\$|\$(?!\$)[^\n$]+?\$(?!\$))/g;

const DEVANAGARI = /[\u0900-\u097F]/g;
const LATIN = /[A-Za-z]/g;
const ACRONYM_RE = /\b[A-Z]{2,}\b/g;

const MAX_ERRORS = 8;
const MATH_MARK = "\u0001";

// Plain unicode symbols that must live inside math delimiters.
const SYMBOLS = {
  "≥": "\\geq",
  "≤": "\\leq",
  "≠": "\\neq",
  "±": "\\pm",
  "≈": "\\approx",
  "×": "\\times",
  π: "\\pi",
  θ: "\\theta",
  α: "\\alpha",
  β: "\\beta",
  γ: "\\gamma",
  μ: "\\mu",
  λ: "\\lambda",
  ω: "\\omega",
  ρ: "\\rho",
  σ: "\\sigma",
  τ: "\\tau",
  φ: "\\phi",
  η: "\\eta",
  Δ: "\\Delta",
  Σ: "\\Sigma",
  Ω: "\\Omega",
};

const SYMBOL_RE = new RegExp(`[${Object.keys(SYMBOLS).join("")}]`, "g");

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

export function normalizeSubject(subject) {
  return String(subject || "").trim().toLowerCase();
}

/** "hindi" | "sanskrit" | "english" (every other subject is English). */
export function getLanguage(subject) {
  const normalized = normalizeSubject(subject);
  if (normalized.startsWith("hindi")) return "hindi";
  if (normalized.startsWith("sanskrit")) return "sanskrit";
  return "english";
}

/**
 * Reads the marks from the question text ("3 marks", "[5]", "5 अंक").
 * Several parts ("(a) 2 marks (b) 3 marks") are added up.
 * Returns null when no marks are written.
 */
export function extractMarks(question) {
  const text = String(question || "");
  let total = 0;

  for (const match of text.matchAll(
    /(\d{1,2})\s*-?\s*(?:marks?|अंक(?:ों)?)/gi
  )) {
    total += Number(match[1]);
  }

  if (!total) {
    const bracket = text.match(/\[\s*(\d{1,2})\s*\]\s*$/);
    if (bracket) total = Number(bracket[1]);
  }

  return total >= 1 && total <= 20 ? total : null;
}

/** Programming / SQL questions are allowed to use code blocks. */
export function isCodeQuestion({ question, subject }) {
  return (
    /comput|informat|coding/i.test(String(subject || "")) ||
    /\b(sql|mysql|query|queries|python|program|programme|pseudocode|algorithm|function|dbms|database|html|java|command|statement|create table|select)\b/i.test(
      String(question || "")
    )
  );
}

/* -------------------------------------------------------------------------- */
/*                         Free, deterministic repairs                        */
/* -------------------------------------------------------------------------- */

function mapOutsideMath(text, fn) {
  return text
    .split(PROTECTED_RE)
    .map((part, index) => (index % 2 === 0 ? fn(part) : part))
    .join("");
}

const fixPlainSymbols = (segment) =>
  segment
    .replace(/(\d+(?:\.\d+)?)\s*°/g, (_, n) => `$${n}^\\circ$`)
    .replace(/°/g, () => "$^\\circ$")
    .replace(SYMBOL_RE, (ch) => `$${SYMBOLS[ch]}$`);

// Only unwrap a fence that wraps the WHOLE answer. A real code block (SQL,
// Python) that starts or ends the answer must stay intact.
function unwrapFence(text) {
  const start = text.match(/^\s*```(markdown|md|latex|text)?[ \t]*\n/i);
  if (!start) return text;

  const fenceCount = (text.match(/```/g) || []).length;
  const labelled = Boolean(start[1]);

  // "```\n...\n```" with nothing else inside is a wrapper, not code.
  if (!labelled && fenceCount !== 2) return text;
  if (!/\n```\s*$/.test(text)) return text;

  return text.slice(start[0].length).replace(/\n```\s*$/, "");
}

function stripLeadingLabel(text) {
  return text.replace(
    /^\s*\**\s*(?:solution|answer|ans|उत्तर|हल)\s*\**\s*[:：]\s*\**\s*/i,
    ""
  );
}

const TABLE_LINE = /^\s*\|.*\|\s*$/;

// A Markdown table needs a blank line before and after it.
function fixTableSpacing(text) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    if (!inFence) {
      const isTable = TABLE_LINE.test(line);
      const prev = out[out.length - 1];
      const prevIsTable = prev !== undefined && TABLE_LINE.test(prev);

      if (isTable && !prevIsTable && prev !== undefined && prev.trim() !== "") {
        out.push("");
      }
      if (!isTable && prevIsTable && line.trim() !== "") {
        out.push("");
      }
    }

    out.push(line);
  }

  return out.join("\n");
}

export function autoFixAnswer(input) {
  if (typeof input !== "string") return "";

  let out = input
    .replace(/\r\n?/g, "\n")
    // control characters (newline and tab are fine)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  out = unwrapFence(out);

  out = out
    // over-escaped commands: \\frac -> \frac
    .replace(/\\\\(?=[a-zA-Z]{2,})/g, "\\")
    // \( x \) -> $x$   and   \[ x \] -> $$x$$
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, inner) => `$${inner.trim()}$`)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, inner) => `$$${inner.trim()}$$`);

  out = mapOutsideMath(out, fixPlainSymbols);
  out = stripLeadingLabel(out);
  out = fixTableSpacing(out);

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/* -------------------------------------------------------------------------- */
/*                              Math extraction                               */
/* -------------------------------------------------------------------------- */

// Code (SQL / programming) must not be mistaken for broken LaTeX.
const stripCode = (text) =>
  text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");

function extractMath(text) {
  const display = [...text.matchAll(DISPLAY_RE)].map((m) => m[1]);
  const withoutDisplay = text.replace(DISPLAY_RE, " ");
  const inline = [...withoutDisplay.matchAll(INLINE_RE)].map((m) => m[1]);
  const outside = withoutDisplay.replace(INLINE_RE, " ");

  return { display, inline, outside, withoutDisplay };
}

function bracesBalanced(source) {
  let depth = 0;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i += 1; // skip the escaped character (\{ \} \\)
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth < 0) return false;
  }

  return depth === 0;
}

/* -------------------------------------------------------------------------- */
/*                         Optional KaTeX render check                        */
/* -------------------------------------------------------------------------- */

let katexPromise;

// Resolves to null when `katex` is not installed on the backend.
const loadKatex = () => {
  katexPromise ??= import("katex")
    .then((mod) => mod.default ?? mod)
    .catch(() => null);
  return katexPromise;
};

/* -------------------------------------------------------------------------- */
/*                         LaTeX rules (strict, blocking)                     */
/* -------------------------------------------------------------------------- */

async function validateLatex(text) {
  const issues = [];
  const body = stripCode(text);

  if (/\\\(|\\\)|\\\[|\\\]/.test(body)) {
    issues.push("Use only $...$ and $$...$$ delimiters.");
  }

  const { display, inline, outside, withoutDisplay } = extractMath(body);

  if (withoutDisplay.includes("$$")) {
    issues.push("Unclosed display math delimiter ($$).");
  }

  if (outside.replace(/\$\$/g, "").includes("$")) {
    issues.push(
      "Unclosed or stray $ sign. Every $ needs a closing $ and money must be written with \u20B9, not $."
    );
  }

  if (/\\[a-zA-Z]+/.test(outside)) {
    issues.push("A LaTeX command was found outside math delimiters.");
  }

  if (outside.includes("^")) {
    issues.push("A raw ^ was found outside math delimiters. Put exponents inside $...$.");
  }

  const segments = [
    ...display.map((source) => ({ source, displayMode: true })),
    ...inline.map((source) => ({ source, displayMode: false })),
  ];

  const katex = await loadKatex();

  for (const { source, displayMode } of segments) {
    const preview = source.trim().slice(0, 40);

    if (!source.trim()) {
      issues.push("Empty math expression.");
      continue;
    }

    if (/\\ce\b/.test(source)) {
      issues.push(`Math "${preview}": \\ce is not allowed, use \\mathrm{...}.`);
    }

    if (source.includes("**")) {
      issues.push(`Math "${preview}": Markdown bold is not allowed inside math.`);
    }

    if (!bracesBalanced(source)) {
      issues.push(`Math "${preview}": unbalanced { } braces.`);
      continue;
    }

    if (katex) {
      try {
        katex.renderToString(source, {
          throwOnError: true,
          displayMode,
          strict: "ignore",
        });
      } catch (error) {
        const reason = String(error?.message ?? "invalid math")
          .replace(/^KaTeX parse error:\s*/i, "")
          .split("\n")[0]
          .slice(0, 100);
        issues.push(`Math "${preview}" does not render: ${reason}`);
      }
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*                         Language rule (blocking)                           */
/* -------------------------------------------------------------------------- */

function validateLanguage(text, subject) {
  const language = getLanguage(subject);

  const { outside } = extractMath(stripCode(text));
  const plain = outside.replace(ACRONYM_RE, " ");

  const devanagari = (plain.match(DEVANAGARI) || []).length;
  const latin = (plain.match(LATIN) || []).length;

  if (language === "hindi" || language === "sanskrit") {
    if (devanagari === 0) {
      return [`The answer must be written in ${language} (Devanagari).`];
    }
    if (latin > devanagari * 0.3) {
      return [`Too much English. Write the answer in ${language}.`];
    }
    return [];
  }

  if (devanagari > 0) {
    return ["The answer must be written in English only."];
  }

  return [];
}

/* -------------------------------------------------------------------------- */
/*                         Format rules (soft)                                */
/* -------------------------------------------------------------------------- */

function validateFormat(text, { question, subject }) {
  const issues = [];

  if (/```/.test(text) && !isCodeQuestion({ question, subject })) {
    issues.push("Do not use code blocks. Code blocks are only for SQL or programming questions.");
  }

  const body = stripCode(text);

  if (/^\s{0,3}#{1,6}\s/m.test(body)) {
    issues.push("Do not use Markdown headings (#). Start directly with the answer.");
  }

  if (/^\s*>\s/m.test(body)) {
    issues.push("Do not use blockquotes (>).");
  }

  // Every table needs a separator row right under the header row.
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!TABLE_LINE.test(lines[i])) continue;
    const startsBlock = i === 0 || !TABLE_LINE.test(lines[i - 1]);
    if (!startsBlock) continue;

    const separator = lines[i + 1] || "";
    if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(separator)) {
      issues.push("A Markdown table is missing its |---|---| separator row.");
      break;
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*                         Marks-based length (soft)                          */
/* -------------------------------------------------------------------------- */

// Counts prose sentences / list points. Lines that contain math or tables
// are calculation lines and are not counted, so numericals never trip this.
function countProseSentences(text) {
  const prose = stripCode(text)
    .replace(DISPLAY_RE, `\n${MATH_MARK}\n`)
    .replace(INLINE_RE, MATH_MARK);

  let count = 0;

  for (const rawLine of prose.split("\n")) {
    if (!rawLine.trim() || rawLine.includes(MATH_MARK) || TABLE_LINE.test(rawLine)) {
      continue;
    }

    const line = rawLine
      .replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, "")
      .replace(/\*\*/g, "");

    for (const part of line.split(/(?<=[.!?\u0964])\s+/)) {
      if (/[\p{L}\p{M}]{2,}/u.test(part)) count += 1;
    }
  }

  return count;
}

function validateLength(text, { question }) {
  const marks = extractMarks(question);

  // 6+ mark answers have no sentence limit. Code answers are query-only.
  if (!marks || marks > 5 || /```/.test(text)) return [];

  const sentences = countProseSentences(text);

  // +1 tolerance: abbreviations such as "e.g." can inflate the count.
  if (sentences > marks + 1) {
    return [
      `The answer has about ${sentences} sentences or points but the question is worth ${marks} mark(s). Keep it to at most ${marks} sentence(s) or point(s).`,
    ];
  }

  return [];
}

/* -------------------------------------------------------------------------- */
/*                                Main validator                              */
/* -------------------------------------------------------------------------- */

/**
 * @returns {Promise<{ valid: boolean, issues: string[], blocking: string[], text: string }>}
 *   `issues`   every problem found (blocking + soft), sent to the repair round.
 *   `blocking` only the problems that make the answer unusable.
 *   `text`     the cleaned answer (also returned when invalid, so a repair
 *              request can show the model a tidy copy).
 */
export async function validateTopperAnswer({ answer, subject, question }) {
  const text = autoFixAnswer(answer);

  if (!text) {
    const issues = ["The answer is empty."];
    return { valid: false, issues, blocking: issues, text: "" };
  }

  const blocking = [
    ...validateLanguage(text, subject),
    ...(await validateLatex(text)),
  ];

  const soft = [
    ...validateFormat(text, { question, subject }),
    ...validateLength(text, { question }),
  ];

  const issues = [...blocking, ...soft].slice(0, MAX_ERRORS);

  return {
    valid: issues.length === 0,
    issues,
    blocking: blocking.slice(0, MAX_ERRORS),
    text,
  };
}