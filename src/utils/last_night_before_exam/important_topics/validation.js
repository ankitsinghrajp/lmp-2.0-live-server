import katex from "katex";

/**
 * The model now writes Markdown (not JSON), so there is no JSON backslash
 * corruption. Validation works on ONE topic block at a time:
 *
 *   ## Topic name
 *
 *   One or two sentences with $inline math$ where needed.
 *
 *   $$
 *   optional complete formula
 *   $$
 *
 * Fixable problems (bad LaTeX) are cleaned, then repaired by the LLM. The
 * display formula is optional: if it cannot be fixed it is dropped and the
 * topic stays. Only wrong-language / empty topics are rejected.
 */

// Hindi / Sanskrit content may contain a few incidental Latin letters.
const MAX_LATIN_RATIO = 0.1;
const MAX_FORMULA_LENGTH = 250;

const DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
const INLINE_RE = /\$([^$\n]+?)\$/g;

// LaTeX-looking things that must never appear outside a math span.
const STRAY_LATEX_RE =
  /\\[a-zA-Z]+|\\[()[\]]|[A-Za-z0-9})]_[{A-Za-z0-9]|\^[{0-9A-Za-z-]|[₀-₉⁰-⁹¹²³⁺⁻→⇌]/;

const FORBIDDEN_COMMANDS =
  /\\(?:begin|end|input|include|href|url|def|newcommand|renewcommand|write|catcode|text|mbox)(?![a-zA-Z])/;

export const digitsOf = (s) => String(s ?? "").replace(/\D/g, "");

export const hasDevanagari = (text = "") => /[\u0900-\u097F]/.test(text);

/** Unicode-safe duplicate key (keeps Devanagari letters and marks). */
export const normalizeTopicKey = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Looks at the language part of the subject only (text before the colon),
 * e.g. "Hindi: Kshitij Part 2". Returns "Hindi", "Sanskrit" or null.
 */
export function detectLanguage(subject = "") {
  const raw = String(subject ?? "").normalize("NFKC").toLowerCase();
  const prefix = raw.includes(":") ? raw.slice(0, raw.indexOf(":")) : raw;

  if (/\bsanskrit\b/.test(prefix)) return "Sanskrit";
  if (/\bhindi\b/.test(prefix)) return "Hindi";
  return null;
}

/* -------------------------------------------------------------------------- */
/*                          Deterministic cleaning                            */
/* -------------------------------------------------------------------------- */

// Trailing space avoids gluing a command to the next letter (e.g. \pir)
const UNICODE_TO_LATEX = {
  "°": "^{\\circ} ",
  "Δ": "\\Delta ",
  "→": "\\rightarrow ",
  "⇌": "\\rightleftharpoons ",
  "×": "\\times ",
  "÷": "\\div ",
  "·": "\\cdot ",
  "−": "-",
  "–": "-",
  "±": "\\pm ",
  "≈": "\\approx ",
  "≠": "\\neq ",
  "≤": "\\leq ",
  "≥": "\\geq ",
  "π": "\\pi ",
  "λ": "\\lambda ",
  "μ": "\\mu ",
  "µ": "\\mu ",
  "θ": "\\theta ",
  "α": "\\alpha ",
  "β": "\\beta ",
  "γ": "\\gamma ",
  "ρ": "\\rho ",
  "σ": "\\sigma ",
  "ω": "\\omega ",
  "ε": "\\epsilon ",
  "Ω": "\\Omega ",
};

const SUB_FROM = "₀₁₂₃₄₅₆₇₈₉₊₋";
const SUP_FROM = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻";
const PLAIN = "0123456789+-";

const mapRun = (run, from) =>
  [...run].map((ch) => PLAIN[from.indexOf(ch)]).join("");

/** Converts Unicode symbols to LaTeX. Use ONLY on text that is inside math. */
function unicodeToLatex(tex) {
  let v = tex;

  for (const [char, latex] of Object.entries(UNICODE_TO_LATEX)) {
    v = v.split(char).join(latex);
  }

  return v
    .replace(/[₀-₉₊₋]+/g, (run) => `_{${mapRun(run, SUB_FROM)}}`)
    .replace(/[⁰¹²³⁴-⁹⁺⁻]+/g, (run) => `^{${mapRun(run, SUP_FROM)}}`);
}

/** Returns a reason when a display formula can never be valid, else null. */
function getFormulaStructuralProblem(value) {
  if (value.length > MAX_FORMULA_LENGTH) return "Formula is too long.";
  if (FORBIDDEN_COMMANDS.test(value)) return "Formula has forbidden commands.";
  if (/\\\\/.test(value)) return "Formula has a line break.";
  if (!/[=+\-*/^_<>]|\\[a-zA-Z]+/.test(value)) {
    return "Formula does not look like a mathematical expression.";
  }
  return null;
}

const tidy = (s) => unicodeToLatex(s).replace(/\s+/g, " ").trim();

/**
 * Normalises one raw block into the canonical layout above.
 * Returns the cleaned Markdown block, or null if it has no heading or body.
 */
export function cleanBlock(raw, language) {
  let v = String(raw ?? "").replace(/\r\n?/g, "\n").trim();

  // Strip a code fence if the model wrapped the output in one.
  v = v.replace(/^```[a-z]*\n/i, "").replace(/\n```$/, "").trim();
  // Double-escaped commands: \\frac -> \frac
  v = v.replace(/\\\\(?=[a-zA-Z]{2,})/g, "\\");

  const match = v.match(/^##[ \t]+([^\n]+)\n([\s\S]*)$/);
  if (!match) return null;

  const name = match[1].replace(/[$*#]/g, "").replace(/\s+/g, " ").trim();
  let body = match[2];

  if (!name) return null;

  // Language subjects never contain math.
  if (language) {
    body = body.replace(/\$/g, "").replace(/\s+/g, " ").trim();
    return body ? `## ${name}\n\n${body}` : null;
  }

  // Only $...$ and $$...$$ are allowed: normalise \( \) and \[ \].
  body = body
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => `$$${t}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => `$${t}$`);

  // Pull the display formula(s) out, keep the first usable one.
  const displays = [];
  let text = body.replace(DISPLAY_RE, (_, tex) => {
    displays.push(tidy(tex));
    return " ";
  });

  text = text
    .replace(INLINE_RE, (_, tex) => `$${tidy(tex)}$`)
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;

  const formula = displays.find((f) => f && !getFormulaStructuralProblem(f));

  return formula
    ? `## ${name}\n\n${text}\n\n$$\n${formula}\n$$`
    : `## ${name}\n\n${text}`;
}

export const getBlockName = (block) =>
  (String(block).match(/^##[ \t]+([^\n]+)/)?.[1] ?? "").trim();

/** Removes the optional display formula (used when it cannot be repaired). */
export const dropDisplayFormula = (block) =>
  String(block).replace(DISPLAY_RE, "").replace(/\n{2,}$/g, "").trim();

/* -------------------------------------------------------------------------- */
/*                                  Checks                                    */
/* -------------------------------------------------------------------------- */

/** Wrong-language problems (not repairable). Returns a message or null. */
export function getHardProblem(block, language) {
  const prose = block.replace(DISPLAY_RE, " ").replace(INLINE_RE, " ");

  if (language) {
    if (!hasDevanagari(prose)) {
      return `${language} (Devanagari) text is missing.`;
    }

    const letters = prose.match(/\p{L}/gu) ?? [];
    const latin = letters.filter((ch) => /[A-Za-z]/.test(ch)).length;

    if (letters.length && latin / letters.length > MAX_LATIN_RATIO) {
      return `Too many English letters in ${language} content.`;
    }
    return null;
  }

  return hasDevanagari(prose)
    ? "Devanagari text found in English content."
    : null;
}

function katexProblem(tex, displayMode) {
  try {
    katex.renderToString(tex, {
      throwOnError: true,
      displayMode,
      strict: "ignore",
      trust: false,
    });
    return null;
  } catch (error) {
    return `KaTeX failed on "${tex}": ${error.message}`;
  }
}

/** Repairable (LaTeX) problems for one block. Returns a list of messages. */
export function collectBlockProblems(block, language) {
  if (language) return []; // language subjects have no math

  const problems = [];
  const withoutDisplay = block.replace(DISPLAY_RE, " ");

  for (const match of block.matchAll(DISPLAY_RE)) {
    const problem = katexProblem(match[1].trim(), true);
    if (problem) problems.push(problem);
  }

  if ((withoutDisplay.match(/\$/g) || []).length % 2 !== 0) {
    problems.push("Unbalanced $ delimiters.");
  } else {
    for (const match of withoutDisplay.matchAll(INLINE_RE)) {
      const problem = katexProblem(match[1].trim(), false);
      if (problem) problems.push(problem);
    }

    if (STRAY_LATEX_RE.test(withoutDisplay.replace(INLINE_RE, " "))) {
      problems.push(
        "Formula notation (LaTeX command, _ or ^, or a Unicode subscript/arrow) appears outside a $...$ or $$...$$ span."
      );
    }
  }

  return problems;
}