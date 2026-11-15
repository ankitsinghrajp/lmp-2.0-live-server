import katex from "katex";

const MIN_ACTION_LENGTH = 15;
const MAX_ACTION_LENGTH = 400;
const MAX_FORMULA_LENGTH = 250;
const LATIN_LIMIT = 0.15; // max share of Roman letters in Hindi/Sanskrit actions
const SIMILARITY_LIMIT = 0.8;

// Inline math only: $...$
const MATH_RE = /\$([^$\n]+?)\$/g;
const FORMULA_LINE_RE = /^\s*formula\s*[:：]\s*(.*)$/i;

const VAGUE_RE =
  /^\s*(?:study (?:well|hard)|read the (?:chapter|lesson)|revise everything|practice well)\b/i;

const hasDevanagari = (t) => /[\u0900-\u097F]/.test(t);
const hasLatin = (t) => /[a-zA-Z]/.test(t);

const latinRatio = (t) => {
  const latin = (t.match(/[a-zA-Z]/g) || []).length;
  const deva = (t.match(/[\u0900-\u097F]/g) || []).length;
  return latin + deva ? latin / (latin + deva) : 0;
};

/* -------------------------------------------------------------------------- */
/*                                 Sanitizers                                 */
/* -------------------------------------------------------------------------- */

