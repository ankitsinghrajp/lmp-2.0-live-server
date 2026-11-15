import { MAX_PYQS, MIN_PYQS } from "./shared.js";

/* -------------------------------------------------------------------------- */
/*                              Language handling                             */
/* -------------------------------------------------------------------------- */

/**
 * Returns "Hindi", "Sanskrit" or null. Only the part of the subject before
 * ":" is checked (e.g. "Hindi: Kshitij Part 2"), so a chapter title can never
 * trigger it. Every other subject (including English) returns null.
 */
export function detectLanguage(subject) {
  const prefix = String(subject ?? "")
    .normalize("NFKC")
    .split(":")[0]
    .toLowerCase();

  if (/\bsanskrit\b/.test(prefix)) return "Sanskrit";
  if (/\bhindi\b/.test(prefix)) return "Hindi";

  return null;
}

const ENGLISH_BLOCK = `LANGUAGE (strict)
- Write every question in standard academic English only.
- Never use Hindi, Sanskrit or any regional language, Hinglish, or transliteration.`;

const LANGUAGE_BLOCKS = {
  Hindi: `LANGUAGE (strict)
- Write every question entirely in pure, standard Hindi (Devanagari), in formal CBSE/NCERT academic Hindi.
- No Sanskrit sentence structure, no English words, no Roman-script (transliterated) words.
- Never mix languages inside a question.`,
  Sanskrit: `LANGUAGE (strict)
- Write every question entirely in pure classical Sanskrit (Devanagari), with correct grammar, vocabulary, vibhakti and verb forms.
- No Hindi words or Hindi sentence structure, no English words, no Roman-script (transliterated) words.
- Never mix languages inside a question.`,
};

/* -------------------------------------------------------------------------- */
/*                               Format blocks                                */
/* -------------------------------------------------------------------------- */

const STRUCTURE_BLOCK = String.raw`QUESTION STRUCTURE
- Each question is ONE self-contained string. No one-line vague questions: give every value, option and table row the question needs.
- Multi-part questions: put (a), (b), (c) each on its own line, joined by \n.
- Multiple-choice questions: the stem on the first line, then (A) (B) (C) (D) each on its own line, joined by \n.
- Real line breaks inside the string are written as \n.`;

const DIAGRAM_BLOCK = `DIAGRAM (the "diagram" key)
- If a question contains or needs a diagram or figure (geometry figure, circuit, ray diagram, graph, map, labelled biology/chemistry apparatus, etc.), set "diagram" to a plain-text description of that diagram, e.g. "Triangle ABC with side AB = 20 cm, side BC = 45 cm and angle B = 90 degrees".
- The description must name every shape, label, point, value and unit needed to draw the diagram. Plain text only: no LaTeX, no \\( \\), no $, no Markdown.
- The description must follow the language rules above (same language as the question).
- The question itself must still be complete and solvable on its own; the diagram text only describes the figure.
- If the question has no diagram, set "diagram" to an empty string "". Never invent a diagram for a question that does not need one.`;

const MATH_FORMAT_BLOCK = String.raw`FORMAT (math and notation)
- Wrap every formula, equation, symbol, chemical formula and number-with-unit (Greek letters and degrees included) as \( ... \) inline or \[ ... \] display. Never use $ or $$, \text or \ce. Never leave notation such as \mathrm, \rightarrow, _ or ^ outside \( \).
- Units: \mathrm with a thin space \, between value and unit and between units. Never use \times between units.
- Chemistry: one math span per reaction, e.g. \(\mathrm{2H_2 + O_2 \rightarrow 2H_2O}\). Use \rightarrow, \rightleftharpoons, \mathrm{(aq)}. Formulas such as H2O in plain text are forbidden.
- Logic and sets: \neg, \Rightarrow, \Leftrightarrow, \in, \subset ... inside \( \) only, never as plain words.
- In the JSON output every LaTeX backslash is doubled: \\( \\mathrm \\theta \\frac \\rightarrow.
- Tables (statistics, data questions): a Markdown table inside the question string with a header row, a separator row (| --- | --- |) and one row per line, joined by \n. Every cell must be filled. Give an unknown value its own name such as \(k\), \(p\) or \(f_1\) and say which one is unknown. Never use a bare \(f\) as both the row label and the unknown. Ungrouped data must be given as a complete frequency table. Use class intervals like 0-10, 10-20.`;

const INDIC_FORMAT_BLOCK = String.raw`FORMAT (language subject)
- This is a language subject: no LaTeX, no \( \), no $ and no math notation.
- A table, if one is truly needed, is a Markdown table inside the question string with a header row, a separator row (| --- | --- |) and one row per line, joined by \n.`;

/* -------------------------------------------------------------------------- */
/*                                   Prompts                                  */
/* -------------------------------------------------------------------------- */

