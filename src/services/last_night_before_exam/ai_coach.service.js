import { openai } from "../../utils/OpenAI.js";
import { getLanguageInfo } from "../../utils/last_night_before_exam/predicted_questions/language.js";
import {
  buildAICoachSystemPrompt,
  buildAICoachUserPrompt,
} from "../../utils/last_night_before_exam/ai_coach/prompt.js";
import { createStepExtractor } from "../../utils/last_night_before_exam/ai_coach/sections.js";
import {
  validateCoachStep,
  createStepTracker,
} from "../../utils/last_night_before_exam/ai_coach/validation.js";
import { REQUIRED_STEPS } from "../../utils/last_night_before_exam/ai_coach/cache.js";

const LOG = "[AI Coach]";

const MODEL = "gpt-4o-mini";
const TEMPERATURE = 0.3;
const MAX_COMPLETION_TOKENS = 1500;

// Later attempts only ask for the steps that are still missing.
const MAX_ATTEMPTS = 3;

/**
 * Generates the 6 revision steps as streamed Markdown ("## n" blocks).
 *
 * onStep({ index, item }) is called once per VALID step, strictly in priority
 * order, as soon as the step is ready. item = { priority, action, formula }.
 *
 * Returns { steps } with exactly REQUIRED_STEPS steps, or throws.
 */
export const generateAICoachOutput = async ({
  className,
  subject,
  chapter,
  bookName,
  category,
  onStep,
}) => {
  if (!className || !subject || !chapter) {
    throw new Error("className, subject and chapter are required.");
  }

  const languageInfo = getLanguageInfo(subject, bookName);
  const ctx = {
    languageKey: languageInfo?.key ?? null,
    devanagari:
      languageInfo?.key === "hindi" || languageInfo?.key === "sanskrit",
  };

  const promptArgs = {
    className,
    subject,
    chapter,
    bookName,
    category,
    languageInfo,
  };

  const systemPrompt = buildAICoachSystemPrompt(promptArgs);

  const steps = [];
  const tracker = createStepTracker();

  // Keeps onStep calls in order. A failed publish never blocks the rest.
  let emitChain = Promise.resolve();

  let received = 0;
  let rejectedCount = 0;
  let duplicateCount = 0;
  let lastError = "";

  const emitStep = (index, item) => {
    if (typeof onStep !== "function") return;

    emitChain = emitChain
      .then(() => onStep({ index, item }))
      .catch((error) => {
        console.error(
          `${LOG} onStep failed for step ${index + 1}:`,
          error?.message
        );
      });
  };

  const handleBlock = (block) => {
    received += 1;

    if (steps.length >= REQUIRED_STEPS) return;

    const result = validateCoachStep(block, ctx);

    if (result.warnings.length) {
      console.warn(`${LOG} Step warnings: ${result.warnings.join("; ")}`);
    }

    if (result.error) {
      rejectedCount += 1;
      lastError = result.error;
      console.warn(`${LOG} Rejected a step: ${result.error}`);
      return;
    }

    if (!tracker.register(result.step.action)) {
      duplicateCount += 1;
      return;
    }

    const index = steps.length;
    const item = { priority: index + 1, ...result.step };

    steps.push(item);
    emitStep(index, item);
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (steps.length >= REQUIRED_STEPS) break;

    const userPrompt = buildAICoachUserPrompt({
      ...promptArgs,
      existingActions: steps.map((s) => s.action),
    });

    try {
      const stream = await openai.chat.completions.create({
        model: MODEL,
        stream: true,
        temperature: TEMPERATURE,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      const extractor = createStepExtractor(handleBlock);
      let refusal = "";

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;

        if (delta?.refusal) refusal += delta.refusal;
        if (delta?.content) extractor.push(delta.content);
      }

      // Only reached when the stream finished cleanly, so the last block is
      // complete and can be flushed.
      extractor.end();

      if (refusal) lastError = `OpenAI refused the request: ${refusal}`;
    } catch (error) {
      lastError = error.message;
      console.error(
        `${LOG} Attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
        error.message
      );
    }

    // Wait for every onStep call still running before the next pass.
    await emitChain;

    if (steps.length < REQUIRED_STEPS && attempt < MAX_ATTEMPTS) {
      console.warn(
        `${LOG} Have ${steps.length}/${REQUIRED_STEPS} steps, retrying (attempt ${attempt + 1})`
      );
    }
  }

  console.log(
    `${LOG} received=${received}, rejected=${rejectedCount}, ` +
      `duplicates=${duplicateCount}, sent=${steps.length}`
  );

  if (steps.length < REQUIRED_STEPS) {
    throw new Error(
      `AI Coach generation produced ${steps.length}/${REQUIRED_STEPS} steps` +
        (lastError ? `: ${lastError}` : ". Please retry.")
    );
  }

  return { steps: steps.map((step) => ({ ...step })) };
};