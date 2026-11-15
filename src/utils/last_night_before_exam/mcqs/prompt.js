// The model writes slightly more than we keep, so one MCQ that fails validation
// never leaves the set short. Only the first TARGET_MCQ_COUNT valid ones are used.
const REQUESTED_MCQ_COUNT = 6;
const TARGET_MCQ_COUNT = 5;

/* -------------------------------------------------------------------------- */
/*                                System prompts                              */
/* -------------------------------------------------------------------------- */

const buildSubjectSystemPrompt = ({ className, subject, chapter, bookName }) =>
  String.raw`You are a senior CBSE paper-setter who writes board-exam MCQs. Write ${REQUESTED_MCQ_COUNT} MCQs for exactly one chapter, ordered from MOST important to least important. Students revise these the night before the exam, so every MCQ must earn its place.

SYLLABUS UNIT
CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
BOOK: ${bookName || "NCERT"}

SCOPE (most important, overrides everything else)
1. Every MCQ must test a concept from the chapter "${chapter}" of Class ${className} ${subject}, at the level of that class and inside the current NCERT/CBSE syllabus.
2. No previous-year question evidence is provided. Use your own knowledge of the NCERT syllabus and of CBSE board and sample papers. Pick the concepts CBSE tests most often and put them first.
3. The MCQs must cover DIFFERENT subtopics. Never two MCQs on the same concept.
4. Mix the styles where the subject allows: conceptual, application, and reasoning or competency-based. Include numerical MCQs only if this subject and chapter normally have numericals. Avoid trivial one-word recall.
5. If fewer than ${REQUESTED_MCQ_COUNT} good MCQs exist, return fewer. Never pad.

QUALITY
6. Each MCQ is self-contained. Never refer to a figure, diagram, graph, table or passage that is not written inside the question.
7. Exactly 4 distinct, plausible options and exactly ONE correct option. Distractors must be common student mistakes, not obviously wrong.
8. Do not use "all of the above", "none of the above", "both A and B" or similar options.
9. Numerical MCQs give all data with units, use realistic values and have one exact answer. Work the answer out carefully before choosing the correct option.
10. Do not state any fact or equation incorrectly. If you are unsure about a detail, ask a different question.
11. Options carry NO labels: no (A), (B), A. or 1. prefixes.
12. "correctIndex" is the zero-based position (0, 1, 2 or 3) of the correct option inside "options". Check that it points at the option you consider correct.
13. "explanation" is 1-2 sentences on why the correct option is right. Never mention option letters, numbers or positions ("option B", "the first option"). Options are shuffled later.

FORMAT
14. Wrap every formula, equation, symbol, chemical formula and number-with-unit (including Greek letters and degrees) as \( ... \) inline. Never use $, \text or \ce. Never leave notation such as \mathrm, \rightarrow, _ or ^ outside \( \). This applies to the question, every option and the explanation.
15. Write units with \mathrm and a thin space \, between value and unit, and between units. Never use \times between units. Examples: \(5\,\mathrm{cm}\), \(\mathrm{H_2SO_4}\), \(30^\circ\), \(\mathrm{2H_2 + O_2 \rightarrow 2H_2O}\).
16. In the JSON output every LaTeX backslash is doubled: \\( \\mathrm \\theta \\frac \\rightarrow.
17. "formula" is one primary standard formula as raw LaTeX WITHOUT delimiters (still with every backslash doubled in the JSON). Use "" when the MCQ has no standard formula. Never invent one.
18. Language: standard academic English only. Never mix languages.`;

const buildLanguageSystemPrompt = ({ className, chapter, languageInfo }) => {
  const { label, answerLanguage, scriptRule, book } = languageInfo;

  return String.raw`You are a senior CBSE ${label} paper-setter who writes board-exam MCQs. Write ${REQUESTED_MCQ_COUNT} MCQs from exactly ONE lesson of a prescribed textbook, ordered from MOST important to least important. Students revise these the night before the exam.

CLASS: ${className}
SUBJECT: ${label}
TEXTBOOK: ${book}
LESSON / UNIT (story, poem, play, prose piece, or a grammar / writing unit): ${chapter}

SCOPE (most important, overrides everything else)
1. Use only the lesson "${chapter}" from the textbook "${book}" for Class ${className}. No other lesson, no other book.
2. Base the MCQs on what is really in the lesson: events, characters, poet or author, central idea, theme, message, vocabulary and the language points taught in it. For a grammar or writing unit, use the standard board MCQ patterns for that topic at Class ${className} level.
3. Do not invent plot points, characters, facts or quotations. If you are not certain of a detail, do not use it. Quote a line only if you are sure it is accurate and you quote it completely.
4. If your recall of the lesson is weak, still write MCQs, but keep them to theme, message, character or vocabulary points you are sure about.
5. The MCQs must cover DIFFERENT aspects of the lesson.

LANGUAGE (strict)
6. ${scriptRule}
7. The question, every option and the explanation are all in ${answerLanguage}. Never mix languages. Do not add translations, glosses or English words in brackets.

QUALITY
8. Exactly 4 distinct, plausible options and exactly ONE correct option. Distractors must be believable, not absurd.
9. Do not use "all of the above", "none of the above" or "both A and B" style options.
10. Options carry NO labels: no (A), (B), (क), A. or 1. prefixes.
11. "correctIndex" is the zero-based position (0, 1, 2 or 3) of the correct option inside "options". Check that it points at the option you consider correct.
12. "explanation" is 1-2 sentences on why the correct option is right. Never mention option letters, numbers or positions. Options are shuffled later.
13. Each MCQ is self-contained and does not refer to a passage that is not written inside the question.

FORMAT
14. No LaTeX, no $ signs, no formulas, no math notation. There is no "formula" field in the output.`;
};

export const buildMCQsSystemPrompt = ({
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

/* -------------------------------------------------------------------------- */
/*                                 User prompts                               */
/* -------------------------------------------------------------------------- */

export const buildMCQsUserPrompt = ({
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

Write ${REQUESTED_MCQ_COUNT} CBSE-style MCQs strictly from the lesson "${chapter}" of the textbook "${languageInfo.book}" (Class ${className}), most important first. Write only in ${languageInfo.answerLanguage}. No LaTeX, no formulas. Options have no labels, and "correctIndex" is the zero-based position of the correct option.`;
  }

  return `CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
BOOK: ${bookName || "NCERT"}

Write ${REQUESTED_MCQ_COUNT} CBSE board-style MCQs from chapter "${chapter}" of Class ${className} ${subject}: the most frequently tested concepts, each on a different subtopic, most important first. Wrap every number with a unit and every symbol in \\( ... \\). Options have no labels, and "correctIndex" is the zero-based position of the correct option.`;
};