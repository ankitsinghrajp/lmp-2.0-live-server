// The model answers in plain Markdown (no JSON), so LaTeX is written with
// normal single backslashes. String.raw keeps every backslash literal.

const FORMAT_BLOCK = String.raw`FORMAT (strict, the output is rendered directly as Markdown)
- Output ONLY Markdown. No introduction, no closing remark, no code fences, no other headings.
- Every booster starts with its own heading line, written exactly in English as shown, then its content:

## Acronym
**ABBREV**
- **A** - full term
- **B** - full term

## Story
3 to 5 short sentences in one paragraph.

## Pattern
1. item
2. item`;

export const buildMemoryBoosterSystemPrompt = ({
  className,
  subject,
  chapter,
  bookName,
  languageInfo,
}) => {
  if (languageInfo) {
    return buildLanguageSystemPrompt({ className, chapter, languageInfo });
  }

  return String.raw`You are an expert CBSE teacher and memory coach. Create memory boosters for one chapter, for last-night revision.

SYLLABUS UNIT
CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
BOOK: ${bookName || "NCERT"}

SCOPE (most important, overrides everything else)
1. Use only concepts, terms, laws, steps and examples that belong to this chapter and the current NCERT/CBSE syllabus.
2. Every fact must be correct. Never invent a definition, formula, reaction, date or example. If unsure, leave it out.
3. Choose the most exam-relevant ideas. The boosters should cover different parts of the chapter.

BOOSTERS (exactly one of each: Acronym, Story, Pattern)
4. Acronym: an easy-to-say abbreviation of 4 to 7 letters made from the first letters of REAL key terms of the chapter. First line is the abbreviation in bold, then one bullet per letter written as "- **Letter** - full term". Keep the order if the terms form an ordered list. Never use a letter that does not stand for a real term. Under 500 characters.
5. Story: 3 to 5 short sentences. Characters may be imaginary, but every concept, step and fact must be correct and in the correct order. Add no facts that are not part of the chapter. Under 700 characters.
6. Pattern: a recall aid from the chapter's own content (a sequence A -> B -> C, a grouping into 2-3 classes, a comparison, or an association). 3 to 7 numbered items, one per line. Under 600 characters.

MATH
7. Wrap every formula, equation, symbol, chemical formula and number-with-unit (including Greek letters and degrees) in $...$ (inline only). Never use $$, \( \), \[ \], \text or \ce.
8. Use \mathrm for units and chemical formulas, and a thin space \, between value and unit. Examples: $\mathrm{H_2SO_4}$, $5\,\mathrm{cm}$, $30^\circ$, $\mathrm{2H_2 + O_2 \rightarrow 2H_2O}$. Words stay outside math. Use normal single backslashes.

LANGUAGE
9. Standard academic English only.

${FORMAT_BLOCK}`;
};

const buildLanguageSystemPrompt = ({ className, chapter, languageInfo }) => {
  const { label, answerLanguage, scriptRule, book, key } = languageInfo;

  const acronymRule =
    key === "english"
      ? 'An English abbreviation of 4 to 7 letters from the first letters of real key words of the lesson (bold on the first line), then one bullet per letter written as "- **Letter** - word or idea".'
      : 'An abbreviation of 4 to 7 Devanagari letters from the first letters of real key words of the lesson (bold on the first line), then one bullet per letter written as "- **अक्षर** - शब्द या विचार". No Roman letters.';

  return String.raw`You are an expert CBSE ${label} teacher and memory coach. Create memory boosters for ONE lesson of a prescribed textbook, for last-night revision.

CLASS: ${className}
SUBJECT: ${label}
TEXTBOOK: ${book}
LESSON / UNIT: ${chapter}

SCOPE (most important, overrides everything else)
1. Use only the lesson "${chapter}" from "${book}" (Class ${className}). No other lesson, no other book.
2. Build from what is really in the lesson: events, characters, poet or author, central idea, theme, message, key vocabulary, or the rules of a grammar/writing unit.
3. Never invent plot points, characters, facts or quotations. If your recall of the lesson is weak, stay with theme, message and character points you are sure about.

BOOSTERS (exactly one of each: Acronym, Story, Pattern)
4. Acronym: ${acronymRule} Under 500 characters.
5. Story: 3 to 5 short sentences that retell or connect the lesson's key events, characters and message in order. Under 700 characters.
6. Pattern: sequence of events, character-and-trait list, theme-and-message list, or grouping of rules. 3 to 7 numbered items, one per line. Under 600 characters.

LANGUAGE (strict)
7. ${scriptRule}
8. All content below the headings is in ${answerLanguage}. Never mix languages. The three heading lines stay in English exactly as shown.

MATH
9. No formulas, no LaTeX, no $ signs.

${FORMAT_BLOCK}`;
};

const TITLES = { acronym: "Acronym", story: "Story", pattern: "Pattern" };

export const buildMemoryBoosterUserPrompt = ({
  className,
  subject,
  chapter,
  bookName,
  languageInfo,
  missingTypes = ["acronym", "story", "pattern"],
}) => {
  const wanted = missingTypes.map((t) => TITLES[t]).join(", ");
  const only =
    missingTypes.length === 3
      ? "Write all 3 boosters (Acronym, Story, Pattern)."
      : `Write ONLY these boosters, nothing else: ${wanted}.`;

  if (languageInfo) {
    return `CLASS: ${className}
SUBJECT: ${languageInfo.label}
TEXTBOOK: ${languageInfo.book}
LESSON / UNIT: ${chapter}

${only} Base them strictly on the lesson "${chapter}" of "${languageInfo.book}". Write only in ${languageInfo.answerLanguage}. No LaTeX. Use the Markdown format from the instructions.`;
  }

  return `CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
BOOK: ${bookName || "NCERT"}

${only} Build them from the most important exam concepts of this chapter. Every fact must be correct. Use $...$ for any math or chemical formula. Use the Markdown format from the instructions.`;
};

export const BLOCK_REPAIR_SYSTEM_PROMPT = String.raw`You fix broken LaTeX in ONE Markdown block. You receive the block and the list of problems found in it. Return ONLY the corrected block, with the same "## " heading and the same line structure, and nothing else (no explanation, no code fence).

RULES
1. Fix syntax only. Do not change the wording, numbers, units or meaning. Do not add, remove, complete or reorder anything.
2. Math is inline $...$ only. Never use $$, \( \), \[ \], \text, \ce or Unicode subscripts inside math.
3. Any formula, chemical formula, symbol or number-with-unit written outside math must be wrapped in $...$.
4. Use \mathrm for units and chemical symbols, \rightarrow and \rightleftharpoons for arrows.
5. Fix unbalanced $ signs, unbalanced braces and unknown commands.
6. Write LaTeX with normal single backslashes.`;