export function buildPyqSystemPrompt({
  requestedClass,
  subject,
  bookName,
  chapter,
  year,
  language,
}) {
  const bookLine = bookName ? `\nBOOK: ${bookName}` : "";
  const languageBlock = language ? LANGUAGE_BLOCKS[language] : ENGLISH_BLOCK;
  const formatBlock = language ? INDIC_FORMAT_BLOCK : MATH_FORMAT_BLOCK;

  return String.raw`You are a CBSE Previous Year Question (PYQ) expert. Build the question set for exactly this paper unit:

CLASS: ${requestedClass}
SUBJECT: ${subject}${bookLine}
CHAPTER: ${chapter}
YEAR: ${year}

SCOPE (most important, overrides everything else)
1. Every question must belong to the chapter "${chapter}" of Class ${requestedClass} ${subject}, at the level of that class and within the current NCERT/CBSE syllabus. Never use topics from other chapters, classes or subjects.
2. Questions only: no answers, solutions, hints, marking schemes or claims about exam appearance.

YOUR TASK
3. The user message may contain RETRIEVED PYQS: questions of the ${year} paper that were extracted automatically. They can be half-written, cut off, missing data, options or table rows, or have broken notation or formatting. Ignore any item that does not belong to this class, subject and chapter.
4. For every retrieved question that belongs here:
   - If it is complete and correct, keep its meaning and marks and only rewrite it in the format below.
   - If it is half-written, cut off, missing data or options, or has a broken table or broken notation, FIX it: return one complete, solvable, exam-ready question with the same concept, difficulty and marks. Where data is missing, supply realistic CBSE-style data. Never return an incomplete question.
   - If it cannot be turned into a meaningful question for this chapter, skip it.
   Mark all of these with origin "retrieved". Never merge two retrieved questions, and never change the topic when fixing one.
5. Return between ${MIN_PYQS} and ${MAX_PYQS} questions in total. List the kept and fixed retrieved questions first. If they give fewer than ${MIN_PYQS}, GENERATE new questions yourself for this class, subject, chapter and year ${year} until there are at least ${MIN_PYQS} (origin "generated"). If nothing was retrieved, generate the whole set.
6. Generated questions must be what the CBSE paper-setter for ${year} would most likely ask on this chapter: follow paper trends, NCERT emphasis, weightage and the usual mix of 1, 2, 3, 4, 5 and 6 mark questions. No timeless generic questions.
7. STYLE REFERENCE items come from OTHER years. Use them only to see which concepts, question styles and marks recur. Never return or copy them.
8. No duplicate or near-duplicate questions.
9. If the user message lists ALREADY ACCEPTED questions, never repeat or rephrase them, and return only the number of NEW questions it asks for (origin "generated").
10. "marks" is an integer from 1 to 6. Keep the marks of a retrieved question; for a generated question use the CBSE marks pattern for this chapter.

${languageBlock}

${STRUCTURE_BLOCK}

${DIAGRAM_BLOCK}

${formatBlock}

OUTPUT
- Return only the JSON object required by the schema. No explanations.`;
}

const bookLineOf = (bookName) => (bookName ? `\nBOOK: ${bookName}` : "");

export function buildPyqUserPrompt({
  requestedClass,
  subject,
  bookName,
  chapter,
  year,
  evidence,
  styleReference,
}) {
  const evidenceBlock = evidence.length
    ? JSON.stringify(evidence)
    : "NONE (no previous-year questions were retrieved for this year)";

  const styleBlock = styleReference.length
    ? JSON.stringify(styleReference)
    : "NONE";

  return `CLASS: ${requestedClass}
SUBJECT: ${subject}${bookLineOf(bookName)}
CHAPTER: ${chapter}
YEAR: ${year}

RETRIEVED ${year} PYQS (raw and unformatted; may be half-written, cut off or broken; ${evidence.length} item(s)):
${evidenceBlock}

STYLE REFERENCE from OTHER years (patterns only, never copy):
${styleBlock}

Fix every retrieved question that is incomplete or badly written and keep the good ones. If that leaves fewer than ${MIN_PYQS} questions, generate new ${year}-style questions for Class ${requestedClass} ${subject}, chapter "${chapter}" until you have at least ${MIN_PYQS} (at most ${MAX_PYQS} in total). Retrieved questions come first. Wrap every symbol and every number with a unit in \\( ... \\).`;
}

export function buildTopUpUserPrompt({
  requestedClass,
  subject,
  bookName,
  chapter,
  year,
  existing,
  count,
}) {
  return `CLASS: ${requestedClass}
SUBJECT: ${subject}${bookLineOf(bookName)}
CHAPTER: ${chapter}
YEAR: ${year}

ALREADY ACCEPTED questions (never repeat or rephrase these):
${JSON.stringify(existing.map((text) => String(text).slice(0, 300)))}

Generate exactly ${count} NEW ${year}-style CBSE questions for Class ${requestedClass} ${subject}, chapter "${chapter}". All of them must have origin "generated" and must differ in concept or form from the accepted questions.`;
}