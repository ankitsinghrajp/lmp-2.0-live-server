/**
 * Ask Any Question checks.
 *
 *  - NO limits on length, line count or wording.
 *  - Free, deterministic fixes run first (fences, math delimiters).
 *  - LaTeX stays strict. If the optional `katex` package is installed,
 *    every formula is also render-tested.
 *  - The caller rewrites the answer only when something is still wrong.
 */

const DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
const INLINE_RE = /\$(?!\$)([^\n$]+?)\$(?!\$)/g;

const DEVANAGARI = /[\u0900-\u097F]/g;
const LATIN = /[A-Za-z]/g;
const ACRONYM_RE = /\b[A-Z]{2,}\b/g;

const MAX_ERRORS = 8;

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

export function normalizeSubject(subject) {
  return String(subject || "").trim().toLowerCase();
}

export function isLanguageSubject(subject) {
  return ["hindi", "sanskrit"].includes(normalizeSubject(subject));
}

/* -------------------------------------------------------------------------- */
/*                         Free, deterministic repairs                        */
/* -------------------------------------------------------------------------- */

export function autoFixAnswer(input) {
  if (typeof input !== "string") return "";

  return (
    input
      .replace(/\r\n?/g, "\n")
      // control characters (newline and tab are fine)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      // code fence around the whole answer
      .replace(/^\s*```(?:markdown|md|latex|text)?\n/i, "")
      .replace(/\n```\s*$/, "")
      // over-escaped commands: \\frac -> \frac
      .replace(/\\\\(?=[a-zA-Z]{2,})/g, "\\")
      // \( x \) -> $x$   and   \[ x \] -> $$x$$
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, inner) => `$${inner.trim()}$`)
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, inner) => `$$${inner.trim()}$$`)
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/* -------------------------------------------------------------------------- */
/*                              Math extraction                               */
/* -------------------------------------------------------------------------- */

// Code (for programming questions) must not be mistaken for broken LaTeX.
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
/*                              LaTeX rules (strict)                          */
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
/*                               Language rule                                */
/* -------------------------------------------------------------------------- */

function validateLanguage(text, subject) {
  const normalized = normalizeSubject(subject);

  // No subject: the answer follows the student's language, nothing to enforce.
  if (!normalized) return [];

  const { outside } = extractMath(stripCode(text));
  const plain = outside.replace(ACRONYM_RE, " ");

  const devanagari = (plain.match(DEVANAGARI) || []).length;
  const latin = (plain.match(LATIN) || []).length;

  if (normalized === "hindi" || normalized === "sanskrit") {
    if (devanagari === 0) {
      return [`The answer must be written in ${normalized} (Devanagari).`];
    }
    if (latin > devanagari * 0.3) {
      return [`Too much English. Write the answer in ${normalized}.`];
    }
    return [];
  }

  if (devanagari > 0) {
    return ["The answer must be written in English only."];
  }

  return [];
}

/* -------------------------------------------------------------------------- */
/*                                Main validator                              */
/* -------------------------------------------------------------------------- */

/**
 * @returns {Promise<{ valid: boolean, issues: string[], text: string }>}
 *   `text` is the cleaned answer (also returned when invalid, so a repair
 *   request can show the model a tidy copy).
 */
export async function validateAskAnyQuestionAnswer({ answer, subject }) {
  const text = autoFixAnswer(answer);

  if (!text) {
    return { valid: false, issues: ["The answer is empty."], text: "" };
  }

  const issues = [
    ...validateLanguage(text, subject),
    ...(await validateLatex(text)),
  ].slice(0, MAX_ERRORS);

  return { valid: issues.length === 0, issues, text };
}