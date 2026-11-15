import { openai } from "../utils/OpenAI.js";

import {
  buildSummarizerSystemPrompt,
  buildSummarizerUserPrompt,
} from "../utils/summarizer/prompt.js";

import { validateSummary } from "../utils/summarizer/validation.js";

const MODEL = "gpt-4o-mini";

// Longer answers need a bigger budget (Hindi uses more tokens per word).
const MAX_TOKENS_BY_LEVEL = { Short: 1200, Medium: 2500, Long: 4096 };

// Rewrite rounds after the first attempt (only used when validation fails).
const MAX_REPAIR_ROUNDS = 2;

// Send the (already shrunk) image to the model as well as the OCR text.
const SEND_IMAGE_TO_MODEL = true;

// Chunks are batched so we do not publish one realtime message per token.
const FLUSH_CHARS = 40;
const FLUSH_MS = 150;

/**
 * One streamed OpenAI call (the first attempt OR a repair).
 * Everything that publishes lives INSIDE the step, so it runs once and is
 * not repeated when Inngest re-invokes the function.
 *
 * Returns { text } (plain data, safe to store as a step result).
 */
async function runStreamStep({
  messages,
  maxTokens,
  step,
  stepName,
  onChunk,
  onReset,
}) {
  const run = async () => {
    // A repair round starts by telling the client to discard the old text.
    if (typeof onReset === "function") {
      try {
        await onReset();
      } catch (error) {
        console.error("[Summarizer] Reset callback failed:", error?.message);
      }
    }

    let sequence = 0;
    let pending = "";
    let lastFlush = Date.now();
    let chain = Promise.resolve();
    let full = "";
    let refusal = "";
    let finishReason = null;

    // Callbacks run in order and never break generation.
    const flush = () => {
      if (!pending || typeof onChunk !== "function") {
        pending = "";
        return;
      }

      const text = pending;
      const index = sequence;
      pending = "";
      sequence += 1;
      lastFlush = Date.now();

      chain = chain
        .then(() => onChunk({ index, text }))
        .catch((error) => {
          console.error("[Summarizer] Chunk callback failed:", error?.message);
        });
    };

    const stream = await openai.chat.completions.create({
      model: MODEL,
      stream: true,
      messages,
      temperature: 0.3,
      max_completion_tokens: maxTokens,
    });

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.refusal) refusal += choice.delta.refusal;

      const delta = choice.delta?.content;
      if (delta) {
        full += delta;
        pending += delta;

        if (pending.length >= FLUSH_CHARS || Date.now() - lastFlush >= FLUSH_MS) {
          flush();
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    flush();
    await chain;

    if (refusal && !full.trim()) {
      throw new Error(`OpenAI refused the request: ${refusal}`);
    }

    if (finishReason === "length") {
      console.warn(`[Summarizer] ${stepName} hit the token limit.`);
    }

    return { text: full };
  };

  return step ? await step.run(stepName, run) : await run();
}

function buildMessages({ systemPrompt, userPrompt, imageBase64 }) {
  const content =
    SEND_IMAGE_TO_MODEL && imageBase64
      ? [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`,
              detail: "auto",
            },
          },
        ]
      : userPrompt;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content },
  ];
}

/**
 * @param {object}   args
 * @param {object}   args.eventData  { topic, level, difficulty, mode, extractedText, labels, imageBase64 }
 * @param {object}   args.step       Inngest step tools
 * @param {Function} args.onChunk    async ({ index, text }) => void
 * @param {Function} args.onReset    async () => void  (called before each repair round)
 */
export async function generateSummarizerOutput({
  eventData,
  step,
  onChunk,
  onReset,
}) {
  const {
    topic = "",
    level = "Medium",
    difficulty = "Medium",
    mode = "no_image",
    extractedText = "",
    labels = [],
    imageBase64 = "",
  } = eventData;

  if (!topic.trim() && !extractedText.trim() && !imageBase64) {
    throw new Error("A topic or an image is required.");
  }

  console.log("[Summarizer] Starting generation", {
    hasTopic: Boolean(topic.trim()),
    hasImage: Boolean(imageBase64),
    level,
    difficulty,
    mode,
  });

  const systemPrompt = buildSummarizerSystemPrompt();
  const maxTokens = MAX_TOKENS_BY_LEVEL[level] ?? MAX_TOKENS_BY_LEVEL.Medium;

  let previousResponse = "";
  let validationErrors = [];

  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
    const userPrompt = buildSummarizerUserPrompt({
      topic,
      level,
      difficulty,
      mode,
      extractedText,
      labels,
      previousResponse,
      validationErrors,
    });

    const { text } = await runStreamStep({
      messages: buildMessages({ systemPrompt, userPrompt, imageBase64 }),
      maxTokens,
      step,
      stepName: round === 0 ? "Generate Summary" : `Repair Summary ${round}`,
      onChunk,
      onReset: round === 0 ? undefined : onReset,
    });

    // Free fixes run first, then the strict checks.
    const validation = validateSummary({ summary: text });

    if (validation.valid) {
      console.log("[Summarizer] Validation successful");
      return { summary: validation.text };
    }

    console.warn(`[Summarizer] Validation failed (round ${round}):`, validation.issues);

    previousResponse = validation.text || text;
    validationErrors = validation.issues;
  }

  throw new Error(
    `Generated summary failed validation: ${validationErrors.join(" | ")}`
  );
}