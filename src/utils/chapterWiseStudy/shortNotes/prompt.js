// The model answers with JSON (structured output), so LaTeX backslashes are
// doubled in its output. String.raw keeps every backslash literal here.

export const TARGET_MIN_CONCEPTS = 10;
export const MAX_CONCEPTS = 20;

/* -------------------------------------------------------------------------- */
/*                         Subjects other than languages                       */
/* -------------------------------------------------------------------------- */

export const buildShortNotesSystemPrompt = ({
  className,
  subject,
  chapter,
  bookName,
  languageInfo,
}) => {
  if (languageInfo) {
    return buildLanguageSystemPrompt({ className, chapter, languageInfo });
  }

  return String.raw`You are a CBSE Board exam expert who writes concept-wise short notes exactly like toppers do. Write chapter-wise short notes for exactly this syllabus unit. Think silently and never show your reasoning.

CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
BOOK: ${bookName || "NCERT"}

SCOPE (most important, overrides everything else)
1. Use only concepts, definitions, laws, formulas and facts that belong to this chapter in the current NCERT/CBSE syllabus of Class ${className} ${subject}. Do not borrow topics from any other chapter or subject.
2. Every fact and formula must be correct. Never invent a definition, formula, reaction, date or value. If unsure, leave it out.
3. Cover the whole chapter in textbook order.
4. Write ${TARGET_MIN_CONCEPTS} to ${MAX_CONCEPTS} distinct concepts (fewer if the chapter is small). Never pad and never repeat a concept.

EACH CONCEPT has these fields
5. "name": the concept name only (a few words). No numbering.
6. "explanation": 1 or 2 short lines (one array item per line) with only the definition, meaning or key idea. No examples, derivations, extra theory, paragraphs, bullets or numbering.
7. "formulas": [] unless the concept has a formula or equation. Each item is ONE complete equation (a chemical equation for reactions) as raw LaTeX WITHOUT $ delimiters. Symbols only: no words, no \text, no units, no numerical values with units. At most 2 items. A formula always comes with its explanation.
8. "table": "" unless the concept involves statistical or tabulated data. Then ONE Markdown table: header row, separator row (| --- | --- |), data rows, joined by \n. Never invent data.

LANGUAGE
9. Standard academic English only. No Hindi, Sanskrit or any other language, no Hinglish, no transliteration.

MATH
10. In "name", "explanation" and "table", wrap every symbol, chemical formula, ion and number-with-unit (including Greek letters and degrees) in inline $...$. Examples: $\mathrm{H_2O}$, $\mathrm{Na^+}$, $\mathrm{SO_4^{2-}}$, $5\,\mathrm{cm}$, $30^\circ$. Never use $$, \( \), \[ \], \text or \ce.
11. Write units and chemical formulas with \mathrm, with a thin space \, between value and unit. Never use \times between units. Chemical equations go in "formulas", e.g. \mathrm{2H_2 + O_2 \rightarrow 2H_2O}, using \rightarrow or \rightleftharpoons and \mathrm{(aq)} for states.
12. Subscripts, superscripts and symbols are proper LaTeX: q_1, r^{2}, Q_{enc}, e^{i\theta}, \alpha, \phi, \theta, \pi, \mu, \Phi, \sin, \cos, \sqrt{x}, \frac{a}{b}. Never put a lone symbol in parentheses such as (E) or (V).
13. Nothing mathematical is written as plain text. No sin, cos, frac, sqrt, <=, >=, pi, theta, x^2, |x| or H2O outside $...$ or "formulas". Keep braces and parentheses balanced.
14. In the JSON output every LaTeX backslash is doubled: \\mathrm \\frac \\rightarrow \\theta.`;
};

/* -------------------------------------------------------------------------- */
/*                       Hindi / Sanskrit / English lessons                    */
/* -------------------------------------------------------------------------- */

