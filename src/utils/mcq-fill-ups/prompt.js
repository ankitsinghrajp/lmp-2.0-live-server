import {
  getLanguage,
  isLanguageSubject,
} from "./language.js";

/* -------------------------------------------------------------------------- */
/*  Prompt notes (conflicts removed compared with the previous version)       */
/*  - JSON escaping: the model writes JSON, so LaTeX backslashes MUST be      */
/*    doubled. The old prompt said "do not double-escape", which produced    */
/*    broken text and caused full regenerations.                              */
/*  - No fixed counts, ids, order or chapter/class/subject fields: the        */
/*    schema and validator no longer require them.                            */
/*  - "$" is the math delimiter, so currency must not use "$".                */
/*  - Language subjects (Hindi, Sanskrit, English) are decided in one place   */
/*    (language.js) for both the prompt and the validator.                    */
/* -------------------------------------------------------------------------- */

function buildLanguagePolicy(subject) {
  const language = getLanguage(subject);

  if (language === "Hindi") {
    return `
LANGUAGE POLICY:
- Write exclusively in standard academic Hindi.
- Use Devanagari script.
- Never use English, Hinglish or transliteration.
- Do not mix Hindi with Sanskrit sentence structures.
- Use formal CBSE/NCERT textbook language.
`;
  }

  if (language === "Sanskrit") {
    return `
LANGUAGE POLICY:
- Write exclusively in grammatically correct classical Sanskrit.
- Use Devanagari script.
- Never mix Hindi or English.
- Use correct Sanskrit vocabulary, vibhakti and verb forms.
- Never use Hindi sentence structures or transliteration.
`;
  }

  return `
LANGUAGE POLICY:
- Write exclusively in standard academic English.
- Never use Hindi, Sanskrit, Hinglish or transliteration.
`;
}

const QUIZ_GENERATION_RULES = `
TASK:
Generate high-quality, exam-oriented objective questions for CBSE students.

QUESTION MIX (a guide, not a strict count):
- Aim for about 15 questions: roughly 7 MCQs, 4 Fill in the Blanks and 4 True/False.
- A few more or fewer of any type is fine.
- Never pad with weak questions. Fewer good questions are better than filler.
- Group the questions by type: MCQs first, then Fill in the Blanks, then True/False.

QUESTION QUALITY:
- Prioritize important NCERT concepts and examination-relevant topics.
- Prefer concepts commonly emphasized in CBSE examinations.
- Questions must be accurate, unambiguous and exam-ready.
- Do not repeat the same question or the same fact in different words.
- Avoid filler, vague or unnecessarily creative questions.
- Never invent PYQ history or claim a question appeared in a previous examination.

CHAPTER ISOLATION:
- Generate questions strictly from the supplied chapter.
- Stay within the specified class and subject syllabus.
- Do not introduce concepts from unrelated chapters.
- Use the supplied topic information as the scope restriction.

DIFFICULTY:
- Easy: Direct concepts, definitions and basic applications.
- Medium: Standard CBSE board-level conceptual and application questions.
- Hard: Challenging applications and deeper conceptual questions. Keep answers short enough for the question type.
- Difficulty must not change the question types or the output structure.

QUESTION TYPE RULES:

MCQ ("type": "mcq"):
- Exactly four options, written without (A)/(B)/1./a) labels.
- Exactly one correct answer.
- "answer" must be copied character for character from one of the four options.
- Options must be meaningful, plausible and different from each other.

FILLUP ("type": "fillup"):
- Write one statement with a single blank written as ______.
- "answer" is a single word or short phrase.
- The blank must have one unambiguous correct answer.
- Do not generate incomplete or unclear statements.
- Never include options.

TRUE/FALSE ("type": "true_false"):
- The statement must be factually unambiguous.
- "answer" vocabulary must match the subject language.
- English subjects: "True" or "False".
- Hindi: "सत्य" or "असत्य".
- Sanskrit: "आम्" or "न".
- Never include options.

MULTI-PART QUESTIONS:
- Multi-part questions are allowed when appropriate.
- Each sub-part must appear on a separate line.
`;

