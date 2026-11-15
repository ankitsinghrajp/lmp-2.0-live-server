import { openai } from "../../utils/OpenAI.js";
import { getLanguageInfo } from "../../utils/last_night_before_exam/predicted_questions/language.js";
import {
  LATEX_REPAIR_SYSTEM_PROMPT,
  MAX_CONCEPTS,
  buildShortNotesSystemPrompt,
  buildShortNotesUserPrompt,
} from "../../utils/chapterWiseStudy/shortNotes/prompt.js";
import {
  languageShortNotesResponseSchema,
  latexFixResponseSchema,
  shortNotesResponseSchema,
} from "../../utils/chapterWiseStudy/shortNotes/schema.js";
import {
  collectConceptIssues,
  conceptKey,
  degradeConcept,
  digitsOf,
  fixConcept,
  languageWarning,
  renderConcept,
  sanitizeConcept,
  setConceptField,
} from "../../utils/chapterWiseStudy/shortNotes/validation.js";

const MODEL = "gpt-4o-mini";
const LOG = "[Short Notes]";

const GENERATION_TEMPERATURE = 0.4;
const MAX_COMPLETION_TOKENS = 4000;
const MAX_GENERATION_ATTEMPTS = 2; // a retry only happens if almost nothing came out
const MIN_ACCEPTED_CONCEPTS = 3;
const MAX_REPAIR_ATTEMPTS = 2; // LLM LaTeX repairs per concept

/* -------------------------------------------------------------------------- */
/*                               LaTeX repair                                 */
/* -------------------------------------------------------------------------- */

/** Asks the model to fix only the failing fields. A fix that changes any digit is rejected. */
async function repairConceptWithLlm(concept, issues) {
  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: LATEX_REPAIR_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ fields: issues }) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "latex_fixes",
        strict: true,
        schema: latexFixResponseSchema,
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("LaTeX repair returned an empty response");

  const { fixes } = JSON.parse(content);
  const original = new Map(issues.map((issue) => [issue.path, issue.text]));
  const repaired = structuredClone(concept);

  for (const { path, fixed } of fixes) {
    const before = original.get(path);

    if (before === undefined) continue; // model invented a path
    if (digitsOf(fixed) !== digitsOf(before)) {
      console.warn(`${LOG} Repair rejected for "${path}": numbers changed`);
      continue;
    }

    setConceptField(repaired, path, fixed);
  }

  return repaired;
}

function salvage(concept, ctx) {
  const degraded = degradeConcept(concept);
  return collectConceptIssues(degraded, ctx).length ? null : degraded;
}

/** fix -> KaTeX check -> (LLM repair -> fix -> check) x N -> degrade. */
async function validateAndRepairConcept(concept, ctx) {
  let current = fixConcept(concept, ctx);

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const issues = collectConceptIssues(current, ctx);

    if (!issues.length) {
      if (attempt > 0) {
        console.log(`${LOG} "${current.name}" repaired after ${attempt} attempt(s)`);
      }
      return current;
    }

    if (attempt === MAX_REPAIR_ATTEMPTS) {
      console.warn(
        `${LOG} "${current.name}" still invalid, degrading:`,
        issues.map((i) => ({ path: i.path, error: i.error }))
      );
      return salvage(current, ctx);
    }

    try {
      current = fixConcept(await repairConceptWithLlm(current, issues), ctx);
    } catch (error) {
      console.error(`${LOG} Repair call failed for "${current.name}":`, error.message);
      return salvage(current, ctx);
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*                         Streaming concept extractor                        */
/* -------------------------------------------------------------------------- */

/**
 * Pulls COMPLETE concept objects out of a streamed {"concepts":[{...},{...}]}
 * response, one at a time, as soon as each object's closing brace arrives.
 * String/escape aware, so braces inside LaTeX never confuse it.
 */
function createConceptExtractor(onConceptObject) {
  let arrayStarted = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let buffer = "";

  const trackString = (ch) => {
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === '"') inString = false;
  };

  return function push(chunk) {
    for (const ch of chunk) {
      // Before the concepts array: skip to its opening "["
      if (!arrayStarted) {
        if (inString) trackString(ch);
        else if (ch === '"') inString = true;
        else if (ch === "[") arrayStarted = true;
        continue;
      }

      // Between concept objects: wait for the next "{"
      if (depth === 0) {
        if (ch === "{") {
          depth = 1;
          buffer = "{";
        }
        continue;
      }

      buffer += ch;

      if (inString) {
        trackString(ch);
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
            console.error(`${LOG} Skipped an unparseable streamed concept:`, error.message);
          }

          buffer = "";
          if (parsed) onConceptObject(parsed);
        }
      }
    }
  };
}

