import { normalizeSubject } from "./validation.js";

function buildLanguagePolicy(subject) {
  const normalized = normalizeSubject(subject);

  if (normalized === "hindi") {
    return `
- Write exclusively in simple, standard academic Hindi (Devanagari script).
- Never use Hinglish or transliteration.
- Common acronyms such as CBSE or DNA may stay in capital Latin letters.`;
  }

  if (normalized === "sanskrit") {
    return `
- Write exclusively in grammatically correct Sanskrit (Devanagari script).
- Never mix Hindi or English.
- Keep it very short, about 3 lines.`;
  }

  if (!normalized) {
    // Ask Any Question often has no subject: follow the student's language.
    return `
- Answer in the same language as the student's question (English or Hindi).
- If the question is mixed or unclear, answer in standard academic English.
- Never use Hinglish or transliteration.`;
  }

  return `
- Write exclusively in standard academic English.
- Never use Hindi, Sanskrit, Hinglish or transliteration.`;
}

const CONTENT_RULES = `
CONTENT RULES:
- Start directly with the answer. No introduction and no conclusion.
- Answer every part of the question.
- Match the depth to the difficulty: Easy = simple language and basic steps, Medium = standard CBSE board-level answer, Hard = detailed topper-style answer with all necessary steps.
- Never add unnecessary theory. Write exactly what is needed to score full marks.
- Include definitions and examples only when they help.
- Use the image (when one is attached) and the extracted text to understand and solve the complete question. If a diagram is part of the question, explain its relevant parts.
- If the question cannot be read at all, say so briefly instead of inventing one.
- Never reveal internal reasoning.
`;

const FORMAT_RULES = `
FORMAT RULES:
- Reply in Markdown. Use bullet points where appropriate and a Markdown table for comparisons.
- Bold only important keywords, using **keyword**.
- Put each sub-part of a multi-part question on its own line.
- If a diagram is needed, describe its labelled parts in words or in a table. Never draw ASCII art.
- No Markdown headings, no JSON, and no code blocks (unless the question itself is about programming).
`;

const MATH_RULES = String.raw`
MATH RULES (very important, they are checked automatically):
- Use $...$ for inline math and $$...$$ for display math. Never use \( \) or \[ \].
- Every formula, variable, vector, symbol, chemical formula and quantity with a unit must be inside math delimiters, for example $v = u + at$ or $5\,\mathrm{N}$.
- Never write a LaTeX command outside math delimiters.
- Put every derivation step in its own $$...$$ block.
- Use \mathrm{...} for units and chemical formulas, for example $\mathrm{H_2O}$. Never use \ce.
- Never put Markdown (such as **bold**) inside math.
- Never use the $ sign for money. Write ₹ or "Rs." outside math.
- Write LaTeX normally with a single backslash (\frac, \times, \theta, \vec{E}). This is plain text, not JSON.
- Make sure every $ has a matching closing $ and every { has a matching }.
`;

export function buildAskAnyQuestionSystemPrompt({ subject }) {
  return [
    `You are an expert CBSE Board examination teacher.
Your task is to produce accurate, full-mark, topper-style answers.`,
    `LANGUAGE POLICY:${buildLanguagePolicy(subject)}`,
    CONTENT_RULES,
    FORMAT_RULES,
    MATH_RULES,
  ].join("\n\n");
}

export function buildAskAnyQuestionUserPrompt({
  question,
  className,
  subject,
  chapter,
  difficulty = "Medium",
  mode = "no_image",
  extractedText = "",
  labels = [],
  previousResponse = "",
  validationErrors = [],
}) {
  const ocr = String(extractedText ?? "").trim().slice(0, 4000);

  const modeText =
    mode === "text"
      ? "Text was extracted from the attached image"
      : mode === "label_only"
        ? "Only labels were detected in the attached image"
        : mode === "fallback"
          ? "No text or labels were detected, rely on the attached image"
          : "No image attached";

  const repair = validationErrors.length
    ? `

PREVIOUS ANSWER (it failed automatic checks):
${previousResponse}

PROBLEMS TO FIX:
${validationErrors.map((issue, i) => `${i + 1}. ${issue}`).join("\n")}

Rewrite the complete answer and fix every listed problem. Keep the same meaning.`
    : "";

  return `
STUDENT QUESTION:
${question || "No typed question. Use the image."}

CLASS: ${className || "Not specified"}
SUBJECT: ${subject || "Not specified"}
CHAPTER: ${chapter || "Not specified"}
DIFFICULTY: ${difficulty}

IMAGE ANALYSIS MODE:
${modeText}

EXTRACTED IMAGE TEXT:
${ocr || "(none)"}

DETECTED IMAGE LABELS:
${labels.length ? labels.join(", ") : "(none)"}
${repair}

Answer the student's question according to the system instructions.
`.trim();
}