const cleanMath = (tex) =>
  tex
    .replace(/\\(?:textbf|textit|textrm|text|mbox)\s*\{/g, "\\mathrm{")
    .replace(/\\ce\s*\{/g, "\\mathrm{")
    .replace(/\\degree(?![a-zA-Z])/g, "^\\circ")
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
    .replace(
      /\\mathrm\{([^{}]*?)\s*\\times\s*([^{}]*?)\}/g,
      "\\mathrm{$1\\,$2}"
    );

// Markdown the model sometimes adds even though the prompt forbids it.
const stripMarkdown = (text) =>
  text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1");

// Double-escaped commands (\\frac -> \frac) can still happen in plain text.
const fixDoubleEscapes = (text) =>
  text.replace(/\\\\(?=[a-zA-Z]{2,}|[()[\]])/g, "\\");

const oneLine = (s) =>
  s
    .replace(/\s*\n+\s*/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

const renderError = (tex) => {
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
};

// A broken math span becomes readable plain text instead of failing the step.
const degradeMath = (tex) =>
  tex
    .replace(/\\(?:mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:cdot|times)(?![a-zA-Z])/g, "×")
    .replace(/\\rightarrow(?![a-zA-Z])/g, "→")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function fixMathText(text) {
  let s = stripMarkdown(fixDoubleEscapes(String(text ?? "")));

  // \( \), \[ \] and $$ $$ -> inline $ $
  s = s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => "$" + t.trim() + "$")
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => "$" + t.trim() + "$")
    .replace(
      /\$\$([\s\S]+?)\$\$/g,
      (_, t) => "$" + t.trim().replace(/\n+/g, " ") + "$"
    );

  s = oneLine(s);

  const degraded = [];

  s = s.replace(MATH_RE, (_, raw) => {
    const tex = cleanMath(raw.trim());

    if (!renderError(tex)) return "$" + tex + "$";

    degraded.push(tex);
    return degradeMath(tex);
  });

  return { text: s, degraded };
}

// Language subjects: no math at all. For Hindi/Sanskrit also drop Roman
// glosses in brackets, e.g. "कवि (Poet)" -> "कवि".
function fixLanguageText(text, devanagari) {
  let s = stripMarkdown(String(text ?? "")).replace(/\$/g, "");

  if (devanagari) {
    s = s.replace(/\s*\([^()]*[A-Za-z][^()]*\)/g, "");
  }

  return oneLine(s);
}

function sanitizeFormula(raw) {
  const v = fixDoubleEscapes(String(raw ?? ""))
    .replace(/\r?\n+/g, " ")
    .trim()
    .replace(/^\$\$([\s\S]*)\$\$$/, "$1")
    .replace(/^\$([\s\S]*)\$$/, "$1")
    .replace(/^\\\(([\s\S]*)\\\)$/, "$1")
    .replace(/^\\\[([\s\S]*)\\\]$/, "$1")
    .replace(/\$/g, "");

  return cleanMath(v).replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------------------------- */
/*                               Block validation                             */
/* -------------------------------------------------------------------------- */

/** Splits a block body into action text and the optional "Formula:" line. */
function parseBlock(block) {
  const actionLines = [];
  let formula = "";

  for (const line of block.split("\n")) {
    const match = line.match(FORMULA_LINE_RE);

    if (match) {
      if (!formula) formula = match[1];
    } else {
      actionLines.push(line);
    }
  }

  return { action: actionLines.join("\n"), formula };
}

/**
 * Validates one streamed block.
 *
 * ctx: { languageKey, devanagari }
 * Returns { step: { action, formula }, warnings } or { error, warnings }.
 * Nothing here throws.
 */
export function validateCoachStep(block, ctx = {}) {
  const { languageKey = null, devanagari = false } = ctx;
  const warnings = [];

  const parsed = parseBlock(block);

  let action;

  if (languageKey) {
    action = fixLanguageText(parsed.action, devanagari);
  } else {
    const fixed = fixMathText(parsed.action);
    action = fixed.text;

    if (fixed.degraded.length) {
      warnings.push(
        `${fixed.degraded.length} broken math span(s) in action turned into plain text.`
      );
    }

    const outside = action.replace(MATH_RE, " ");

    if (outside.includes("$")) {
      return { error: "Unbalanced $ delimiter in action.", warnings };
    }

    if (/\\[a-zA-Z]+/.test(outside)) {
      return { error: "LaTeX command found outside $...$ in action.", warnings };
    }
  }

  if (!action) return { error: "Missing action.", warnings };

  if (action.length < MIN_ACTION_LENGTH) {
    return { error: "Action is too short.", warnings };
  }

  if (action.length > MAX_ACTION_LENGTH) {
    return {
      error: `Action is too long (max ${MAX_ACTION_LENGTH} characters).`,
      warnings,
    };
  }

  if (VAGUE_RE.test(action)) warnings.push("Action looks vague.");

  // Script checks
  if (devanagari) {
    if (latinRatio(action) > LATIN_LIMIT) {
      return {
        error: `Too much English/Roman text in ${languageKey} action. Use Devanagari only.`,
        warnings,
      };
    }

    if (!hasDevanagari(action)) {
      return { error: "Devanagari text is missing.", warnings };
    }

    if (hasLatin(action)) {
      warnings.push(`A few Roman letters found in ${languageKey} action.`);
    }
  } else if (hasDevanagari(action)) {
    return { error: "Devanagari text found in English action.", warnings };
  }

  // Formula: optional, dropped (never fails the step) if unusable.
  let formula = languageKey ? "" : sanitizeFormula(parsed.formula);

  if (formula) {
    let problem = null;

    if (formula.length > MAX_FORMULA_LENGTH) problem = "Formula is too long.";
    else if (/[^\x20-\x7E]/.test(formula)) {
      problem = "Formula has non-ASCII characters.";
    } else problem = renderError(formula);

    if (problem) {
      warnings.push(`${problem} Formula was dropped.`);
      formula = "";
    }
  }

  return { step: { action, formula }, warnings };
}

/* -------------------------------------------------------------------------- */
/*                              Duplicate tracking                            */
/* -------------------------------------------------------------------------- */

const normKey = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenSet = (s) =>
  new Set(
    normKey(s)
      .split(" ")
      .filter((w) => w.length > 1)
  );

const similarity = (a, b) => {
  if (!a.size || !b.size) return 0;

  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;

  return shared / (a.size + b.size - shared);
};

/** register(text) is true when the text is new, false for an exact or near duplicate. */
export function createStepTracker() {
  const keys = new Set();
  const tokenSets = [];

  return {
    register(text) {
      const key = normKey(text);
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