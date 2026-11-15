import { openai } from "../utils/OpenAI.js";

import { parseSubject, detectCategory } from "../utils/helper.js";

import {
  quizResponseSchema,
} from "../utils/mcq-fill-ups/schema.js";

import {
  buildQuizSystemPrompt,
  buildQuizUserPrompt,
  buildRepairUserPrompt,
} from "../utils/mcq-fill-ups/prompt.js";

import {
  validateQuestion,
  MIN_QUESTIONS,
} from "../utils/mcq-fill-ups/validation.js";

const MODEL = "gpt-4o-mini";

// Only the questions that failed are rewritten, so a repair round is small
// and cheap. After this many rounds a still-invalid question is dropped.
const MAX_REPAIR_ROUNDS = 2;
const MAX_COMPLETION_TOKENS = 8192;

/* -------------------------------------------------------------------------- */
/*                         Streaming question extractor                       */
/* -------------------------------------------------------------------------- */

/**
 * Pulls COMPLETE question objects out of a streamed
 * {"questions":[{...},{...}]} response, one at a time, as soon as each
 * object's closing brace arrives.
 *
 * - Finds the array by its key ("questions").
 * - String/escape aware, so braces inside question text never matter.
 */
function createQuestionExtractor(onQuestionObject) {
  let inString = false;
  let escaped = false;
  let currentString = "";
  let lastKey = "";
  let nest = 0; // object/array nesting before the questions array
  let arrayStarted = false;
  let done = false;
  let depth = 0; // object depth inside the questions array
  let buffer = "";

  return function push(chunk) {
    for (const ch of chunk) {
      if (done) return;

      // ---- Before the questions array: look for  "questions": [
      if (!arrayStarted) {
        if (inString) {
          if (escaped) {
            escaped = false;
            currentString += ch;
          } else if (ch === "\\") {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
            lastKey = currentString;
          } else {
            currentString += ch;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          currentString = "";
        } else if (ch === "{") {
          nest += 1;
        } else if (ch === "}") {
          nest -= 1;
        } else if (ch === "[") {
          if (nest === 1 && lastKey === "questions") arrayStarted = true;
          else nest += 1;
        } else if (ch === "]") {
          nest -= 1;
        }
        continue;
      }

      // ---- Between question objects
      if (depth === 0) {
        if (ch === "{") {
          depth = 1;
          buffer = "{";
        } else if (ch === "]") {
          done = true; // end of the questions array
        }
        continue;
      }

      // ---- Inside a question object
      buffer += ch;

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;

        if (depth === 0) {
          let parsed = null;

          try {
            parsed = JSON.parse(buffer);
          } catch (error) {
            console.error(
              "[Quiz] Skipped an unparseable streamed question:",
              error.message
            );
          }

          buffer = "";
          if (parsed) onQuestionObject(parsed);
        }
      }
    }
  };
}

/* -------------------------------------------------------------------------- */
/*                        Per-question collector (validate)                   */
/* -------------------------------------------------------------------------- */

// Unicode-safe duplicate key (keeps Devanagari letters, marks and digits).
const dedupeKey = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();

/**
 * Checks every question the moment it arrives.
 *  - valid     -> numbered, collected and published immediately
 *  - invalid   -> kept (with its problems) so ONLY it is rewritten later
 *  - duplicate -> silently dropped
 *
 * `existing` holds the questions accepted in earlier steps, so numbering and
 * duplicate checks continue across the main call and the repair calls.
 */
