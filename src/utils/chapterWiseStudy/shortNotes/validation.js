import katex from "katex";

/**
 * A concept is { name, explanation: string[], formulas: string[], table: string }.
 *
 * Strict part (LaTeX only): deterministic fixes -> KaTeX check -> LLM repair
 * (done by the service) -> last resort: broken inline math becomes plain text
 * and a broken formula is dropped. Broken LaTeX never reaches the frontend.
 *
 * ctx = { isLanguage: boolean, devanagari: boolean }
 */

const INLINE_RE = /\$([^$\n]+?)\$/g;

// LaTeX-looking things that must never appear outside a math span.
// The "_" branch only matches a SINGLE-letter base (q_1, x_i, H_2), so snake_case
// words such as max_value are not flagged.
const STRAY_LATEX_RE =
  /\\[a-zA-Z]+|\\[()[\]]|(?<![A-Za-z])[A-Za-z0-9})]_[{A-Za-z0-9]|\^[{0-9A-Za-z-]|[₀-₉⁰¹²³⁴-⁹⁺⁻]/;

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

const SUB_DIGITS = "₀₁₂₃₄₅₆₇₈₉";
const SUPER_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** Unicode sub/superscripts -> ASCII, so "H₂" and "H_2" compare as equal. */
export function normalizeScripts(s) {
  return String(s ?? "")
    .replace(/[₀-₉⁰¹²³⁴-⁹]/g, (ch) => {
      const sub = SUB_DIGITS.indexOf(ch);
      if (sub >= 0) return String(sub);
      const sup = SUPER_DIGITS.indexOf(ch);
      return sup >= 0 ? String(sup) : ch;
    })
    .replace(/⁺/g, "+")
    .replace(/⁻/g, "-");
}

export const digitsOf = (s) => normalizeScripts(s).replace(/\D/g, "");

/* -------------------------------------------------------------------------- */
/*                          Deterministic cleaning                            */
/* -------------------------------------------------------------------------- */

/** JSON escape corruption: \frac -> <FF>rac, \times -> <TAB>imes, \beta -> <BS>eta ... */
function repairJsonEscapes(text) {
  return String(text ?? "")
    .replace(/\f(?=[a-zA-Z])/g, "\\f")
    .replace(/\t(?=[a-zA-Z])/g, "\\t")
    .replace(/\x08(?=[a-zA-Z])/g, "\\b")
    .replace(/\r(?=[a-zA-Z])/g, "\\r")
    .replace(/\v(?=[a-zA-Z])/g, "\\v")
    .replace(/\n(?=(?:eq|abla|ot|ewline|leq|geq|mid|ightarrow|u)\b)/g, "\\n")
    // Double-escaped commands: \\mathrm -> \mathrm, \\( -> \(
    .replace(/\\\\(?=[a-zA-Z]{2,}|[()[\]])/g, "\\");
}

/** Cleans TeX that is already inside a math span. */
function cleanTex(tex) {
  let v = tex;

  for (const [char, latex] of Object.entries(UNICODE_TO_LATEX)) {
    v = v.split(char).join(latex);
  }

  return v
    .replace(/\\(?:textbf|textit|textrm|text|mbox|ce)\s*\{/g, "\\mathrm{")
    .replace(/\\(?:qquad|quad)(?![a-zA-Z])/g, "\\,")
    .replace(/\\mathrm\{([^{}]*?)\s*\\times\s*([^{}]*?)\}/g, "\\mathrm{$1\\,$2}")
    .replace(/\s+/g, " ")
    .trim();
}

/** name / explanation line / table: text with inline $...$ math. */
function fixTextField(text, ctx, { multiline = false } = {}) {
  let s = repairJsonEscapes(text);

  if (ctx.isLanguage) s = s.replace(/\$/g, "");
  else {
    s = s
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => `$${t.trim()}$`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => `$${t.trim()}$`)
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => `$${t.trim().replace(/\n+/g, " ")}$`)
      .replace(INLINE_RE, (_, tex) => `$${cleanTex(tex)}$`);
  }

  if (multiline) {
    return s
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }

  return s.replace(/\s*\n+\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

/** formulas.N: raw LaTeX. The model sometimes adds delimiters anyway; strip them. */
function fixFormula(raw) {
  const s = repairJsonEscapes(raw)
    .trim()
    .replace(/^\s*(?:\$\$|\$|\\\[|\\\()\s*/, "")
    .replace(/\s*(?:\$\$|\$|\\\]|\\\))\s*$/, "");

  return cleanTex(s);
}

/** Applies every deterministic fix. Safe to run repeatedly. */
export function fixConcept(concept, ctx) {
  return {
    name: fixTextField(concept.name, ctx),
    explanation: concept.explanation
      .map((line) => fixTextField(line, ctx))
      .filter(Boolean),
    formulas: ctx.isLanguage
      ? []
      : concept.formulas.map(fixFormula).filter(Boolean),
    table: ctx.isLanguage
      ? ""
      : fixTextField(concept.table, ctx, { multiline: true }),
  };
}

/* -------------------------------------------------------------------------- */
/*                         Structural sanitizing (soft)                       */
/* -------------------------------------------------------------------------- */

const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * NON-THROWING. Returns a clean concept, or null when it has no name or no
 * explanation (it cannot be rendered then). Nothing else is rejected here.
 */
export function sanitizeConcept(raw, ctx) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const name =
    typeof raw.name === "string"
      ? raw.name.replace(/^\*+|\*+$/g, "").replace(/^#+\s*/, "").trim()
      : "";

  const explanation = (Array.isArray(raw.explanation) ? raw.explanation : [])
    .filter((line) => typeof line === "string")
    .flatMap((line) => line.split("\n"))
    .map((line) => line.replace(BULLET_RE, "").trim())
    .filter(Boolean);

  if (!name || !explanation.length) return null;

  return {
    name,
    explanation,
    formulas: ctx.isLanguage
      ? []
      : (Array.isArray(raw.formulas) ? raw.formulas : [])
          .filter((f) => typeof f === "string" && f.trim())
          .map((f) => f.trim()),
    table:
      !ctx.isLanguage && typeof raw.table === "string" ? raw.table.trim() : "",
  };
}

/* -------------------------------------------------------------------------- */
/*                                LaTeX checks                                */
/* -------------------------------------------------------------------------- */

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
    return `KaTeX failed on "${tex.slice(0, 80)}": ${String(error.message).slice(0, 120)}`;
  }
}

function findTextProblems(text) {
  if ((text.match(/\$/g) || []).length % 2 !== 0) {
    return ["Unbalanced $ delimiters."];
  }

  const problems = [];

  for (const match of text.matchAll(INLINE_RE)) {
    const problem = katexProblem(match[1].trim(), false);
    if (problem) problems.push(problem);
  }

  const outside = text.replace(INLINE_RE, " ");

  if (outside.includes("$")) problems.push("Stray or empty $ outside a math span.");
  if (STRAY_LATEX_RE.test(outside)) {
    problems.push(
      "Formula notation (LaTeX command, _ or ^, or a Unicode subscript) appears outside a $...$ span."
    );
  }

  return problems;
}

function findFormulaProblems(formula) {
  if (formula.includes("$")) return ["A formula must not contain $ delimiters."];

  const problem = katexProblem(formula, true);
  return problem ? [problem] : [];
}

/** Returns [{ path, text, error }] for every failing field. Language subjects have no math. */
export function collectConceptIssues(concept, ctx) {
  if (ctx.isLanguage) return [];

  const byPath = new Map();

  const add = (path, text, problems) => {
    if (!problems.length) return;
    byPath.set(path, { path, text, error: problems.join(" | ") });
  };

  add("name", concept.name, findTextProblems(concept.name));

  concept.explanation.forEach((line, i) => {
    add(`explanation.${i}`, line, findTextProblems(line));
  });

  if (concept.table) add("table", concept.table, findTextProblems(concept.table));

  concept.formulas.forEach((formula, i) => {
    add(`formulas.${i}`, formula, findFormulaProblems(formula));
  });

  return [...byPath.values()];
}

export function setConceptField(concept, path, value) {
  const [key, index] = path.split(".");

  if (index === undefined) {
    if (key === "name" || key === "table") concept[key] = value;
  } else if (
    (key === "explanation" || key === "formulas") &&
    Array.isArray(concept[key])
  ) {
    concept[key][Number(index)] = value;
  }
}

/* -------------------------------------------------------------------------- */
/*                         Last resort: degrade, never ship                    */
/* -------------------------------------------------------------------------- */

const plainFromTex = (tex) =>
  tex
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[{}\\^_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const stripStray = (part) =>
  normalizeScripts(part)
    .replace(/\$/g, "")
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[\\^_{}]/g, "");

function degradeText(text) {
  const withPlainSpans = text.replace(INLINE_RE, (full, tex) =>
    katexProblem(tex.trim(), false) ? plainFromTex(tex) : full
  );

  // even index = outside math, odd index = TeX of a (valid) span
  return withPlainSpans
    .split(INLINE_RE)
    .map((part, i) => (i % 2 === 0 ? stripStray(part) : `$${part}$`))
    .join("");
}

/**
 * Broken inline math becomes plain text (the concept stays). A formula that
 * still fails is dropped (its explanation stays).
 */
export function degradeConcept(concept) {
  return {
    name: degradeText(concept.name),
    explanation: concept.explanation.map(degradeText).filter(Boolean),
    formulas: concept.formulas.filter((f) => !findFormulaProblems(f).length),
    table: degradeText(concept.table),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Rendering                                 */
/* -------------------------------------------------------------------------- */

/**
 * Concept -> Markdown block:
 *
 *   **Concept Name**
 *   explanation line 1
 *   explanation line 2
 *
 *   | table | if any |
 *
 *   $$ formula $$
 */
export function renderConcept(concept) {
  const parts = [[`**${concept.name}**`, ...concept.explanation].join("\n")];

  if (concept.table) parts.push(concept.table);
  for (const formula of concept.formulas) parts.push(`$$ ${formula} $$`);

  return parts.join("\n\n");
}

/* -------------------------------------------------------------------------- */
/*                         Soft check (log only, never rejects)                */
/* -------------------------------------------------------------------------- */

export function languageWarning(concept, ctx) {
  const letters = [concept.name, ...concept.explanation]
    .join(" ")
    .match(/\p{L}/gu);

  if (!letters?.length) return null;

  const devanagari =
    letters.filter((ch) => /[\u0900-\u097F]/.test(ch)).length / letters.length;

  if (ctx.devanagari && devanagari < 0.7) {
    return `"${concept.name}": expected Devanagari text`;
  }
  if (!ctx.devanagari && devanagari > 0.1) {
    return `"${concept.name}": expected English text`;
  }
  return null;
}

export const conceptKey = (name) =>
  String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();