const MATH_RULES = String.raw`
MATHEMATICAL FORMATTING:

- Use $...$ for inline mathematics and $$...$$ for display mathematics.
- Never use \( \) or \[ \].
- Every mathematical expression, variable, symbol, formula, chemical formula and number-with-unit must be inside math delimiters.
- Never place a LaTeX command outside math delimiters.
- Never put Markdown bold inside mathematical expressions.
- Use proper subscripts and superscripts. Use \mathrm{...} for units and chemical formulas. Never use \ce.
- Use one display math block per derivation equation.
- Never use the $ sign for currency. Write rupee amounts with ₹ or "Rs." outside math.

JSON ESCAPING (very important):
- Your answer is a JSON string, so every LaTeX backslash must be written as a DOUBLE backslash.
- Write \\frac for \frac, \\times for \times, \\theta for \theta, \\beta for \beta, \\rho for \rho, \\neq for \neq, \\vec for \vec, \\rightarrow for \rightarrow.
- A single backslash before f, t, b, r, n or v corrupts the text (for example \frac becomes a form-feed character followed by "rac").
`;

const LANGUAGE_FORMAT_RULES = `
LANGUAGE SUBJECT FORMATTING:
- Do not use LaTeX, $ signs or mathematical notation.
- Use natural subject-specific language.
- Maintain correct grammar and vocabulary.
`;

const MARKDOWN_RULES = `
MARKDOWN FORMATTING:

- Use Markdown only for readability.
- Bold important keywords only when necessary.
- Use proper line breaks for multi-part questions.
- No Markdown headings.
- No code blocks.
- No explanations, hints or solutions.
- Keep questions concise and exam-oriented.
`;

const OUTPUT_RULES = `
OUTPUT REQUIREMENTS:

- Return exactly the JSON structure defined by the supplied schema: an object with a "questions" array.
- Each question uses only the three permitted types.
- Never add extra properties.
- Never omit required properties.
- Do not number the questions. Numbering is added automatically.
`;

export function buildQuizSystemPrompt({ subject }) {
  return [
    `You are an expert CBSE Board examination question setter.
Your responsibility is to create accurate, syllabus-aligned,
high-quality practice questions for students.`,
    buildLanguagePolicy(subject),
    QUIZ_GENERATION_RULES,
    isLanguageSubject(subject) ? LANGUAGE_FORMAT_RULES : MATH_RULES,
    MARKDOWN_RULES,
    OUTPUT_RULES,
  ].join("\n\n");
}

export function buildQuizUserPrompt({
  className,
  subject,
  mainSubject,
  bookName,
  chapter,
  category,
  difficulty = "Medium",
  index = [],
}) {
  const selectedTopics =
    Array.isArray(index) && index.length > 0 ? index : [];

  return `
CLASS:
${className}

SUBJECT:
${mainSubject || subject}

BOOK:
${bookName || "Not specified"}

CHAPTER:
${chapter}

STREAM:
${category || "General"}

DIFFICULTY:
${difficulty}

SELECTED TOPICS:
${
  selectedTopics.length
    ? JSON.stringify(selectedTopics)
    : "All key topics from the chapter"
}

TASK:
Generate about 15 CBSE examination-oriented questions
(roughly 7 MCQs, 4 Fill in the Blanks, 4 True/False)
for the specified class, subject and chapter.

If selected topics are provided, restrict questions to those
topics. Otherwise, cover all important topics in the chapter.

Ensure that questions are accurate, non-repetitive,
syllabus-aligned and appropriate for the specified difficulty.

Follow every instruction in the system prompt.
`.trim();
}

/**
 * Asks the model to rewrite ONLY the questions that failed validation.
 * Sent with the same system prompt, so language and LaTeX rules still apply.
 */
export function buildRepairUserPrompt({
  className,
  subject,
  mainSubject,
  chapter,
  failed,
  existingQuestions = [],
}) {
  const items = failed.map(({ question, issues }, position) => ({
    number: position + 1,
    question,
    problems: issues.slice(0, 6),
  }));

  const alreadyUsed = existingQuestions.map((q) =>
    String(q.question ?? "").slice(0, 100)
  );

  return `
CLASS:
${className}

SUBJECT:
${mainSubject || subject}

CHAPTER:
${chapter}

TASK:
The questions below failed automatic validation. Rewrite each one so that
every listed problem is fixed.

- Keep the same question type and the same concept.
- Return exactly ${failed.length} corrected question(s), in the same order.
- Do not add any extra questions.
- Do not repeat any of the already accepted questions listed below.
- Follow every instruction in the system prompt.

QUESTIONS TO FIX:
${JSON.stringify(items)}

ALREADY ACCEPTED QUESTIONS (do not repeat):
${JSON.stringify(alreadyUsed)}
`.trim();
}