function createCollector({ subject, existing = [], onAccepted }) {
  const seen = new Set(existing.map((q) => dedupeKey(q.question)));
  let nextId = existing.reduce((max, q) => Math.max(max, q.id ?? 0), 0) + 1;

  const accepted = [];
  const failed = [];

  return {
    accepted,
    failed,

    add(raw) {
      const result = validateQuestion(raw, { subject });

      if (!result.question) return; // not even an object: nothing to repair

      if (!result.valid) {
        failed.push({ question: result.question, issues: result.issues });
        return;
      }

      const key = dedupeKey(result.question.question);
      if (seen.has(key)) return;
      seen.add(key);

      const item = { id: nextId, ...result.question };
      nextId += 1;

      accepted.push(item);
      onAccepted(item);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                              OpenAI generation                             */
/* -------------------------------------------------------------------------- */

/**
 * One streamed OpenAI call (the main generation OR a repair).
 *
 * Valid questions are handed to `onQuestion({ index, item })` as soon as they
 * are complete. Everything that publishes lives INSIDE the step, so it runs
 * once and is not repeated when Inngest re-invokes the function.
 *
 * Returns { accepted, failed } (plain data, safe to store as a step result).
 */
async function runQuestionStep({
  messages,
  subject,
  existing,
  step,
  stepName,
  onQuestion,
}) {
  const run = async () => {
    // Callbacks run one after another, in order, and never break generation.
    let emitChain = Promise.resolve();

    const emit = (payload) => {
      if (typeof onQuestion !== "function") return;

      emitChain = emitChain
        .then(() => onQuestion(payload))
        .catch((error) => {
          console.error("[Quiz] Stream callback failed:", error?.message);
        });
    };

    const collector = createCollector({
      subject,
      existing,
      onAccepted: (item) => emit({ index: item.id - 1, item }),
    });

    const stream = await openai.chat.completions.create({
      model: MODEL,
      stream: true,
      messages,

      response_format: {
        type: "json_schema",
        json_schema: {
          name: "cbse_quiz",
          strict: true,
          schema: quizResponseSchema,
        },
      },

      max_completion_tokens: MAX_COMPLETION_TOKENS,
    });

    let refusal = "";
    let finishReason = null;
    let received = 0;

    const push = createQuestionExtractor((raw) => {
      received += 1;
      collector.add(raw);
    });

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.refusal) refusal += choice.delta.refusal;
      if (choice.delta?.content) push(choice.delta.content);
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    // Make sure every question has been published before the step ends.
    await emitChain;

    if (refusal && received === 0) {
      throw new Error(`OpenAI refused quiz generation: ${refusal}`);
    }

    // A cut-off response is fine: every complete question was already kept.
    if (finishReason === "length") {
      console.warn(
        `[Quiz] ${stepName} hit the token limit after ${received} question(s).`
      );
    }

    return {
      accepted: collector.accepted,
      failed: collector.failed,
    };
  };

  return step ? await step.run(stepName, run) : await run();
}

/* -------------------------------------------------------------------------- */
/*                                Main service                                */
/* -------------------------------------------------------------------------- */

/**
 * Main quiz generation service.
 *
 * @param {object}   args
 * @param {object}   args.eventData
 * @param {object}   args.step        Inngest step tools
 * @param {Function} args.onQuestion  async ({ index, item }) => void
 *                                    called only for questions that PASSED validation
 */
export async function generateQuizOutput({
  eventData,
  step,
  onQuestion,
}) {
  const {
    className,
    subject,
    chapter,
    index = [],
    difficulty = "Medium",
  } = eventData;

  if (!className || !subject || !chapter) {
    throw new Error(
      "className, subject and chapter are required."
    );
  }

  if (!Array.isArray(index)) {
    throw new Error("index must be an array.");
  }

  const { mainSubject, bookName } =
    parseSubject(subject);

  const category = detectCategory(mainSubject);

  console.log("[Quiz] Starting generation", {
    className,
    subject: mainSubject,
    chapter,
    difficulty,
    selectedTopics: index.length,
  });

  // 1. Build prompts.
  const systemPrompt = buildQuizSystemPrompt({
    subject: mainSubject,
  });

  const userPrompt = buildQuizUserPrompt({
    className,
    subject,
    mainSubject,
    bookName,
    chapter,
    category,
    difficulty,
    index,
  });

  if (process.env.DEBUG_QUIZ) {
    console.log("[Quiz] SYSTEM PROMPT:\n", systemPrompt);
    console.log("[Quiz] USER PROMPT:\n", userPrompt);
  }

  // 2. Main generation. Every question is checked on its own as it arrives.
  const first = await runQuestionStep({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    subject: mainSubject,
    existing: [],
    step,
    stepName: "Generate Quiz Questions",
    onQuestion,
  });

  let accepted = first.accepted;
  let failed = first.failed;

  // 3. Rewrite ONLY the questions that failed (never the whole quiz).
  for (
    let round = 1;
    round <= MAX_REPAIR_ROUNDS && failed.length > 0;
    round++
  ) {
    console.warn(
      `[Quiz] Repair round ${round}: rewriting ${failed.length} question(s)`,
      failed.map((item) => item.issues)
    );

    const repaired = await runQuestionStep({
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: buildRepairUserPrompt({
            className,
            subject,
            mainSubject,
            chapter,
            failed,
            existingQuestions: accepted,
          }),
        },
      ],
      subject: mainSubject,
      existing: accepted,
      step,
      stepName: `Repair Quiz Questions ${round}`,
      onQuestion,
    });

    accepted = [...accepted, ...repaired.accepted];
    failed = repaired.failed;
  }

  if (failed.length > 0) {
    console.warn(
      `[Quiz] Dropped ${failed.length} question(s) that could not be fixed.`
    );
  }

  // 4. The quiz only fails when almost nothing usable was produced.
  if (accepted.length < MIN_QUESTIONS) {
    throw new Error(
      `Quiz generation produced only ${accepted.length} valid question(s).`
    );
  }

  console.log("[Quiz] Generation finished", {
    className,
    subject: mainSubject,
    chapter,
    questions: accepted.length,
  });

  return {
    chapter,
    class: String(className),
    subject: mainSubject,
    questions: accepted,
  };
}