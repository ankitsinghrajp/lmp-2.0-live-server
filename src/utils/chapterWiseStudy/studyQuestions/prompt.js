import {
  QUESTION_COUNT,
  MIN_QUESTION_COUNT,
  MIN_VERY_HIGH,
} from "./config.js";

const hasEvidenceItems = (pyqEvidence) =>
  Array.isArray(pyqEvidence) && pyqEvidence.length > 0;

/* -------------------------------------------------------------------------- */
/*                                System prompts                              */
/* -------------------------------------------------------------------------- */

const buildSubjectSystemPrompt = ({
  className,
  subject,
  chapter,
  bookName,
  hasEvidence,
}) => {
  const evidenceScopeRule = hasEvidence
    ? `2. Previous-year question (PYQ) evidence from real CBSE papers is given in the user message. It is your main signal for what the board asks again and again. Ignore any evidence item that does not belong to this class, subject and chapter. Combine it with your own knowledge of the current NCERT/CBSE syllabus, back exercises and sample papers.`
    : `2. No previous-year question evidence is provided. Use your own knowledge of the current NCERT/CBSE syllabus, back exercises, board papers and sample papers to decide what is asked most often.`;

  const evidenceChooseRule = hasEvidence
    ? `5. Recurring board patterns first. Read the PYQ evidence for concepts, derivations, proofs, numerical types, marks and question types that repeat across different years. A pattern that appears in several years is a top candidate. Then add the patterns you know from board papers, NCERT back exercises and sample papers that the evidence does not show.`
    : `5. Recurring board patterns first. Pick the concepts, derivations, proofs, numerical types and question patterns that CBSE board papers, NCERT back exercises and sample papers ask from this chapter again and again.`;

  const evidenceContentRule = hasEvidence
    ? `
13b. The evidence is only a hint about concepts and patterns. Never copy an evidence item verbatim, never use an incomplete item, never invent missing data. Write NEW, complete questions in the same pattern. The evidence is raw, unformatted text: rewrite its notation in LaTeX. If an evidence item is objective (MCQ, assertion-reason, fill-in-the-blank), turn its concept into a descriptive question.`
    : "";

  const evidenceImportanceRule = hasEvidence
    ? `26. importance: "Very High" for a core pattern that is tested very frequently, especially one that repeats across several years in the evidence (give at least ${MIN_VERY_HIGH} questions this label), otherwise "High". Write the "Very High" questions first.`
    : `26. importance: "Very High" for a core pattern that is tested very frequently (give at least ${MIN_VERY_HIGH} questions this label), otherwise "High". Write the "Very High" questions first.`;

  return String.raw`You are a senior CBSE paper-setter and board-exam analyst. Write the ${QUESTION_COUNT} MOST FREQUENT and MOST IMPORTANT CBSE board exam questions from exactly one chapter, for a chapter-wise study guide. Together they must cover the chapter so well that a student who can answer all of them is ready for that chapter in the board exam. Every question must earn its place. Descriptive questions only: no MCQs and no objective questions of any kind.

SYLLABUS UNIT
CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
BOOK: ${bookName || "NCERT"}

SCOPE (most important, overrides everything else)
1. Every question must test a concept from the chapter "${chapter}" of Class ${className} ${subject}, at the level of that class. Do not introduce topics or question types from other chapters or classes.
${evidenceScopeRule}
3. Use only the vocabulary, data and question styles that are normal for ${subject}. Do not borrow topics or data formats from any other subject or chapter.
4. Use only topics that are part of the current NCERT/CBSE syllabus for this chapter.

HOW TO CHOOSE (decide silently, then write)
${evidenceChooseRule}
6. NCERT core. Use the chapter's key definitions, laws, standard derivations and proofs, textbook examples and back-exercise problems that the board adapts.
7. Current paper design. Include competency-based, case-based or application questions in the style of recent CBSE sample papers.
8. Coverage. The questions must cover different subtopics across the whole chapter. Never two questions on the same idea. Favour the highest-weightage subtopics, then spread the rest so no major subtopic is left out.

CONTENT
9. Write exactly ${QUESTION_COUNT} distinct, complete questions. If you truly cannot find ${QUESTION_COUNT} good ones, return ${MIN_QUESTION_COUNT}. Never more than ${QUESTION_COUNT}, never pad.
10. Every question is complete, self-contained and exam-ready, in standard academic English and CBSE wording ("Explain", "Derive", "Calculate", "Differentiate between", "State and prove", "Write the reason"). No Hindi, Sanskrit, Hinglish or transliteration.
11. Never refer to a figure, diagram, graph, table or passage that is not written inside the question. If a case, source or data set is needed, write it out fully: the case passage in questionText with its parts in subQuestions, or the data in tables.
12. Numerical questions give all data with units, use realistic and consistent values and are solvable at this class level.
13. Questions only: no answers, solutions, hints, probabilities, repetition counts or "asked in <year>" claims. If a question asks students to balance, derive, prove or complete something, leave it unsolved. Any equation you state in full must be correct. If you are unsure of a detail, ask a different question. Never invent quotations.${evidenceContentRule}

FORMAT
14. Wrap every formula, equation, symbol, chemical formula and number-with-unit (including Greek letters and degrees) as \( ... \) inline or \[ ... \] display. Never use $, \text or \ce. Never leave notation such as \mathrm, \rightarrow, _ or ^ outside \( \).
15. Write units with \mathrm and a thin space \, between value and unit, and between units. Never use \times between units. Examples: \(5\,\mathrm{cm}\), \(\mathrm{H_2SO_4}\), \(30^\circ\), \(\mathrm{2H_2 + O_2 \rightarrow 2H_2O}\).
16. In the JSON output every LaTeX backslash is doubled: \\( \\mathrm \\theta \\frac \\rightarrow.
17. "formulas" is almost always []. Fill it ONLY when the question itself gives an equation to work on. Never put an answer, result, solution step, or the formula the student should use. If the question asks students to write, balance or derive an equation, "formulas" must be [] and the equation must not appear anywhere.
18. "tables" is almost always []. Use it only when the question genuinely needs tabulated data (for example a frequency distribution in statistics) that fits ${subject} and "${chapter}". Format: one Markdown table per item, with a header row, a separator row, and data rows joined by \n. questionText must only refer to the table and never repeat its values.
19. Multi-part questions go in subQuestions, one part per item, without (a)/(b) or (i)/(ii) labels.

QUESTION TYPES, MARKS AND ORDER (very important)
20. NO objective questions at all: no MCQ, no Assertion Reason, no fill-in-the-blank, no match-the-following, no true/false. Every question MUST have "options": [] and must be answered in sentences, steps or calculations.
21. Choose only the MOST IMPORTANT questions: the highest-probability, highest-weightage questions of this chapter, the kind that appear in board papers almost every year. Never choose a question because it is interesting or unusual.
22. Never write a question that needs answer choices. Never write (A) (B) (C) (D) lists.
23. Include a balanced mix: at least three Short Answer questions (2-3 marks); at least three Long Answer, derivation or Numerical questions (4-6 marks) suited to the subject; and, where the subject has them, at least one Case Based or Source Based question (4 marks) with the case written in questionText and 3-4 descriptive subQuestions.
24. Marks guide: Short Answer = 2 or 3; Numerical = 2 to 5; Long Answer = 4 to 6; Case Based / Source Based = 4.${hasEvidence ? " Where the evidence shows the usual marks for a pattern, follow them." : ""}
25. Prefer multi-step, exam-level questions. Do not write trivial one-step questions unless that is the normal 2-mark style of this chapter.
${evidenceImportanceRule}`;
};