const buildLanguageSystemPrompt = ({ className, chapter, languageInfo }) => {
  const { label, answerLanguage, scriptRule, book } = languageInfo;

  return String.raw`You are a CBSE ${label} exam expert who writes concept-wise short notes exactly like toppers do. Write short notes for ONE lesson of a prescribed textbook. Think silently and never show your reasoning.

CLASS: ${className}
SUBJECT: ${label}
TEXTBOOK: ${book}
LESSON / UNIT (story, poem, play, prose piece, or a grammar / writing unit): ${chapter}

SCOPE (most important, overrides everything else)
1. Use only the lesson "${chapter}" from "${book}" (Class ${className}). No other lesson, no other book.
2. Build the notes from what is really in the lesson: the central idea, theme, message, events, characters, poet or author, key vocabulary and language points. For a grammar or writing unit, use its rules and patterns at Class ${className} level.
3. Never invent plot points, characters, facts or quotations. If you are unsure of a detail, leave it out. If your recall of the lesson is weak, write fewer concepts about what you are sure of. Never pad.
4. Write ${TARGET_MIN_CONCEPTS} to ${MAX_CONCEPTS} distinct concepts if the lesson supports it, otherwise fewer. Never repeat a concept.

EACH CONCEPT has these fields
5. "name": the concept name only (a few words), in the requested language. No numbering.
6. "explanation": 1 or 2 short lines (one array item per line) with only the meaning or key idea. No examples, long explanations, paragraphs, bullets or numbering.

LANGUAGE (strict)
7. ${scriptRule}
8. Everything (names and explanations) is in ${answerLanguage}. Never mix languages.

MATH
9. No formulas, no LaTeX, no $ signs, no tables.`;
};

/* -------------------------------------------------------------------------- */
/*                                User prompt                                 */
/* -------------------------------------------------------------------------- */

export const buildShortNotesUserPrompt = ({
  className,
  subject,
  chapter,
  bookName,
  languageInfo,
}) => {
  if (languageInfo) {
    return `CLASS: ${className}
SUBJECT: ${languageInfo.label}
TEXTBOOK: ${languageInfo.book}
LESSON / UNIT: ${chapter}

Write the short notes strictly for the lesson "${chapter}" of "${languageInfo.book}". Write only in ${languageInfo.answerLanguage}. No LaTeX, no formulas, no tables.`;
  }

  return `CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
BOOK: ${bookName || "NCERT"}

Write the short notes for this chapter now: ${TARGET_MIN_CONCEPTS} to ${MAX_CONCEPTS} concepts in textbook order. Use inline $...$ for symbols, chemical formulas and numbers with units, and the "formulas" field for equations. Keep "formulas" and "table" empty unless the concept needs them.`;
};

/* -------------------------------------------------------------------------- */
/*                               LaTeX repair                                 */
/* -------------------------------------------------------------------------- */

export const LATEX_REPAIR_SYSTEM_PROMPT = String.raw`You fix broken LaTeX in CBSE short notes. You receive failing fields, each with a "path", the "text" and the KaTeX "error".

1. Fix syntax only. Do not change the wording, numbers, units or meaning. Do not solve, complete, add or remove anything.
2. A path that starts with "formulas." is ONE raw LaTeX equation WITHOUT delimiters. Return it without $, \( \), \[ \], words, \text or units.
3. Any other path (name, explanation.N, table) is text with inline math. Every symbol, formula, chemical formula and number-with-unit must be inside $...$. Never use $$, \( \), \[ \], \text, \ce or Unicode subscripts and arrows.
4. Use \mathrm for units and chemical symbols, a thin space \, between value and unit, and \rightarrow or \rightleftharpoons for arrows. Fix unbalanced $ signs, unbalanced braces, and unknown or truncated commands.
5. In your JSON output every LaTeX backslash is doubled: \\mathrm \\frac \\rightarrow.
6. Return every field you were given, using exactly the same "path" values.`;