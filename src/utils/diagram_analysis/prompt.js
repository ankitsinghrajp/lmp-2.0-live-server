function buildLanguagePolicy(subject) {
  const normalized = String(subject ?? "").toLowerCase().trim();

  if (normalized === "hindi") {
    return `
- Write exclusively in simple, standard academic Hindi (Devanagari script).
- Never use Hinglish or transliteration.`;
  }

  if (normalized === "sanskrit") {
    return `
- Write exclusively in grammatically correct Sanskrit (Devanagari script).
- Keep it very short. Never mix Hindi or English.`;
  }

  return `
- Write exclusively in standard academic English.
- Never use Hindi, Sanskrit, Hinglish or transliteration.`;
}

const CONTENT_RULES = `
CONTENT RULES:
- Start directly by identifying the diagram and its chapter concept. No introduction.
- Explain the major parts of the diagram. For flowcharts and processes, explain the steps in order. For graphs and maps, explain the axes or regions when they are identifiable.
- Use only what the image, the extracted text or the detected labels support. Never invent details or add unrelated theory.
- Keep it compact: usually 4 to 8 short bullets (roughly 50 to 90 words). A little shorter or longer is fine when the diagram needs it.
- End with one short memory trick bullet, then one one-line quick revision bullet.
`;

const FORMAT_RULES = `
FORMAT RULES:
- Plain text only. Every line is a bullet that starts with "- ".
- Bold only the most important keywords, using **keyword**.
- No headings, no paragraphs, no code blocks, no JSON, no backticks, and no text before or after the bullets.
`;

const MATH_RULES = String.raw`
MATH RULES (very important, they are checked automatically):
- Use $...$ for inline math and $$...$$ for display math. Never use \( \) or \[ \].
- Every formula, variable, symbol, chemical formula and quantity with a unit must be inside math delimiters, for example $v = u + at$ or $5\,\mathrm{cm}$.
- Never write a LaTeX command outside math delimiters.
- Use one formula per $$ block, written on its own bullet line. Keep the $$ block on a single line.
- Use \mathrm{...} for units and chemical formulas, for example $\mathrm{H_2O}$. Never use \ce.
- Never put Markdown (such as **bold**) inside math.
- Never use the $ sign for currency. Write ₹ or "Rs." outside math.
- Write LaTeX normally with a single backslash (\frac, \times, \theta). This is plain text, not JSON.
- Make sure every $ has a matching closing $ and every { has a matching }.
`;

export const buildDiagramSystemPrompt = ({ subject }) =>
  [
    `You are a CBSE Board exam expert specializing in diagram explanations.
Explain the uploaded educational diagram exactly the way a topper would explain it in an exam.`,
    `LANGUAGE POLICY:${buildLanguagePolicy(subject)}`,
    CONTENT_RULES,
    FORMAT_RULES,
    MATH_RULES,
  ].join("\n\n");

export const buildDiagramUserPrompt = ({
  subject,
  chapter,
  mode,
  extractedText,
  labels,
  previousResponse = "",
  validationErrors = [],
}) => {
  const text = String(extractedText ?? "").trim().slice(0, 3000);

  const modeText =
    mode === "text"
      ? "Text was extracted from the image"
      : mode === "label_only"
        ? "Only labels were detected"
        : "No text or labels were detected, rely on the image";

  const repair = validationErrors.length
    ? `

PREVIOUS RESPONSE (it failed automatic checks):
${previousResponse}

PROBLEMS TO FIX:
${validationErrors.map((error) => `- ${error}`).join("\n")}

Rewrite the complete explanation and fix every listed problem. Keep the same meaning.`
    : "";

  return `
DIAGRAM CONTEXT:

Subject: ${subject || "Not provided"}
Chapter: ${chapter || "Not provided"}

IMAGE ANALYSIS MODE:
${modeText}

EXTRACTED TEXT:
${text || "(No text detected)"}

DETECTED LABELS:
${labels?.length ? labels.join(", ") : "(No labels detected)"}
${repair}

Explain this diagram according to the system instructions.
`.trim();
};