import { openai } from "../OpenAI.js";

// Chunks are batched so we do not publish one realtime message per token.
const DEFAULT_FLUSH_CHARS = 40;
const DEFAULT_FLUSH_MS = 150;

/**
 * One streamed OpenAI call (first attempt OR a repair round).
 * Everything that publishes lives INSIDE the step, so it runs once and is
 * not repeated when Inngest re-invokes the function.
 *
 * Shared by the summarizer and the visual generator.
 * Returns { text } (plain data, safe to store as a step result).
 */
export async function runStreamStep({
  messages,
  model,
  maxTokens,
  temperature = 0.3,
  step,
  stepName,
  onChunk,
  onReset,
  logTag = "Stream",
  flushChars = DEFAULT_FLUSH_CHARS,
  flushMs = DEFAULT_FLUSH_MS,
}) {
  const run = async () => {
    // Tell the client to discard anything streamed so far (repair or retry).
    if (typeof onReset === "function") {
      try {
        await onReset();
      } catch (error) {
        console.error(`[${logTag}] Reset callback failed:`, error?.message);
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
          console.error(`[${logTag}] Chunk callback failed:`, error?.message);
        });
    };

    const stream = await openai.chat.completions.create({
      model,
      stream: true,
      messages,
      temperature,
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

        if (pending.length >= flushChars || Date.now() - lastFlush >= flushMs) {
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
      console.warn(`[${logTag}] ${stepName} hit the token limit.`);
    }

    return { text: full };
  };

  return step ? await step.run(stepName, run) : await run();
}