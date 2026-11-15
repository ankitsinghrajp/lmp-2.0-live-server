import { openai } from "../../utils/OpenAI.js";
import { getLanguageInfo } from "../../utils/last_night_before_exam/predicted_questions/language.js";
import {
  BLOCK_REPAIR_SYSTEM_PROMPT,
  buildMemoryBoosterSystemPrompt,
  buildMemoryBoosterUserPrompt,
} from "../../utils/last_night_before_exam/memory_boosters/prompt.js";
// Generic "## " block splitter, shared with Important Topics.
import { createMarkdownSectionExtractor } from "../../utils/last_night_before_exam/important_topics/sections.js";
import {
  TYPE_ORDER,
  cleanBlock,
  collectBlockProblems,
  degradeBrokenMath,
  digitsOf,
  getBlockName,
  getBlockType,
  getHardProblem,
} from "../../utils/last_night_before_exam/memory_boosters/validation.js";

const MODEL = "gpt-4o-mini";
const LOG = "[Memory Booster]";

const MAX_GENERATION_ATTEMPTS = 3; // later attempts only ask for the missing boosters
const MAX_REPAIR_ATTEMPTS = 2; // LLM LaTeX repairs per block
const GENERATION_TEMPERATURE = 0.4;

/* -------------------------------------------------------------------------- */
/*                               LaTeX repair                                 */
/* -------------------------------------------------------------------------- */

/** Asks the model to fix ONE block. Rejected if any digit changes. */
async function repairBlockWithLlm(block, problems) {
  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: BLOCK_REPAIR_SYSTEM_PROMPT },
      { role: "user", content: `PROBLEMS:\n${problems.join("\n")}\n\nBLOCK:\n${block}` },
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

/** Degrade broken math to plain text so the booster is never lost to LaTeX. */
function salvage(block, ctx) {
  const degraded = degradeBrokenMath(block);
  return collectBlockProblems(degraded, ctx).length ? null : degraded;
}

/** clean -> KaTeX check -> (LLM repair -> clean -> check) x N -> degrade. */
async function validateAndRepairBlock(block, ctx) {
  let current = block;

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const problems = collectBlockProblems(current, ctx);

    if (!problems.length) {
      if (attempt > 0) {
        console.log(`${LOG} "${getBlockName(current)}" repaired after ${attempt} attempt(s)`);
      }
      return current;
    }

    if (attempt === MAX_REPAIR_ATTEMPTS) return salvage(current, ctx);

    try {
      const repaired = await repairBlockWithLlm(current, problems);
      current = cleanBlock(repaired, ctx) ?? current;
    } catch (error) {
      console.error(`${LOG} Repair call failed for "${getBlockName(current)}":`, error.message);
      return salvage(current, ctx);
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
    max_completion_tokens: 2000,
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
 * @param subject      main subject, e.g. "Hindi"
 * @param fullSubject  raw subject as the user sent it, e.g. "Hindi: Kshitij Part 2"
 * @param onChunk      async ({ index, markdown }) called once per VALID booster
 *                     block, strictly in generation order
 * @returns { markdown, boosterCount } where markdown is the whole sheet
 *          (Acronym, Story, Pattern, always in that order)
 */
export const generateMemoryBoosterOutput = async ({
  className,
  subject,
  fullSubject,
  chapter,
  bookName,
  onChunk,
}) => {
  if (!className || !subject || !chapter) {
    throw new Error("className, subject and chapter are required.");
  }

  const displaySubject = fullSubject || subject;
  const info = getLanguageInfo(displaySubject, bookName);

  // Make sure a language prompt always has a book name.
  const languageInfo = info
    ? {
        ...info,
        book:
          info.book ||
          (displaySubject.includes(":")
            ? displaySubject.slice(displaySubject.indexOf(":") + 1).trim()
            : "") ||
          "the prescribed NCERT/CBSE textbook",
      }
    : null;

  const ctx = {
    isLanguage: Boolean(languageInfo),
    devanagari: languageInfo?.key === "hindi" || languageInfo?.key === "sanskrit",
  };

  const promptArgs = {
    className,
    subject: displaySubject,
    chapter,
    bookName,
    languageInfo,
  };
  const systemPrompt = buildMemoryBoosterSystemPrompt(promptArgs);

  const blocks = []; // valid blocks, in the order they were sent to the client
  const claimed = new Set(); // booster types (accepted + in flight)

  let emitChain = Promise.resolve(); // keeps chunk order even if repairs finish out of order
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
      console.error(`${LOG} onChunk failed for block ${index + 1}:`, error.message);
    }
  };

  const handleSection = (rawSection) => {
    received += 1;

    const cleaned = cleanBlock(rawSection, ctx);
    if (!cleaned) {
      rejectedCount += 1;
      return;
    }

    const type = getBlockType(cleaned);

    if (claimed.has(type)) {
      duplicateCount += 1;
      return;
    }

    const problem = getHardProblem(cleaned, ctx);
    if (problem) {
      rejectedCount += 1;
      console.warn(`${LOG} Rejected "${type}": ${problem}`);
      lastError = problem;
      return;
    }

    claimed.add(type);

    // Validation/repair starts now (while the model keeps writing), but the
    // result is emitted through the chain so the sheet stays in order.
    const task = validateAndRepairBlock(cleaned, ctx).catch((error) => {
      console.error(`${LOG} Validation crashed for "${type}":`, error.message);
      return null;
    });

    emitChain = emitChain.then(async () => {
      const fixed = await task;

      if (!fixed) {
        claimed.delete(type);
        unfixableCount += 1;
        return;
      }

      await emitBlock(fixed);
    });
  };

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const missingTypes = TYPE_ORDER.filter((type) => !claimed.has(type));
    if (!missingTypes.length) break;

    const userPrompt = buildMemoryBoosterUserPrompt({ ...promptArgs, missingTypes });

    try {
      const refusal = await streamBlocks({ systemPrompt, userPrompt, onSection: handleSection });
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

  if (blocks.length < TYPE_ORDER.length) {
    throw new Error(
      lastError
        ? `Could not generate all 3 memory boosters: ${lastError}`
        : "Could not generate all 3 memory boosters. Please retry."
    );
  }

  // Final sheet always in the same order, whatever order the model used.
  const ordered = [...blocks].sort(
    (a, b) => TYPE_ORDER.indexOf(getBlockType(a)) - TYPE_ORDER.indexOf(getBlockType(b))
  );

  return {
    markdown: ordered.join("\n\n"),
    boosterCount: ordered.length,
  };
};