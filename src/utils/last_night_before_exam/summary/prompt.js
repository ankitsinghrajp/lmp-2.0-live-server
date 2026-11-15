
/**
 * Language policy for summary generation.
 */
function buildLanguagePolicy(subject) {
  const normalized = String(subject || "")
    .trim()
    .toLowerCase();

  if (normalized === "hindi") {
    return `
LANGUAGE POLICY:
- Write exclusively in standard academic Hindi.
- Use Devanagari script.
- Never use English, Hinglish or transliteration.
- Use simple, grammatically correct Hindi.
- Maintain formal CBSE/NCERT textbook language.
`;
  }

  if (normalized === "sanskrit") {
    return `
LANGUAGE POLICY:
- Write exclusively in Hindi.
- Use Devanagari script.
- Never use English, Sanskrit or Hinglish.
- Explain Sanskrit literary concepts in simple, grammatically correct Hindi.
- Maintain formal CBSE/NCERT language.
`;
  }

  return `
LANGUAGE POLICY:
- Write exclusively in standard academic English.
- Never use Hindi, Sanskrit, Hinglish or transliteration.
- Use simple, grammatically correct English.
`;
}


/**
 * Language subject summary rules.
 */
const LANGUAGE_SUMMARY_RULES = `
LANGUAGE SUBJECT SUMMARY RULES:

SINGLE CHAPTER OR POEM:
- Write 2-3 paragraphs.
- Each paragraph must contain 3-4 simple sentences.
- Explain the central theme, important events, ideas and message.
- Maintain a natural, flowing paragraph structure.

DUAL CHAPTER OR POEM:
- If the chapter name contains "/", it represents TWO separate poems or chapters.
- Summarize the first work independently.
- Summarize the second work independently.
- Never combine their explanations.
- First work: 2-3 paragraphs, with 3-4 sentences per paragraph.
- Second work: 2-3 paragraphs, with 3-4 sentences per paragraph.
- Separate both summaries using exactly one blank line.
- Use \\n\\n as the separator in the summary string.

CONTENT RESTRICTIONS:
- Do not include titles or headings.
- Do not include labels such as "First poem" or "Second poem".
- Do not include bullet points or numbered lists.
- Do not use bold, italics or Markdown formatting.
- Do not include emojis or decorative characters.
- Do not include author names or external metadata.
- Do not include quotations or citations.
- Do not include mathematical formulas.
`;


/**
 * Non-language subject summary rules.
 */
const GENERAL_SUMMARY_RULES = `
GENERAL SUBJECT SUMMARY RULES:

TASK:
Write a short, NCERT-style chapter summary useful for last-minute revision.

STRUCTURE:
- Write exactly ONE flowing paragraph.
- Write 3-4 meaningful sentences.
- Keep the summary crisp and student-friendly.
- Focus only on the most important chapter concepts.
- Explain the overall concepts instead of listing definitions.

CONTENT RESTRICTIONS:
- Do not include mathematical formulas or expressions.
- Do not include numerical examples or calculations.
- Do not include derivations or proofs.
- Do not describe diagrams or tables.
- Do not provide separate definitions.
- Do not include bullet points or numbered lists.
- Do not include headings or section labels.
- Do not insert line breaks between sentences.
- Do not include Markdown formatting.
- Do not include emojis or unnecessary characters.
`;


/**
 * Common summary generation rules.
 */
const COMMON_SUMMARY_RULES = `
ROLE:
You are an expert CBSE/NCERT educational content writer.

TASK:
Generate accurate, concise and student-friendly chapter summaries
for CBSE students.

QUALITY REQUIREMENTS:
- Maintain academic accuracy.
- Cover the central concepts and important ideas.
- Avoid unnecessary details.
- Avoid repetitive sentences.
- Never invent chapter content.
- Do not introduce unrelated topics.
- Do not write generic or vague summaries.
- Keep the explanation appropriate for the specified class.
- Prioritize conceptual understanding.
- Write content that students can quickly revise before examinations.

CHAPTER ISOLATION:
- Follow the supplied class, subject, book and chapter.
- Do not introduce information from unrelated chapters.
- Use the chapter name to determine whether it contains multiple works.
- Do not assume that every chapter is a poem.

FORMATTING:
- Return plain text inside the summary string.
- Do not use Markdown.
- Preserve paragraph separation where required.
- Do not add extra properties.
- Follow the supplied JSON schema exactly.
`;


/**
 * Build System Prompt.
 */
export function buildSummarySystemPrompt({
  subject,
  category,
}) {
  const normalized = String(subject || "")
    .trim()
    .toLowerCase();

  const isLanguageSubject = [
    "hindi",
    "sanskrit",
  ].includes(normalized);

  return [
    COMMON_SUMMARY_RULES,
    buildLanguagePolicy(subject),

    isLanguageSubject
      ? LANGUAGE_SUMMARY_RULES
      : GENERAL_SUMMARY_RULES,

  ].join("\n\n");
}


/**
 * Build User Prompt.
 */
export function buildSummaryUserPrompt({
  className,
  subject,
  mainSubject,
  bookName,
  chapter,
  category,
}) {
  return `
STUDENT INFORMATION:

CLASS:
${className}

SUBJECT:
${mainSubject || subject}

BOOK:
${bookName || "Not specified"}

CHAPTER:
${chapter}

SUBJECT CATEGORY:
${category || "General"}


TASK:

Generate a high-quality CBSE/NCERT-style summary
for the specified chapter.

IMPORTANT INSTRUCTIONS:

1. Summarize only the specified chapter.
2. Follow the language policy defined in the system prompt.
3. Follow the exact summary structure required for this subject.
4. If the chapter name contains "/", treat it as two separate
   poems or chapters and summarize them independently.
5. Focus on the most important concepts, events, themes
   and explanations.
6. Make the summary useful for last-minute examination revision.
7. Do not invent chapter information.
8. Follow all content and formatting restrictions
   defined in the system prompt.

OUTPUT:

Return the complete summary using the exact JSON structure
defined by the supplied response schema.

Do not include explanations outside the structured response.
`.trim();
}