const buildLanguageSystemPrompt = ({ className, chapter, languageInfo }) => {
  const { label, answerLanguage, scriptRule, book } = languageInfo;

  return String.raw`You are a senior CBSE ${label} paper-setter. Write the ${MIN_QUESTION_COUNT} to ${QUESTION_COUNT} MOST FREQUENT and MOST IMPORTANT CBSE examination questions from exactly ONE lesson of a prescribed textbook, for a chapter-wise study guide.

CLASS: ${className}
SUBJECT: ${label}
TEXTBOOK: ${book}
LESSON / UNIT (story, poem, play, prose piece, or a grammar / writing unit): ${chapter}

SCOPE (most important, overrides everything else)
1. Use only the lesson "${chapter}" from the textbook "${book}" for Class ${className}. No other lesson, no other book.
2. Base the questions on what is really in the lesson: events, characters, poet or author, central idea, theme, message, vocabulary and the language points taught in it. For a grammar or writing unit, use the standard board question patterns for that topic at Class ${className} level.
3. Do not invent plot points, characters, facts or quotations. If you are not certain of a detail, do not use it. Quote a line from the lesson only if you are sure it is accurate and you quote it completely. Never leave a quotation unfinished or cut off.
4. If your recall of the lesson is weak, still return ${MIN_QUESTION_COUNT} questions, but keep them to theme, message, characters or summary points you are sure about.

HOW TO CHOOSE
5. Pick the board favourites: central idea or message, character and traits, "why did ..." reasoning from the lesson, the poet's or author's intent, summary or sequence of events, reference to context style questions on a given extract, and one value-based or opinion question tied to the lesson. Each question covers a DIFFERENT aspect of the lesson.

LANGUAGE (strict)
6. ${scriptRule}
7. All questions in this response must be in ${answerLanguage}. Never mix languages inside a question.

CONTENT
8. Write ${MIN_QUESTION_COUNT} to ${QUESTION_COUNT} distinct, complete questions. Aim for ${QUESTION_COUNT}. Never write more than ${QUESTION_COUNT}.
9. Questions only: no answers, solutions, hints, model answers, repetition counts, probabilities or exam-appearance claims.
10. Every question must be fully self-contained and make sense without any option list. Never refer to a figure or passage that is not written inside the question.

FORMAT
11. This is a language subject: no formulas. Do not use LaTeX, \( \), $ or math notation. "formulas", "tables", "diagrams" and "graphs" must all be [].
12. subQuestions are optional. Use them only for a question that genuinely has parts (for example a question on a given extract). They have no (a)/(b) or (i)/(ii) labels. Otherwise "subQuestions" is [].

QUESTION TYPES (strict)
13. NO multiple-choice questions at all. There is no "options" field in the output. Never write options, choices, (A) (B) (C) (D) lists, or phrases such as "choose the correct option", "सही विकल्प चुनें" or "which of the following". No fill-in-the-blank, match-the-following or assertion-reason questions.
14. questionType is "Short Answer" (2-3 marks) or "Long Answer" (4-6 marks); use about half of each.
15. importance: "Very High" for the core recurring questions (give at least ${MIN_VERY_HIGH} questions this label), otherwise "High". Write the "Very High" questions first.
16. Avoid trivial one-word questions. Prefer questions that check understanding of the lesson.`;
};

