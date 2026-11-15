// The model answers in plain Markdown (no JSON), so LaTeX is written with
// normal single backslashes. String.raw keeps every backslash literal.

const LANGUAGE_RULES = {
  Hindi:
    "Write the topic names and explanations in Hindi using Devanagari script only. Do not write English or Roman-script (transliterated) words.",
  Sanskrit:
    "Write the topic names and explanations in Sanskrit using Devanagari script only. Do not write English, Hindi or Roman-script (transliterated) words.",
};

function splitBook(subject) {
  const text = String(subject ?? "");
  const i = text.indexOf(":");
  const book = i >= 0 ? text.slice(i + 1).trim() : "";
  return book || "the prescribed NCERT/CBSE textbook";
}

function buildLanguageSystemPrompt({ className, subject, chapter, language }) {
  return String.raw`You are a CBSE ${language} exam expert. Write a last-minute revision sheet of important topics, in Markdown, for exactly one lesson / unit of a prescribed textbook:

CLASS: ${className}
SUBJECT: ${language}
TEXTBOOK: ${splitBook(subject)}
LESSON / UNIT (story, poem, play, prose piece, or a grammar / writing unit): ${chapter}

SCOPE (most important, overrides everything else)
1. Every topic must come from the lesson "${chapter}" of this textbook at Class ${className} level. Do not use any other lesson or book.
2. Good topics: central idea, theme, message, poet or author, characters, important events, poetic devices, key vocabulary; for a grammar or writing unit, its key rules and formats.
3. Prefer topics that carry marks in CBSE board papers. Cover different parts of the lesson. Never spend two topics on the same idea.
4. Never invent plot points, characters, facts or quotations. If you are not sure of a detail, stay general. If you cannot reliably recall the lesson, return fewer topics rather than guessing. Never pad.

LANGUAGE (strict)
5. ${LANGUAGE_RULES[language]}
6. Never mix languages.

CONTENT
7. Each topic has a short, precise name and ONE concise explanation of 1-2 sentences. No questions, examples or model answers.

FORMAT (strict, the output is rendered directly as Markdown)
8. Output ONLY Markdown. No introduction, no closing remark, no numbering, no code fences, no lists, no tables, no bold.
9. Write each topic exactly like this, and nothing else:
## Topic name
Explanation in one paragraph.
10. This is a language subject: no formulas, no LaTeX, no $ signs.`;
}

export const buildImportantTopicsSystemPrompt = ({
  className,
  subject,
  chapter,
  language,
}) => {
  if (language) {
    return buildLanguageSystemPrompt({ className, subject, chapter, language });
  }

  return String.raw`You are a CBSE exam expert. Write a last-minute revision sheet of important topics, in Markdown, for exactly this syllabus unit:

CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}

SCOPE (most important, overrides everything else)
1. Every topic must be a concept from the chapter "${chapter}" of Class ${className} ${subject}, at the level of that class, and part of the current NCERT/CBSE syllabus for this chapter.
2. Match the depth of a Class ${className} board paper. Prefer concepts that carry marks (laws, definitions that are asked directly, standard results, derivations, methods, key terms) over trivial introductory facts.
3. Use only the vocabulary, formulas and data formats that are normal for ${subject}. Do not borrow topics from any other subject or chapter.
3b. If the subject names a textbook (for example "English: First Flight"), the chapter is a lesson of that textbook. Base the topics only on its real content and never invent details.
4. Cover the full breadth of the chapter, including its standard derivations and applications, not only basic definitions. Never spend two topics on the same idea.
5. If fewer good topics exist than requested, return fewer. Never pad.

CONTENT
6. Each topic has a short, precise name and ONE concise explanation of 1-2 sentences that states the idea directly. No examples, questions, worked derivations, steps or exam tips.
7. FORMULA: if the topic has a standard formula, law, equation, reaction, dimensional formula or standard result in ${subject}, include exactly ONE. Write it as a complete equation with its left-hand side (for example F = ..., \vec{E} = ..., \Phi_E = ...), never a bare expression. If the topic has none, include no formula. Never invent a formula.
8. A formula must agree with the explanation. When a direction or sign depends on a quantity (such as charge), use the signed quantity, not its modulus.

FORMAT (strict, the output is rendered directly as Markdown)
9. Output ONLY Markdown. No introduction, no closing remark, no numbering, no code fences, no lists, no tables, no bold, no other headings.
10. Write each topic exactly like this, and nothing else:
## Topic name
Explanation in one paragraph.

$$
formula
$$
The $$ block is only for topics that have a formula; leave it out otherwise.
11. Inside the explanation, wrap every formula, symbol, chemical formula and number-with-unit (including Greek letters and degrees) in $...$. Put the display formula between $$ lines as shown. Never use \( \), \[ \], \text or \ce.
12. Write units with \mathrm and a thin space \, between value and unit, for example $5\,\mathrm{C}$. Use \mathrm for chemical symbols and \rightarrow for arrows. Use simple KaTeX-compatible LaTeX with normal single backslashes.`;
};

export const buildImportantTopicsUserPrompt = ({
  className,
  subject,
  chapter,
  count,
  existingTopics = [],
  syllabusHeadings = [],
}) => {
  const exclude = existingTopics.length
    ? `\nALREADY COVERED (do not repeat or rephrase these): ${JSON.stringify(existingTopics)}\n`
    : "";

  const headings = syllabusHeadings.length
    ? `\nNCERT SECTION HEADINGS OF THIS CHAPTER (choose topics from these): ${JSON.stringify(syllabusHeadings)}\n`
    : "";

  return `CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
${headings}${exclude}
Write exactly ${count} important topics for Class ${className} ${subject}, chapter "${chapter}", most important first, in the Markdown format from the instructions. Cover the whole chapter and pitch every topic at Class ${className} board-exam level.`;
};

export const BLOCK_REPAIR_SYSTEM_PROMPT = String.raw`You fix broken LaTeX in ONE Markdown study-note block. You receive the block and the list of problems found in it. Return ONLY the corrected block, with the same "## " heading and nothing else (no explanation, no code fence).

RULES
1. Fix syntax only. Do not change the wording, numbers, units or meaning. Do not solve, simplify, complete, add or remove anything.
2. Inline math uses $...$. A display formula uses $$ on its own lines. Never use \( \), \[ \], \text, \ce or Unicode subscripts or arrows inside math.
3. Any formula, chemical formula, symbol or number-with-unit written outside math must be wrapped in $...$.
4. Use \mathrm for units and chemical symbols, \rightarrow and \rightleftharpoons for arrows.
5. Fix unbalanced $ signs, unbalanced braces and unknown commands.
6. Write LaTeX with normal single backslashes.`;