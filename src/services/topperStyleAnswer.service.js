import { openai } from "../utils/OpenAI.js";

import {
  buildTopperSystemPrompt,
  buildTopperUserPrompt,
} from "../utils/topper_style_answer/prompt.js";

import { validateTopperAnswer } from "../utils/topper_style_answer/validation.js";

const MODEL = "gpt-4o-mini";
const MAX_COMPLETION_TOKENS = 2048;

// Rewrite rounds after the first attempt (only used when validation fails).
const MAX_REPAIR_ROUNDS = 2;

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
async function runStreamStep({ messages, step, stepName, onChunk, onReset }) {
  const run = async () => {
    // A repair round starts by telling the client to discard the old text.
    if (typeof onReset === "function") {
      try {
        await onReset();
      } catch (error) {
        console.error("[Topper] Reset callback failed:", error?.message);
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
          console.error("[Topper] Chunk callback failed:", error?.message);
        });
    };

    const stream = await openai.chat.completions.create({
      model: MODEL,
      stream: true,
      messages,
      temperature: 0.2,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
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
      console.warn(`[Topper] ${stepName} hit the token limit.`);
    }

    return { text: full };
  };

  return step ? await step.run(stepName, run) : await run();
}

function buildMessages({ systemPrompt, userPrompt }) {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

/**
 * @param {object}   args
 * @param {object}   args.eventData  { question, className, subject, bookName, chapter }
 * @param {object}   args.step       Inngest step tools
 * @param {Function} args.onChunk    async ({ index, text }) => void
 * @param {Function} args.onReset    async () => void  (called before each repair round)
 */
export async function generateTopperAnswerOutput({
  eventData,
  step,
  onChunk,
  onReset,
}) {
  const {
    question = "",
    className = "",
    subject = "",
    bookName = "",
    chapter = "",
  } = eventData;

  if (!question.trim()) {
    throw new Error("A question is required.");
  }

  console.log("[Topper] Starting generation", { subject, className, chapter });

  const systemPrompt = buildTopperSystemPrompt({ subject });

  let previousResponse = "";
  let validationErrors = [];
  let lastValidation = null;

  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
    const userPrompt = buildTopperUserPrompt({
      question,
      className,
      subject,
      bookName,
      chapter,
      previousResponse,
      validationErrors,
    });

    const { text } = await runStreamStep({
      messages: buildMessages({ systemPrompt, userPrompt }),
      step,
      stepName: round === 0 ? "Generate Answer" : `Repair Answer ${round}`,
      onChunk,
      onReset: round === 0 ? undefined : onReset,
    });

    // Free fixes (fences, math delimiters, symbols) run first, then checks.
    const validation = await validateTopperAnswer({
      answer: text,
      subject,
      question,
    });

    lastValidation = validation;

    if (validation.valid) {
      console.log("[Topper] Validation successful");
      return { answer: validation.text };
    }

    console.warn(`[Topper] Validation failed (round ${round}):`, validation.issues);

    previousResponse = validation.text || text;
    validationErrors = validation.issues;
  }

  // Out of repair rounds. Soft problems (length, formatting) are accepted,
  // blocking problems (broken LaTeX, wrong language, empty) are not.
  if (lastValidation && lastValidation.blocking.length === 0 && lastValidation.text) {
    console.warn("[Topper] Accepting answer with soft issues:", lastValidation.issues);
    return { answer: lastValidation.text };
  }

  throw new Error(
    `Generated answer failed validation: ${validationErrors.join(" | ")}`
  );
}