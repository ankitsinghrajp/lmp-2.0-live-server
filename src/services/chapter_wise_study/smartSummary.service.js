import { importantQuestionsOpenAI } from "../../config/importantQuestionsOpenAI.js";

const MODEL = "gpt-4o-mini";
const GENERATION_TEMPERATURE = 0.3;

// Chunks are coalesced so we don't publish one realtime event per token.
const MIN_CHUNK_CHARS = 40;
const FLUSH_INTERVAL_MS = 150;

const summaryResponseSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "The final summary as plain text. Real line breaks only; no markdown, bullets, headings, emojis, formulas or quotation marks.",
    },
  },
  required: ["summary"],
  additionalProperties: false,
};

/* -------------------------------------------------------------------------- */
/*                                  Prompts                                   */
/* -------------------------------------------------------------------------- */

function buildLanguageSystemPrompt({ className, subject, bookName, chapter }) {
  return `You are a CBSE exam expert. Write a revision summary of exactly one NCERT chapter or poem. Think silently and never show your reasoning.

CLASS: ${className}
SUBJECT: ${subject}
BOOK: ${bookName}
CHAPTER / POEM: ${chapter}

LANGUAGE (strict)
1. If the subject is Hindi or Sanskrit, write ONLY in Hindi (Devanagari script).
2. For every other subject, write ONLY in English. Never use Hindi for English or any other subject.

SCOPE
3. Base the summary only on the given chapter or poem. Do not invent plot points, characters or facts. If you are unsure of a detail, leave it out.
4. If the chapter name contains "/", it names TWO different chapters or poems. Summarize each one SEPARATELY. Never merge, compare or mention that there are two.

FORMAT
5. One chapter or poem: 2-3 paragraphs, each paragraph 5-6 simple lines.
6. Two chapters or poems: the first one only (2-3 paragraphs), then the second one only (2-3 paragraphs).
7. Separate paragraphs, and the two summaries, with exactly one blank line (real line breaks inside the string).
8. No titles, headings, labels, names of poets or authors, bullet points, numbering, bold, italics, emojis, formulas or quotation marks. Clean plain-text paragraphs only.`;
}

function buildGeneralSystemPrompt({ className, subject, bookName, chapter }) {
  return `You are a CBSE exam expert. Write a short NCERT-style chapter summary for last-minute revision. Think silently and never show your reasoning.

CLASS: ${className}
SUBJECT: ${subject}
BOOK: ${bookName}
CHAPTER: ${chapter}

RULES
1. The summary must be ONE flowing paragraph of 5-6 simple lines, crisp and student-friendly.
2. Base it only on this chapter of this class and subject, and never invent facts.
3. No formulas, numericals, derivations, diagrams, definitions, tables, headings, bullet points, lists or line breaks.
4. Write in English.`;
}

function buildUserPrompt({ className, subject, bookName, chapter }) {
  return `CLASS: ${className}
SUBJECT: ${subject}
BOOK: ${bookName}
CHAPTER: ${chapter}

Write the summary for this chapter now.`;
}

/* -------------------------------------------------------------------------- */
/*                         Streaming JSON text extractor                       */
/* -------------------------------------------------------------------------- */

/**
 * Reads a streamed {"summary":"..."} response and calls onText with the
 * DECODED text of the summary value as it arrives. It handles JSON escapes
 * (\n, \", \\, \uXXXX) across chunk boundaries, so the frontend receives real
 * line breaks and never sees raw JSON.
 */
