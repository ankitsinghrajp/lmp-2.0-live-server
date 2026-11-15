import { openai } from "../../utils/OpenAI.js";

import { getLanguageInfo } from "../../utils/last_night_before_exam/predicted_questions/language.js";
// The stream extractor is generic ({"<key>":[{...},{...}]}), so it is shared
// with the Predicted Questions feature.
import { createQuestionExtractor } from "../../utils/last_night_before_exam/predicted_questions/streaming.js";
import { getMcqsSchema } from "../../utils/last_night_before_exam/mcqs/schema.js";
import {
  buildMCQsSystemPrompt,
  buildMCQsUserPrompt,
} from "../../utils/last_night_before_exam/mcqs/prompt.js";
import {
  sanitizeMcq,
  validateAndRepairMcq,
  createDuplicateTracker,
} from "../../utils/last_night_before_exam/mcqs/validation.js";

const LOG = "[MCQs]";

const MODEL = "gpt-4o-mini";
const TEMPERATURE = 0.3;
const MAX_COMPLETION_TOKENS = 5000;

// The model writes up to REQUESTED_MCQS (the prompt asks for 6), and only the
// first TARGET_MCQS that pass validation are kept. The spare one means a single
// MCQ failing validation does not leave the set short.
const REQUESTED_MCQS = 6;
const TARGET_MCQS = 5;

// An attempt that produces ZERO valid MCQs is retried once. Nothing has been
// sent to the client in that case, so a retry is safe.
const MAX_ATTEMPTS = 2;

/**
 * Generates chapter MCQs.
 *
 * Pipeline (same as Important / Predicted Questions):
 *   stream from the model -> pull each COMPLETE MCQ out of the stream ->
 *   sanitize -> dedupe -> validate / repair LaTeX in the background ->
 *   hand each valid MCQ to onMcq immediately.
 *
 * onMcq({ section: "mcqs", index, item }) is called once per valid MCQ as soon
 * as it is ready (index is its final position, 0-based). The returned value is
 *   { mcqs }   (same order as streamed)
 */
export const generateMCQsOutput = async ({
  className,
  subject,
  chapter,
  bookName,
  onMcq,
}) => {
  if (!className || !subject || !chapter) {
    throw new Error("className, subject and chapter are required.");
  }

  const languageInfo = getLanguageInfo(subject, bookName);
  const isLanguage = Boolean(languageInfo);
  const languageKey = languageInfo?.key ?? null;

  const promptArgs = { className, subject, chapter, bookName, languageInfo };

  const systemPrompt = buildMCQsSystemPrompt(promptArgs);
  const userPrompt = buildMCQsUserPrompt(promptArgs);
  const schema = getMcqsSchema(isLanguage);

  if (isLanguage) {
    console.log(
      `${LOG} ${languageInfo.label} detected (book: "${languageInfo.book}", chapter: "${chapter}")`
    );
  }

  const runAttempt = async (attempt) => {
    const tracker = createDuplicateTracker();
    const tasks = [];
    const emissions = [];
    const finalMcqs = [];

    let receivedCount = 0;
    let acceptedCount = 0;
    let rejectedCount = 0;
    let duplicateCount = 0;
    let unfixableCount = 0;
    let surplusCount = 0;
    let refusal = "";
    let streamError = null;

    const stream = await openai.chat.completions.create({
      model: MODEL,
      stream: true,
      temperature: TEMPERATURE,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: isLanguage ? "chapter_language_mcqs" : "chapter_mcqs",
          strict: true,
          schema,
        },
      },
    });

    const emitMcq = (mcq) => {
      // Only the first TARGET_MCQS valid ones are kept.
      if (finalMcqs.length >= TARGET_MCQS) {
        surplusCount += 1;
        return;
      }

      const index = finalMcqs.length;
      finalMcqs.push(mcq);

      if (typeof onMcq !== "function") return;

      emissions.push(
        Promise.resolve()
          .then(() => onMcq({ section: "mcqs", index, item: mcq }))
          .catch((error) => {
            console.error(
              `${LOG} onMcq failed for MCQ ${index + 1}:`,
              error.message
            );
          })
      );
    };

    const processMcq = async (mcq, index) => {
      let fixed = null;

      try {
        fixed = await validateAndRepairMcq(mcq, index, {
          client: openai,
          model: MODEL,
          isLanguage,
          languageKey,
        });
      } catch (error) {
        console.error(
          `${LOG} Validation crashed for MCQ ${index + 1}:`,
          error.message
        );
      }

      if (fixed) {
        emitMcq(fixed);
      } else {
        unfixableCount += 1;
      }
    };

    const handleStreamedMcq = (rawMcq) => {
      receivedCount += 1;

      if (process.env.DEBUG_MCQS) {
        console.log(
          `${LOG} raw ${receivedCount}:`,
          JSON.stringify(rawMcq).slice(0, 400)
        );
      }

      if (acceptedCount >= REQUESTED_MCQS) return;

      const mcq = sanitizeMcq(rawMcq, { isLanguage });

      if (!mcq) {
        rejectedCount += 1;
        return;
      }

      if (!tracker.register(mcq.question)) {
        duplicateCount += 1;
        return;
      }

      const index = acceptedCount;
      acceptedCount += 1;

      // Not awaited: this MCQ is checked / repaired while the model keeps
      // generating the next ones.
      tasks.push(processMcq(mcq, index));
    };

    const pushChunk = createQuestionExtractor(handleStreamedMcq);

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;

        if (delta?.refusal) refusal += delta.refusal;
        if (delta?.content) pushChunk(delta.content);
      }
    } catch (error) {
      // Keep whatever was already completed; the caller decides what to do.
      streamError = error;
      console.error(`${LOG} Stream error on attempt ${attempt}:`, error.message);
    }

    // Wait for repairs and for every onMcq call that is still running.
    await Promise.all(tasks);
    await Promise.all(emissions);

    console.log(
      `${LOG} Attempt ${attempt}: received=${receivedCount}, ` +
        `rejected=${rejectedCount}, duplicates=${duplicateCount}, ` +
        `unfixable=${unfixableCount}, surplus=${surplusCount}, ` +
        `sent=${finalMcqs.length}`
    );

    return { finalMcqs, refusal, streamError, receivedCount };
  };

  let result = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const attemptResult = await runAttempt(attempt);

      if (attemptResult.finalMcqs.length) {
        result = attemptResult;
        break;
      }

      lastError = new Error(
        attemptResult.refusal
          ? `OpenAI refused the request: ${attemptResult.refusal}`
          : attemptResult.streamError?.message ||
              (attemptResult.receivedCount
                ? "No valid MCQs could be produced"
                : "OpenAI returned an empty response")
      );
    } catch (error) {
      lastError = error;
      console.error(`${LOG} Attempt ${attempt} failed:`, error.message);
    }

    if (attempt < MAX_ATTEMPTS) {
      console.warn(`${LOG} Retrying generation (attempt ${attempt + 1})`);
    }
  }

  if (!result) {
    throw new Error(
      `MCQs generation failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`
    );
  }

  if (result.finalMcqs.length < TARGET_MCQS) {
    console.warn(
      `${LOG} Only ${result.finalMcqs.length} valid MCQs (target ${TARGET_MCQS})`
    );
  }

  return { mcqs: result.finalMcqs };
};