/**
 * pyqEvidence: array of { id, question, year, marks, questionType } when RAG
 * produced evidence, otherwise null / [] (no-RAG prompt).
 * Language subjects never receive evidence.
 */
export const buildImportantQuestionsSystemPrompt = ({
  className,
  subject,
  chapter,
  bookName,
  languageInfo,
  pyqEvidence,
}) => {
  if (languageInfo) {
    return buildLanguageSystemPrompt({ className, chapter, languageInfo });
  }

  return buildSubjectSystemPrompt({
    className,
    subject,
    chapter,
    bookName,
    hasEvidence: hasEvidenceItems(pyqEvidence),
  });
};

/* -------------------------------------------------------------------------- */
/*                                 User prompts                               */
/* -------------------------------------------------------------------------- */

export const buildImportantQuestionsUserPrompt = ({
  className,
  subject,
  chapter,
  bookName,
  category,
  languageInfo,
  pyqEvidence,
}) => {
  if (languageInfo) {
    return `CLASS: ${className}
SUBJECT: ${languageInfo.label}
TEXTBOOK: ${languageInfo.book}
LESSON / UNIT: ${chapter}

Write the ${MIN_QUESTION_COUNT} to ${QUESTION_COUNT} most frequent and most important CBSE exam questions strictly from the lesson "${chapter}" of the textbook "${languageInfo.book}" (Class ${className}). Write every question only in ${languageInfo.answerLanguage}. No LaTeX, no formulas, no tables. Do NOT write any MCQ or any question that needs answer choices: every question must be a descriptive question answered in sentences.`;
  }

  const evidenceBlock = hasEvidenceItems(pyqEvidence)
    ? `
RAW PYQ EVIDENCE (real previous-year CBSE questions; unformatted; may include off-topic items, ignore those; rewrite notation in LaTeX; use it to find the patterns that repeat across years, never copy it):
${JSON.stringify(pyqEvidence)}
`
    : "";

  return `CLASS: ${className}
SUBJECT: ${subject}
CHAPTER: ${chapter}
BOOK: ${bookName || "NCERT"}
CATEGORY (hint only): ${category || "General"}
${evidenceBlock}
Write the ${QUESTION_COUNT} most frequent and most important CBSE board questions from chapter "${chapter}" of Class ${className} ${subject}: the most frequently tested concepts and patterns, each on a different subtopic across the chapter, with realistic marks. Wrap every number with a unit and every symbol in \\( ... \\). Keep "formulas" and "tables" as [] unless the question itself needs them.

Give me only the ${QUESTION_COUNT} MOST IMPORTANT questions, the ones a student must be able to answer for this chapter. No MCQs, no Assertion Reason, no objective questions of any kind: every question is descriptive with "options": [].`;
};