function createSummaryExtractor(onText) {
  const SIMPLE_ESCAPES = {
    n: "\n",
    t: "\t",
    r: "\r",
    b: "\b",
    f: "\f",
    '"': '"',
    "\\": "\\",
    "/": "/",
  };

  let state = "seekKey"; // seekKey -> inKey -> seekValue -> inValue -> done
  let escaped = false;
  let unicode = null;

  return function push(chunk) {
    let out = "";

    for (const ch of chunk) {
      switch (state) {
        case "seekKey":
          if (ch === '"') state = "inKey";
          break;

        case "inKey":
          if (ch === '"') state = "seekValue";
          break;

        case "seekValue":
          if (ch === '"') state = "inValue";
          break;

        case "inValue":
          if (unicode !== null) {
            unicode += ch;
            if (unicode.length === 4) {
              out += String.fromCharCode(parseInt(unicode, 16));
              unicode = null;
            }
          } else if (escaped) {
            escaped = false;
            if (ch === "u") unicode = "";
            else out += SIMPLE_ESCAPES[ch] ?? ch;
          } else if (ch === "\\") {
            escaped = true;
          } else if (ch === '"') {
            state = "done";
          } else {
            out += ch;
          }
          break;

        default:
          break;
      }
    }

    if (out) onText(out);
  };
}

/* -------------------------------------------------------------------------- */
/*                          Cleanup + language check                          */
/* -------------------------------------------------------------------------- */

function cleanSummary(text, category) {
  let s = String(text ?? "")
    .replace(/\\r\\n|\\n/g, "\n") // literal backslash-n the model may emit
    .replace(/\r\n?/g, "\n");

  if (category === "language") {
    return s
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Non-language subjects must be a single paragraph.
  return s.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

const DEVANAGARI_RE = /[\u0900-\u097F]/g;
const LETTER_RE = /\p{L}/gu;

function assertExpectedScript(summary, mainSubject) {
  const letters = summary.match(LETTER_RE)?.length ?? 0;

  if (!letters) throw new Error("Summary contains no text");

  const ratio = (summary.match(DEVANAGARI_RE)?.length ?? 0) / letters;
  const wantsHindi = /\b(hindi|sanskrit)\b/i.test(mainSubject);

  if (wantsHindi && ratio < 0.7) {
    throw new Error("Summary was not written in Hindi as required");
  }

  if (!wantsHindi && ratio > 0.1) {
    throw new Error("Summary was not written in English as required");
  }
}

/* -------------------------------------------------------------------------- */
/*                                Main service                                */
/* -------------------------------------------------------------------------- */

export async function generateSmartChapterSummary({
  className,
  mainSubject,
  bookName,
  category,
  chapter,
  onChunk,
}) {
  const promptArgs = {
    className,
    subject: mainSubject,
    bookName,
    chapter,
  };

  const systemPrompt =
    category === "language"
      ? buildLanguageSystemPrompt(promptArgs)
      : buildGeneralSystemPrompt(promptArgs);

  const stream = await importantQuestionsOpenAI.chat.completions.create({
    model: MODEL,
    stream: true,
    temperature: GENERATION_TEMPERATURE,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildUserPrompt(promptArgs) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "smart_chapter_summary",
        strict: true,
        schema: summaryResponseSchema,
      },
    },
  });

  let rawSummary = "";
  let pending = "";
  let chunkIndex = 0;
  let lastFlush = Date.now();
  let refusal = "";

  const flush = () => {
    if (!pending) return;

    const text = pending;
    pending = "";
    lastFlush = Date.now();

    if (typeof onChunk !== "function") return;

    try {
      onChunk({ index: chunkIndex++, text });
    } catch (error) {
      console.error(
        "[Smart Summary] onChunk failed:",
        error.message
      );
    }
  };

  const pushChunk = createSummaryExtractor((text) => {
    rawSummary += text;
    pending += text;

    if (
      pending.length >= MIN_CHUNK_CHARS ||
      Date.now() - lastFlush >= FLUSH_INTERVAL_MS
    ) {
      flush();
    }
  });

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;

    if (delta?.refusal) refusal += delta.refusal;
    if (delta?.content) pushChunk(delta.content);
  }

  flush();

  if (!rawSummary.trim()) {
    throw new Error(
      refusal
        ? `OpenAI refused the Smart Summary request: ${refusal}`
        : "OpenAI returned an empty Smart Summary response"
    );
  }

  const summary = cleanSummary(rawSummary, category);

  if (category === "language") {
    assertExpectedScript(summary, mainSubject);
  }

  console.log(
    `[Smart Summary] Generated ${summary.length} chars in ${chunkIndex} chunk(s)`
  );

  return { summary };
}