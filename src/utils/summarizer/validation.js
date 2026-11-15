import katex from "katex";

/**
 * Summary checks.
 *
 *  - NO limits on length, line count or wording.
 *  - Free, deterministic fixes run first (delimiters, \text, unicode symbols,
 *    bold inside math, degrees, table spacing).
 *  - LaTeX stays strict: every formula is render-tested with KaTeX.
 *  - The caller rewrites the answer only when something is still wrong.
 */

const MATH_RE = /\$\$[\s\S]+?\$\$|\$(?!\$)[^\n$]+?\$(?!\$)/g;
const DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
const INLINE_RE = /\$(?!\$)([^\n$]+?)\$(?!\$)/g;

const MAX_ERRORS = 8;

// Unicode / plain-text notation that must be LaTeX instead.
const STRAY_NOTATION_RE = /[₀-₉⁰-⁹⁺⁻→⇌×÷°]/;
const PLAIN_MATH_RE = /<=|>=|\bsqrt\s*\(/i;

const isTableLine = (line) => /^\s*\|.*\|\s*$/.test(line);

/* -------------------------------------------------------------------------- */
/*                         Free, deterministic repairs                        */
/* -------------------------------------------------------------------------- */

function mapOutsideMath(text, fn) {
  let out = "";
  let last = 0;

  for (const match of text.matchAll(MATH_RE)) {
    out += fn(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }

  return out + fn(text.slice(last));
}

function cleanMath(tex, isDisplay) {
  let t = tex
    .replace(/\*\*/g, "") // Markdown never belongs inside math
    .replace(/(\d)\s*°/g, "$1^\\circ")
    .replace(/°/g, "^\\circ")
    .replace(/×/g, "\\times ")
    .replace(/÷/g, "\\div ")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/→/g, "\\rightarrow ")
    .replace(/⇌/g, "\\rightleftharpoons ")
    .replace(/[μµ]/g, "\\mu ")
    // \text is not allowed; \mathrm is the house style
    .replace(/\\(?:text|textbf|textit|mbox)\s*\{/g, "\\mathrm{")
    // unit products: \mathrm{C \times m} -> \mathrm{C\,m}
    .replace(/\\mathrm\{([^{}]*?)\s*\\times\s*([^{}]*?)\}/g, "\\mathrm{$1\\,$2}")
    .trim();

  // A blank line inside a display block would cut it into two paragraphs.
  if (isDisplay) t = t.replace(/\n[ \t]*\n+/g, "\n");

  return t;
}

/** Puts a blank line before and after every Markdown table. */
function normalizeTables(text) {
  const lines = text.split("\n");
  const out = [];

  lines.forEach((line, i) => {
    if (i > 0) {
      const prev = lines[i - 1];
      const entering = isTableLine(line) && !isTableLine(prev);
      const leaving = !isTableLine(line) && isTableLine(prev);

      if ((entering || leaving) && prev.trim() !== "" && line.trim() !== "") {
        out.push("");
      }
    }
    out.push(line);
  });

  return out.join("\n");
}

export function autoFixSummary(input) {
  if (typeof input !== "string") return "";

  let s = input
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
    // $**x**$ -> **$x$**  (bold goes outside the math)
    .replace(/\$\*\*([^$\n]+?)\*\*\$/g, (_, tex) => `**$${tex.trim()}$**`);

  // Clean every math span.
  s = s.replace(MATH_RE, (full) =>
    full.startsWith("$$")
      ? `$$${cleanMath(full.slice(2, -2), true)}$$`
      : `$${cleanMath(full.slice(1, -1), false)}$`
  );

  // Degrees written as plain text: 30° -> $30^\circ$, 25°C -> $25^\circ\mathrm{C}$
  s = mapOutsideMath(s, (part) =>
    part.replace(
      /(\d+(?:\.\d+)?)\s*°\s*([CF])?/g,
      (_, num, unit) => `$${num}^\\circ${unit ? `\\mathrm{${unit}}` : ""}$`
    )
  );

  s = normalizeTables(s);

  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/* -------------------------------------------------------------------------- */
/*                              Math extraction                               */
/* -------------------------------------------------------------------------- */

// Code must not be mistaken for broken LaTeX.
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
/*                              LaTeX rules (strict)                          */
/* -------------------------------------------------------------------------- */

function validateLatex(text) {
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

  if (STRAY_NOTATION_RE.test(outside)) {
    issues.push(
      "A symbol such as \u00D7, \u00B0, \u2192 or a Unicode subscript/superscript appears outside math. Write it in LaTeX inside $...$."
    );
  }

  if (PLAIN_MATH_RE.test(outside)) {
    issues.push(
      "Plain-text math (such as sqrt( or <=) appears outside math. Write it in LaTeX inside $...$."
    );
  }

  const segments = [
    ...display.map((source) => ({ source, displayMode: true })),
    ...inline.map((source) => ({ source, displayMode: false })),
  ];

  for (const { source, displayMode } of segments) {
    const preview = source.trim().slice(0, 40);

    if (!source.trim()) {
      issues.push("Empty math expression.");
      continue;
    }

    if (/\\ce\b/.test(source)) {
      issues.push(`Math "${preview}": \\ce is not allowed, use \\mathrm{...}.`);
    }

    if (!bracesBalanced(source)) {
      issues.push(`Math "${preview}": unbalanced { } braces.`);
      continue;
    }

    try {
      katex.renderToString(source, {
        throwOnError: true,
        displayMode,
        strict: "ignore",
        trust: false,
      });
    } catch (error) {
      const reason = String(error?.message ?? "invalid math")
        .replace(/^KaTeX parse error:\s*/i, "")
        .split("\n")[0]
        .slice(0, 100);
      issues.push(`Math "${preview}" does not render: ${reason}`);
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*                              Table rule                                    */
/* -------------------------------------------------------------------------- */

function validateTables(text) {
  const issues = [];
  const lines = stripCode(text).split("\n");
  const pipes = (line) => (line.replace(MATH_RE, "x").match(/\|/g) || []).length;

  let i = 0;
  while (i < lines.length) {
    if (!isTableLine(lines[i])) {
      i += 1;
      continue;
    }

    const table = [];
    while (i < lines.length && isTableLine(lines[i])) {
      table.push(lines[i]);
      i += 1;
    }

    const isSeparator = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(
      (table[1] ?? "").trim()
    );

    if (table.length < 2 || !isSeparator) {
      issues.push(
        "A Markdown table needs a header row followed by a separator row such as | --- | --- |."
      );
    } else if (table.some((line) => pipes(line) !== pipes(table[0]))) {
      issues.push("Every table row must have the same number of columns.");
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*                                Main validator                              */
/* -------------------------------------------------------------------------- */

/**
 * @returns {{ valid: boolean, issues: string[], text: string }}
 *   `text` is the cleaned summary (also returned when invalid, so a repair
 *   request can show the model a tidy copy).
 */
export function validateSummary({ summary }) {
  const text = autoFixSummary(summary);

  if (!text) {
    return { valid: false, issues: ["The answer is empty."], text: "" };
  }

  const issues = [...validateLatex(text), ...validateTables(text)].slice(0, MAX_ERRORS);

  return { valid: issues.length === 0, issues, text };
}