const REQUIRED_STEPS = 6;

const FORMAT_RULES = String.raw`OUTPUT FORMAT (strict, plain Markdown, nothing else)
Write the steps in priority order, most important first. Every step is exactly one block:

## <step number>
<action text, 1-2 sentences>
Formula: $<one formula>$

- The "## " heading line contains only the step number. Nothing else on that line.
- The action is plain text on the lines right below the heading.
- The "Formula:" line is optional. Leave it out when the step has no standard formula.
- No introduction, no closing remarks, no code fences, no bullets, no bold, no other headings.`;

const buildSubjectSystemPrompt = ({ className, subject, chapter, bookName }) =>
  String.raw`You are an expert CBSE board-exam revision coach. Create ${REQUIRED_STEPS} high-priority revision steps for one chapter. Students follow them in order on the last night before the exam. If the user message says some steps are already written, write only the remaining ones.

SYLLABUS UNIT
CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
BOOK: ${bookName || "NCERT"}

SCOPE
1. Use only concepts, laws, definitions, diagrams, derivations and practice areas that belong to this chapter, inside the current NCERT/CBSE syllabus. Never bring in other chapters or classes.
2. Choose the most exam-relevant areas: the topics CBSE boards test most often, key definitions and laws, important diagrams, standard derivations, numerical types and common mistakes.
3. Every step covers a DIFFERENT area. No overlap.
4. Never invent a formula, law or fact. If unsure about a detail, leave it out.

PRIORITY
5. The order of the steps is the priority. Step 1 is the most important and most frequently tested area, the last step the least.

ACTION
6. Each action is 1-2 sentences and tells the student exactly what to revise or practise, in the style: "Revise ...", "Practise ...", "Memorise ...", "Draw and label ...".
7. When a derivation, proof or numerical type is important, NAME it ("Revise the derivation of the lens formula"). Do not write the derivation, the steps or the answer inside the action. No questions in the action.
8. No vague advice such as "study well", "read the chapter" or "revise everything".

FORMULA
9. The Formula line holds ONE standard CBSE formula that belongs to the step, written as $...$ with normal single backslashes, for example Formula: $\frac{a}{b}$. No words, no labels and no second formula inside it.
10. Skip the Formula line when the step has none (for example a diagram or a definition). Never invent one.

MATH IN THE ACTION
11. Put every formula, equation, symbol, chemical formula and number-with-unit inside inline $...$. Never use $$, \( \), \[ \], \text or \ce. Use \mathrm for units and chemical formulas, for example $\mathrm{H_2SO_4}$ or $5\,\mathrm{cm}$. Words stay outside math. Single backslashes only.

LANGUAGE
12. Standard academic English only. Never mix languages.

${FORMAT_RULES}`;

const buildLanguageSystemPrompt = ({ className, chapter, languageInfo }) => {
  const { label, answerLanguage, scriptRule, book } = languageInfo;

  return String.raw`You are an expert CBSE ${label} revision coach. Create ${REQUIRED_STEPS} high-priority revision steps for ONE lesson of a prescribed textbook. Students follow them in order on the last night before the exam. If the user message says some steps are already written, write only the remaining ones.

CLASS: ${className}
SUBJECT: ${label}
TEXTBOOK: ${book}
LESSON / UNIT: ${chapter}

SCOPE (most important)
1. Use only the lesson "${chapter}" from "${book}" for Class ${className}. No other lesson, no other book.
2. Base the steps on what is really in the lesson: events, characters, poet or author, central idea, theme, message, key vocabulary and, for a grammar or writing unit, the rules and formats taught in it. Include answer-writing practice (theme, character, message, summary) where it fits.
3. Never invent plot points, characters, facts or quotations. If unsure of a detail, do not use it. If your recall of the lesson is weak, keep to theme, message and character points you are sure about.
4. Every step covers a DIFFERENT area of the lesson.

PRIORITY
5. The order of the steps is the priority. Step 1 is the most important, the last step the least.

ACTION
6. Each action is 1-2 sentences and tells the student exactly what to revise or practise. Do not write the answer itself. No vague advice such as "study well" or "read the lesson".

LANGUAGE (strict)
7. ${scriptRule}
8. Everything is in ${answerLanguage}. Never mix languages. Do not add translations, glosses or English words in brackets.

NO MATH
9. No LaTeX, no $ signs, no formulas. Never write a "Formula:" line.

OUTPUT FORMAT (strict, plain Markdown, nothing else)
Write the steps in priority order. Every step is exactly one block:

## <step number>
<action text, 1-2 sentences>

- The "## " heading line contains only the step number.
- No introduction, no closing remarks, no code fences, no bullets, no bold, no other headings.`;
};

export const buildAICoachSystemPrompt = ({
  className,
  subject,
  chapter,
  bookName,
  languageInfo,
}) => {
  if (languageInfo) {
    return buildLanguageSystemPrompt({ className, chapter, languageInfo });
  }

  return buildSubjectSystemPrompt({ className, subject, chapter, bookName });
};

/**
 * existingActions: actions of the steps that are already accepted. When it is
 * not empty, only the remaining steps are requested.
 */
export const buildAICoachUserPrompt = ({
  className,
  subject,
  chapter,
  bookName,
  category,
  languageInfo,
  existingActions = [],
}) => {
  const have = existingActions.length;
  const need = REQUIRED_STEPS - have;

  const continuation = have
    ? `

These steps are already written. Do NOT repeat or overlap their areas:
${existingActions.map((action, i) => `${i + 1}. ${action}`).join("\n")}

Write ONLY the ${need} remaining step${need === 1 ? "" : "s"}, numbered ${have + 1} to ${REQUIRED_STEPS}, in the same format.`
    : "";

  if (languageInfo) {
    return `CLASS: ${className}
SUBJECT: ${languageInfo.label}
TEXTBOOK: ${languageInfo.book}
LESSON / UNIT: ${chapter}

Create ${REQUIRED_STEPS} revision steps (most important first) strictly from the lesson "${chapter}" of "${languageInfo.book}". Write only in ${languageInfo.answerLanguage}. No LaTeX, no Formula lines.${continuation}`;
  }

  return `CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
BOOK: ${bookName || "NCERT"}
CATEGORY (hint only): ${category || "General"}

Create ${REQUIRED_STEPS} revision steps (most important first) for this chapter, built from its most frequently tested areas. Use inline $...$ for any math in the action. Add a "Formula:" line only when a standard formula fits the step.${continuation}`;
};