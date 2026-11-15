import { openai } from "../../utils/OpenAI.js";
import {
  BLOCK_REPAIR_SYSTEM_PROMPT,
  buildImportantTopicsSystemPrompt,
  buildImportantTopicsUserPrompt,
} from "../../utils/last_night_before_exam/important_topics/prompt.js";

import { createMarkdownSectionExtractor } from "../../utils/last_night_before_exam/important_topics/sections.js";
import {
  cleanBlock,
  collectBlockProblems,
  detectLanguage,
  digitsOf,
  dropDisplayFormula,
  getBlockName,
  getHardProblem,
  normalizeTopicKey,
} from "../../utils/last_night_before_exam/important_topics/validation.js";

const MODEL = "gpt-4o-mini";
const LOG = "[Important Topics]";

const TARGET_TOPICS = 6; // what the UI wants
const MIN_TOPICS = 4; // below this the job fails (set to 6 to be strict)
const EXTRA_TOPICS = 2; // over-generate so one bad topic costs nothing
const MAX_GENERATION_ATTEMPTS = 3; // later attempts only ask for what is missing
const MAX_REPAIR_ATTEMPTS = 2; // LLM LaTeX repairs per topic block
const GENERATION_TEMPERATURE = 0.2;

/* -------------------------------------------------------------------------- */
/*                               LaTeX repair                                 */
/* -------------------------------------------------------------------------- */

/**
 * Asks the model to fix ONE block (plain-text answer, so no JSON escaping).
 * The fix is rejected if it changes any digit (guards against changed values).
 */
async function repairBlockWithLlm(block, problems) {
  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: BLOCK_REPAIR_SYSTEM_PROMPT },
      {
        role: "user",
        content: `PROBLEMS:\n${problems.join("\n")}\n\nBLOCK:\n${block}`,
      },
    ],
  });

  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Block repair returned an empty response");

  if (digitsOf(content) !== digitsOf(block)) {
    console.warn(`${LOG} Repair rejected for "${getBlockName(block)}": numbers changed`);
    return block;
  }

  return content;
}

/** The display formula is optional: drop it and re-check the rest. */
function salvage(block, language) {
  const stripped = dropDisplayFormula(block);
  return collectBlockProblems(stripped, language).length ? null : stripped;
}

/**
 * clean (already done) -> KaTeX check -> (LLM repair -> clean -> check) x N
 * -> drop the formula if it is still broken. Returns a valid block or null.
 */
