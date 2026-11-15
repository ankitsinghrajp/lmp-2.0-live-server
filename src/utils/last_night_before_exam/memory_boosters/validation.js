import katex from "katex";

/**
 * The model writes Markdown (not JSON), so there is no JSON backslash
 * corruption. Validation works on ONE booster block at a time:
 *
 *   ## Acronym | ## Story | ## Pattern
 *   content (several lines allowed)
 *
 * Bad LaTeX is cleaned, then repaired by the LLM, and finally degraded to
 * plain text. Only a wrong language, an empty or a wrongly sized block is
 * rejected.
 *
 * ctx = { isLanguage: boolean, devanagari: boolean }
 */

export const TYPE_ORDER = ["acronym", "story", "pattern"];
export const TITLES = { acronym: "Acronym", story: "Story", pattern: "Pattern" };

const MIN_LENGTH = 15;
const MAX_LENGTH = { acronym: 700, story: 1000, pattern: 900 };
const MAX_LATIN_RATIO = 0.1;

const INLINE_RE = /\$([^$\n]+?)\$/g;

// LaTeX-looking things that must never appear outside a math span.
const STRAY_LATEX_RE =
  /\\[a-zA-Z]+|\\[()[\]]|[A-Za-z0-9})]_[{A-Za-z0-9]|\^[{0-9A-Za-z-]|[₀-₉⁰-⁹⁺⁻]/;

export const digitsOf = (s) => String(s ?? "").replace(/\D/g, "");
export const hasDevanagari = (t = "") => /[\u0900-\u097F]/.test(t);

export const getBlockType = (block) => {
  const heading = String(block).match(/^##[ \t]+([^\n]+)/)?.[1] ?? "";
  return heading.toLowerCase().match(/acronym|story|pattern/)?.[0] ?? null;
};

export const getBlockName = (block) => getBlockType(block) ?? "unknown";

const bodyOf = (block) => String(block).replace(/^##[^\n]*\n?/, "");

/* -------------------------------------------------------------------------- */
/*                          Deterministic cleaning                            */
/* -------------------------------------------------------------------------- */

const UNICODE_TO_LATEX = {
  "°": "^{\\circ} ",
  "→": "\\rightarrow ",
  "⇌": "\\rightleftharpoons ",
  "×": "\\times ",
  "÷": "\\div ",
  "·": "\\cdot ",
  "−": "-",
  "±": "\\pm ",
  "π": "\\pi ",
  "λ": "\\lambda ",
  "μ": "\\mu ",
  "µ": "\\mu ",
  "θ": "\\theta ",
  "α": "\\alpha ",
  "β": "\\beta ",
  "Δ": "\\Delta ",
  "Ω": "\\Omega ",
  "²": "^{2}",
  "³": "^{3}",
};

/** Cleans TeX that is already inside $...$ (Unicode only converted here). */
function cleanTex(tex) {
  let v = tex;

  for (const [char, latex] of Object.entries(UNICODE_TO_LATEX)) {
    v = v.split(char).join(latex);
  }

  return v
    .replace(/\\(?:textbf|textit|textrm|text|mbox)\s*\{/g, "\\mathrm{")
    .replace(/\\(?:qquad|quad)(?![a-zA-Z])/g, "\\,")
    .replace(/\\mathrm\{([^{}]*?)\s*\\times\s*([^{}]*?)\}/g, "\\mathrm{$1\\,$2}")
    .replace(/\s+/g, " ")
    .trim();
}

function fixMath(body) {
  return body
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => `$${t.trim()}$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => `$${t.trim()}$`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => `$${t.trim().replace(/\n+/g, " ")}$`)
    .replace(INLINE_RE, (_, tex) => `$${cleanTex(tex)}$`);
}

/**
 * Normalises one raw block into the canonical layout.
 * Returns the cleaned block, or null if it has no valid heading or body.
 */
export function cleanBlock(raw, ctx) {
  let v = String(raw ?? "").replace(/\r\n?/g, "\n").trim();

  v = v.replace(/^```[a-z]*\n/i, "").replace(/\n```$/, "").trim();
  // Double-escaped commands: \\frac -> \frac
  v = v.replace(/\\\\(?=[a-zA-Z]{2,})/g, "\\");

  const match = v.match(/^##[ \t]+([^\n]+)\n([\s\S]*)$/);
  if (!match) return null;

  const type = getBlockType(v);
  if (!type) return null;

  let body = ctx.isLanguage ? match[2].replace(/\$/g, "") : fixMath(match[2]);

  body = body
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return body ? `## ${TITLES[type]}\n${body}` : null;
}

/* -------------------------------------------------------------------------- */
/*                                  Checks                                    */
/* -------------------------------------------------------------------------- */

/** Wrong-language / size problems (not repairable). Returns a message or null. */
export function getHardProblem(block, ctx) {
  const type = getBlockType(block);
  const body = bodyOf(block);
  const prose = body.replace(INLINE_RE, " ");

  if (body.length < MIN_LENGTH) return `${type}: content is too short.`;
  if (body.length > MAX_LENGTH[type]) {
    return `${type}: content is too long (max ${MAX_LENGTH[type]} characters).`;
  }

  if (ctx.devanagari) {
    if (!hasDevanagari(prose)) return `${type}: Devanagari text is missing.`;

    const letters = prose.match(/\p{L}/gu) ?? [];
    const latin = letters.filter((ch) => /[A-Za-z]/.test(ch)).length;

    if (letters.length && latin / letters.length > MAX_LATIN_RATIO) {
      return `${type}: too many English letters in the content.`;
    }
    return null;
  }

  return hasDevanagari(prose) ? `${type}: Devanagari text found in English content.` : null;
}

function katexProblem(tex) {
  try {
    katex.renderToString(tex, {
      throwOnError: true,
      displayMode: false,
      strict: "ignore",
      trust: false,
    });
    return null;
  } catch (error) {
    return `KaTeX failed on "${tex.slice(0, 80)}": ${String(error.message).slice(0, 120)}`;
  }
}

/** Repairable (LaTeX) problems for one block. Returns a list of messages. */
export function collectBlockProblems(block, ctx) {
  if (ctx.isLanguage) return []; // language subjects have no math

  const body = bodyOf(block);
  const problems = [];

  if ((body.match(/\$/g) || []).length % 2 !== 0) {
    problems.push("Unbalanced $ delimiters.");
    return problems;
  }

  for (const match of body.matchAll(INLINE_RE)) {
    const problem = katexProblem(match[1].trim());
    if (problem) problems.push(problem);
  }

  const outside = body.replace(INLINE_RE, " ");

  if (outside.includes("$")) problems.push("Stray $ outside a math span.");
  if (STRAY_LATEX_RE.test(outside)) {
    problems.push(
      "Formula notation (LaTeX command, _ or ^, or a Unicode subscript) appears outside a $...$ span."
    );
  }

  return problems;
}

/**
 * Last resort: turn every still-broken math span into plain text and drop
 * stray "$". The booster stays, only the broken formula loses its styling.
 */
export function degradeBrokenMath(block) {
  const heading = String(block).match(/^##[^\n]*/)?.[0] ?? "";
  let body = bodyOf(block);

  body = body.replace(INLINE_RE, (full, tex) =>
    katexProblem(tex.trim())
      ? tex.replace(/\\[a-zA-Z]+/g, "").replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim()
      : full
  );

  const parts = body.split(INLINE_RE); // even = outside math, odd = tex
  body = parts.map((p, i) => (i % 2 === 0 ? p.replace(/\$/g, "") : `$${p}$`)).join("");

  return `${heading}\n${body.trim()}`;
}