/** Streams one generation pass; every complete concept goes to onConcept. */
async function streamConcepts({ systemPrompt, userPrompt, schema, schemaName, onConcept }) {
  const stream = await openai.chat.completions.create({
    model: MODEL,
    stream: true,
    temperature: GENERATION_TEMPERATURE,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema },
    },
  });

  const push = createConceptExtractor(onConcept);
  let refusal = "";

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;

    if (delta?.refusal) refusal += delta.refusal;
    if (delta?.content) push(delta.content);
  }

  return refusal;
}

/* -------------------------------------------------------------------------- */
/*                                Main service                                */
/* -------------------------------------------------------------------------- */

/**
 * @param subject      main subject, e.g. "Hindi"
 * @param fullSubject  raw subject as the user sent it, e.g. "Hindi: Kshitij Part 2"
 * @param onChunk      async ({ index, markdown }) called once per finished concept
 *                     block, strictly in generation order
 * @returns { markdown, conceptCount } where markdown is the whole set of notes
 */
export const generateShortNotesOutput = async ({
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

  const systemPrompt = buildShortNotesSystemPrompt(promptArgs);
  const userPrompt = buildShortNotesUserPrompt(promptArgs);

  const schema = ctx.isLanguage
    ? languageShortNotesResponseSchema
    : shortNotesResponseSchema;
  const schemaName = ctx.isLanguage
    ? "language_short_notes"
    : "chapter_short_notes";

  const blocks = []; // finished Markdown blocks, in the order sent to the client
  const seen = new Set(); // concept names (accepted + in flight)

  let emitChain = Promise.resolve(); // keeps chunk order even if repairs finish out of order
  let received = 0;
  let accepted = 0;
  let rejectedCount = 0;
  let duplicateCount = 0;
  let droppedCount = 0;
  let lastError = "";

  const emitBlock = async (markdown) => {
    const index = blocks.length;
    blocks.push(markdown);

    if (typeof onChunk !== "function") return;

    try {
      await onChunk({ index, markdown });
    } catch (error) {
      console.error(`${LOG} onChunk failed for block ${index + 1}:`, error.message);
    }
  };

  const handleConcept = (rawConcept) => {
    received += 1;

    if (accepted >= MAX_CONCEPTS) return;

    const concept = sanitizeConcept(rawConcept, ctx);
    if (!concept) {
      rejectedCount += 1;
      return;
    }

    const key = conceptKey(concept.name);
    if (!key || seen.has(key)) {
      duplicateCount += 1;
      return;
    }

    seen.add(key);
    accepted += 1;

    const warning = languageWarning(concept, ctx);
    if (warning) console.warn(`${LOG} Language check (kept): ${warning}`);

    // Validation/repair starts now (while the model keeps writing), but the
    // result is emitted through the chain so the notes stay in order.
    const task = validateAndRepairConcept(concept, ctx).catch((error) => {
      console.error(`${LOG} Validation crashed for "${concept.name}":`, error.message);
      return null;
    });

    emitChain = emitChain.then(async () => {
      const fixed = await task;

      if (!fixed) {
        seen.delete(key);
        accepted -= 1;
        droppedCount += 1;
        return;
      }

      await emitBlock(renderConcept(fixed));
    });
  };

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    try {
      const refusal = await streamConcepts({
        systemPrompt,
        userPrompt,
        schema,
        schemaName,
        onConcept: handleConcept,
      });

      if (refusal) lastError = `OpenAI refused the request: ${refusal}`;
    } catch (error) {
      lastError = error.message;
      console.error(
        `${LOG} Generation attempt ${attempt}/${MAX_GENERATION_ATTEMPTS} failed:`,
        error.message
      );
    }

    // Wait for repairs/emits still running, so `blocks` is final.
    await emitChain;

    if (blocks.length >= MIN_ACCEPTED_CONCEPTS) break;
  }

  console.log(
    `${LOG} Received=${received}, rejected=${rejectedCount}, ` +
      `duplicates=${duplicateCount}, dropped=${droppedCount}, sent=${blocks.length}`
  );

  if (blocks.length < MIN_ACCEPTED_CONCEPTS) {
    throw new Error(
      lastError
        ? `Could not generate short notes: ${lastError}`
        : "Could not generate short notes. Please retry."
    );
  }

  return {
    markdown: blocks.join("\n\n"),
    conceptCount: blocks.length,
  };
};