async function validateAndRepairBlock(block, language) {
  let current = block;

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const problems = collectBlockProblems(current, language);

    if (!problems.length) {
      if (attempt > 0) {
        console.log(`${LOG} "${getBlockName(current)}" repaired after ${attempt} attempt(s)`);
      }
      return current;
    }

    if (attempt === MAX_REPAIR_ATTEMPTS) return salvage(current, language);

    try {
      const repaired = await repairBlockWithLlm(current, problems);
      current = cleanBlock(repaired, language) ?? current;
    } catch (error) {
      console.error(`${LOG} Repair call failed for "${getBlockName(current)}":`, error.message);
      return salvage(current, language);
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*                                 Streaming                                  */
/* -------------------------------------------------------------------------- */

/** Streams one generation pass; every complete "## " block goes to onSection. */
async function streamBlocks({ systemPrompt, userPrompt, onSection }) {
  const stream = await openai.chat.completions.create({
    model: MODEL,
    stream: true,
    temperature: GENERATION_TEMPERATURE,
    max_completion_tokens: 4000,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const extractor = createMarkdownSectionExtractor(onSection);
  let refusal = "";

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;

    if (delta?.refusal) refusal += delta.refusal;
    if (delta?.content) extractor.push(delta.content);
  }

  extractor.end();
  return refusal;
}

/* -------------------------------------------------------------------------- */
/*                                Main service                                */
/* -------------------------------------------------------------------------- */

/**
 * @param subject      main subject (cache key subject), e.g. "Hindi"
 * @param fullSubject  raw subject as the user sent it, e.g. "Hindi: Kshitij Part 2"
 * @param onChunk      async ({ index, markdown }) called once per VALID topic
 *                     block, strictly in order
 * @returns { markdown, topicCount } where markdown is the whole sheet
 */
export const generateImportantTopicsOutput = async ({
  className,
  subject,
  fullSubject,
  chapter,
  onChunk,
}) => {
  if (!className || !subject || !chapter) {
    throw new Error("className, subject and chapter are required.");
  }

  const displaySubject = fullSubject || subject;
  const language = detectLanguage(displaySubject) ?? detectLanguage(subject);
  const systemPrompt = buildImportantTopicsSystemPrompt({
    className,
    subject: displaySubject,
    chapter,
    language,
  });

  const blocks = []; // valid blocks, in the order they were sent to the client
  const claimed = new Set(); // duplicate keys (accepted + in flight)

  let emitChain = Promise.resolve(); // keeps chunk order even if repairs finish out of order
  let reserved = 0; // accepted + currently being validated/repaired
  let received = 0;
  let rejectedCount = 0;
  let duplicateCount = 0;
  let unfixableCount = 0;
  let lastError = "";

  const emitBlock = async (block) => {
    const index = blocks.length;
    blocks.push(block);

    if (typeof onChunk !== "function") return;

    try {
      await onChunk({ index, markdown: block });
    } catch (error) {
      console.error(`${LOG} onChunk failed for topic ${index + 1}:`, error.message);
    }
  };

  const handleSection = (rawSection) => {
    received += 1;

    if (reserved >= TARGET_TOPICS) return;

    const cleaned = cleanBlock(rawSection, language);
    if (!cleaned) {
      rejectedCount += 1;
      return;
    }

    const problem = getHardProblem(cleaned, language);
    if (problem) {
      rejectedCount += 1;
      console.warn(`${LOG} Rejected "${getBlockName(cleaned)}": ${problem}`);
      return;
    }

    const key = normalizeTopicKey(getBlockName(cleaned));
    if (!key || claimed.has(key)) {
      duplicateCount += 1;
      return;
    }

    claimed.add(key);
    reserved += 1;

    // Validation/repair starts now (while the model keeps writing), but the
    // result is emitted through the chain so the sheet stays in order.
    const task = validateAndRepairBlock(cleaned, language).catch((error) => {
      console.error(`${LOG} Validation crashed for "${getBlockName(cleaned)}":`, error.message);
      return null;
    });

    emitChain = emitChain.then(async () => {
      const fixed = await task;

      if (!fixed) {
        claimed.delete(key);
        reserved -= 1;
        unfixableCount += 1;
        return;
      }

      await emitBlock(fixed);
    });
  };

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const needed = TARGET_TOPICS - blocks.length;
    if (needed <= 0) break;

    const userPrompt = buildImportantTopicsUserPrompt({
      className,
      subject: displaySubject,
      chapter,
      count: needed + EXTRA_TOPICS,
      existingTopics: blocks.map(getBlockName),
    });

    try {
      const refusal = await streamBlocks({
        systemPrompt,
        userPrompt,
        onSection: handleSection,
      });

      if (refusal) lastError = `OpenAI refused the request: ${refusal}`;
    } catch (error) {
      lastError = error.message;
      console.error(
        `${LOG} Generation attempt ${attempt}/${MAX_GENERATION_ATTEMPTS} failed:`,
        error.message
      );
    }

    // Wait for repairs/emits still running, so `blocks` is final before the next pass.
    await emitChain;
  }

  console.log(
    `${LOG} Received=${received}, rejected=${rejectedCount}, ` +
      `duplicates=${duplicateCount}, unfixable=${unfixableCount}, sent=${blocks.length}`
  );

  if (blocks.length < MIN_TOPICS) {
    throw new Error(
      lastError
        ? `Could not generate enough valid topics: ${lastError}`
        : "Could not generate enough valid topics. Please retry."
    );
  }

  const finalBlocks = blocks.slice(0, TARGET_TOPICS);

  return {
    markdown: finalBlocks.join("\n\n"),
    topicCount: finalBlocks.length,
  };
};