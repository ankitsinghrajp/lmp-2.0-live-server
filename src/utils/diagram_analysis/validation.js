/**
 * Diagram explanation checks.
 *
 *  - NO limits on word count, line count or wording.
 *  - Free, deterministic fixes run first (bullets, fences, math delimiters).
 *  - LaTeX stays strict. If the optional `katex` package is installed,
 *    every formula is also render-tested.
 *  - The caller rewrites the answer only when something is still wrong.
 */

const DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
const INLINE_RE = /\$(?!\$)([^\n$]+?)\$(?!\$)/g;

const DEVANAGARI = /[\u0900-\u097F]/g;
const LATIN = /[A-Za-z]/g;

const MAX_ERRORS = 8;

/* -------------------------------------------------------------------------- */
/*                         Free, deterministic repairs                        */
/* -------------------------------------------------------------------------- */

const countDisplayMarks = (line) => (line.match(/\$\$/g) || []).length;

export function autoFixExplanation(input) {
  if (typeof input !== "string") return "";

  let text = input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    // code fences around the whole answer
    .replace(/^\s*```[a-zA-Z]*\n?/, "")
    .replace(/\n?```\s*$/, "")
    // over-escaped commands: \\frac -> \frac
    .replace(/\\\\(?=[a-zA-Z]{2,})/g, "\\")
    // \( x \) -> $x$   and   \[ x \] -> $$x$$
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, inner) => `$${inner.trim()}$`)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, inner) => `$$${inner.trim()}$$`);

  // Make every line a "- " bullet (lines inside a $$ block stay untouched).
  const out = [];
  let inDisplay = false;

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();

    if (inDisplay) {
      out.push(line);
      if (countDisplayMarks(line) % 2 === 1) inDisplay = false;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    const body = trimmed
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-*•–—]|\d+[.)])\s+/, "");

    out.push(`- ${body}`);
    if (countDisplayMarks(body) % 2 === 1) inDisplay = true;
  }

  return out.join("\n").trim();
}

/* -------------------------------------------------------------------------- */
/*                              Math extraction                               */
/* -------------------------------------------------------------------------- */

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

  if (/\\\(|\\\)|\\\[|\\\]/.test(text)) {
    issues.push("Use only $...$ and $$...$$ delimiters.");
  }

  const { display, inline, outside, withoutDisplay } = extractMath(text);

  if (withoutDisplay.includes("$$")) {
    issues.push("Unclosed display math delimiter ($$).");
  }

  if (outside.replace(/\$\$/g, "").includes("$")) {
    issues.push(
      "Unclosed or stray $ sign. Every $ needs a closing $ and currency must not use $."
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
  const normalized = String(subject ?? "English").toLowerCase().trim();
  const { outside } = extractMath(text);

  const devanagari = (outside.match(DEVANAGARI) || []).length;
  const latin = (outside.match(LATIN) || []).length;

  if (normalized === "hindi" || normalized === "sanskrit") {
    if (devanagari === 0) {
      return [`The explanation must be written in ${normalized} (Devanagari).`];
    }
    if (latin > devanagari * 0.3) {
      return [`Too much English. Write the explanation in ${normalized}.`];
    }
    return [];
  }

  if (devanagari > 0) {
    return ["The explanation must be written in English only."];
  }

  return [];
}

/* -------------------------------------------------------------------------- */
/*                                Main validator                              */
/* -------------------------------------------------------------------------- */

/**
 * @returns {Promise<{ valid: boolean, errors: string[], text: string }>}
 *   `text` is the cleaned explanation (also returned when invalid, so a
 *   repair request can show the model a tidy copy).
 */
export const validateDiagramExplanation = async ({ aiResponse, subject }) => {
  const text = autoFixExplanation(aiResponse);

  if (!text) {
    return { valid: false, errors: ["The explanation is empty."], text: "" };
  }

  const errors = [
    ...validateLanguage(text, subject),
    ...(await validateLatex(text)),
  ].slice(0, MAX_ERRORS);

  return { valid: errors.length === 0, errors, text };
};