import { importantQuestionsOpenAI } from "../config/importantQuestionsOpenAI.js";

import { retrievePyqs } from "./pyqRetrieval.service.js";

import {
  createGeneratedQuestionDeduplicator,
  deduplicateRankedPyqs,
  selectYearDiverseEvidence,
} from "../utils/important_questions/duplicateDetection.util.js";

import {
  getCompleteQuestionText,
  rankPyqs,
} from "../utils/important_questions/questionContent.util.js";

import {
  isSameClass,
  normalizeClass,
  validateInput,
} from "../utils/important_questions/validation.utils.js";

import { validateAndRepairText } from "../utils/pyqs/validation.js";

import {
  buildPyqSystemPrompt,
  buildPyqUserPrompt,
  buildTopUpUserPrompt,
  detectLanguage,
} from "../utils/pyqs/prompt.js";

import {
  MAX_PYQS,
  MIN_PYQS,
  RESPONSE_VERSION,
} from "../utils/pyqs/shared.js";

const MODEL_DEFAULT = "gpt-4o-mini";
// Harder subjects get the bigger model (same list the old PYQ fixer used).
const MODEL_HARD = "gpt-4o";
const HARD_SUBJECTS = [
  "physics",
  "chemistry",
  "mathematics",
  "accountancy",
  "bio technology",
  "biotechnology",
];

const GENERATION_TEMPERATURE = 0.4;
const LANGUAGE_TEMPERATURE = 0.3;

const RETRIEVAL_TOP_K = 50;
const RETRIEVAL_CANDIDATE_POOL = 100;
const MAX_EVIDENCE = 25; // same-year retrieved PYQs sent to the model
const MAX_STYLE_REFERENCE = 8; // other-year PYQs sent as style hints only
const MAX_TOP_UP_PASSES = 2;

/**
 * The model only returns { origin, marks, question, diagram }.
 * id and year are added by the service, so the model cannot get them wrong.
 * "origin" is used for logging only and is not stored.
 * "diagram" is stored only when the question actually contains a diagram.
 */
const pyqResponseSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          origin: {
            type: "string",
            enum: ["retrieved", "generated"],
            description:
              "retrieved = a kept or fixed question from the retrieved PYQs; generated = a new question written by you.",
          },
          marks: {
            type: "integer",
            enum: [1, 2, 3, 4, 5, 6],
            description: "Marks of the question.",
          },
          question: {
            type: "string",
            description:
              "The complete question as one string. Sub-parts and MCQ options each on their own line (\\n). Every formula, symbol and number-with-unit wrapped in \\( ... \\). Tables as Markdown tables inside this string.",
          },
          diagram: {
            type: "string",
            description:
              'Only if the question contains or needs a diagram/figure: a plain-text description of the diagram, e.g. "Triangle ABC with side AB = 20 cm, side BC = 45 cm and angle B = 90 degrees". Otherwise an empty string "".',
          },
        },
        required: ["origin", "marks", "question", "diagram"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const normText = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Unicode-safe duplicate key (keeps Devanagari letters and marks). */
const normUnicodeText = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Records without a subject are kept. */
function isSameSubject(recordSubject, requestedSubject) {
  if (!recordSubject) return true;

  const a = normText(recordSubject);
  const b = normText(requestedSubject);

  return a === b || a.includes(b) || b.includes(a);
}

const yearOf = (record) => {
  const match = String(record?.year ?? record?.paperYear ?? "").match(/\d{4}/);
  return match ? Number(match[0]) : null;
};

function pickModel(subject) {
  const name = normText(subject);

  return HARD_SUBJECTS.some((hard) => name.includes(hard))
    ? MODEL_HARD
    : MODEL_DEFAULT;
}

/**
 * Pulls COMPLETE question objects out of a streamed
 * {"questions":[{...},{...}]} response, one at a time, as soon as each
 * object's closing brace arrives. String/escape aware.
 */
function createQuestionExtractor(onQuestionObject) {
  let arrayStarted = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let buffer = "";

  const trackString = (ch) => {
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = false;
    }
  };

  return function push(chunk) {
    for (const ch of chunk) {
      if (!arrayStarted) {
        if (inString) trackString(ch);
        else if (ch === '"') inString = true;
        else if (ch === "[") arrayStarted = true;
        continue;
      }

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
            console.error(
              "[PYQ RAG] Skipped an unparseable streamed question:",
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
/*                                 Retrieval                                  */
/* -------------------------------------------------------------------------- */

/**
 * Retrieves PYQs and splits them into:
 *  - sameYear:   real questions of the requested year (to be kept / fixed)
 *  - otherYears: only used as style hints, never returned as year-X questions
 * Retrieval problems never fail the request: the model then generates the
 * whole set.
 */
async function retrieveEvidence({
  className,
  subject,
  chapter,
  requestedClass,
  requestedYear,
}) {
  let retrieved = [];

  try {
    retrieved = await retrievePyqs({
      query: `${chapter} CBSE ${requestedYear} previous year question paper`,
      className,
      subject,
      chapter,
      topK: RETRIEVAL_TOP_K,
      candidatePool: RETRIEVAL_CANDIDATE_POOL,
    });
  } catch (error) {
    console.error(
      "[PYQ RAG] Retrieval failed, falling back to generation:",
      error.message
    );
    return { sameYear: [], otherYears: [] };
  }

  const scoped = (retrieved ?? []).filter(
    (record) =>
      isSameClass(record.className, requestedClass) &&
      isSameSubject(record.subject, subject)
  );

  const unique = deduplicateRankedPyqs(rankPyqs(scoped));

  return {
    sameYear: unique.filter((record) => yearOf(record) === requestedYear),
    otherYears: unique.filter((record) => yearOf(record) !== requestedYear),
  };
}

/* -------------------------------------------------------------------------- */
/*                                Main service                                */
/* -------------------------------------------------------------------------- */

export async function generatePyqsWithRag({
  className,
  subject,
  bookName = "",
  chapter,
  year,
  onQuestion,
}) {
  validateInput({ className, subject, chapter });

  const requestedClass = normalizeClass(className);
  const requestedYear = Number(year);

  if (!Number.isInteger(requestedYear)) {
    throw new Error("A valid year is required");
  }

  const language = detectLanguage(subject);
  const model = pickModel(subject);
  const temperature = language ? LANGUAGE_TEMPERATURE : GENERATION_TEMPERATURE;
  const checkLatex = !language; // Hindi / Sanskrit have no math

  // 1. Retrieve. Same-year records are "real" PYQs; other years are style hints.
  const { sameYear, otherYears } = await retrieveEvidence({
    className,
    subject,
    chapter,
    requestedClass,
    requestedYear,
  });

  const evidence = sameYear.slice(0, MAX_EVIDENCE).map((record, i) => ({
    ref: i + 1,
    marks: record.marks ?? null,
    question: getCompleteQuestionText(record),
  }));

  const styleReference =
    sameYear.length >= MIN_PYQS
      ? []
      : selectYearDiverseEvidence(otherYears, MAX_STYLE_REFERENCE).map(
          (record) => ({
            year: yearOf(record),
            marks: record.marks ?? null,
            question: getCompleteQuestionText(record).slice(0, 600),
          })
        );

  console.log(
    `[PYQ RAG] Class ${requestedClass} ${subject} "${chapter}" ${requestedYear}: ` +
      `sameYear=${sameYear.length}, sent=${evidence.length}, styleRefs=${styleReference.length}`
  );

  // 2. Prompts.
  const promptArgs = {
    requestedClass,
    subject,
    bookName,
    chapter,
    year: requestedYear,
    language,
  };

  const systemPrompt = buildPyqSystemPrompt(promptArgs);
  const userPrompt = buildPyqUserPrompt({
    ...promptArgs,
    evidence,
    styleReference,
  });

  // 3. Stream handling. Every question is checked the moment it is complete;
  //    valid ones go to the frontend immediately, invalid ones are repaired
  //    in the background without blocking the others.
  const seenExact = new Set();
  const isNovel = createGeneratedQuestionDeduplicator();
  const tasks = [];
  const finalItems = []; // { index, item, origin }

  const stats = {
    retrievedSameYear: sameYear.length,
    evidenceSent: evidence.length,
    received: 0,
    invalid: 0,
    duplicates: 0,
    unfixable: 0,
    fromRetrieved: 0,
    generated: 0,
    topUpPasses: 0,
  };

  let accepted = 0;

  const emitQuestion = (index, item, origin) => {
    finalItems.push({ index, item, origin });

    if (origin === "retrieved") stats.fromRetrieved += 1;
    else stats.generated += 1;

    if (typeof onQuestion !== "function") return;

    try {
      onQuestion({ section: "pyqs", index, item });
    } catch (error) {
      console.error(
        `[PYQ RAG] onQuestion failed for question ${index + 1}:`,
        error.message
      );
    }
  };

  const processQuestion = async ({ marks, text, origin, diagram }, index) => {
    let fixed = text;

    if (checkLatex) {
      fixed = null;

      try {
        fixed = await validateAndRepairText(text, `PYQ ${index + 1}`);
      } catch (error) {
        console.error(
          `[PYQ RAG] Validation crashed for PYQ ${index + 1}:`,
          error.message
        );
      }
    }

    if (!fixed) {
      stats.unfixable += 1;
      return;
    }

    emitQuestion(
      index,
      {
        id: index + 1,
        year: requestedYear,
        marks,
        question: fixed,
        // Only present when the question contains a diagram.
        ...(diagram ? { diagram } : {}),
      },
      origin
    );
  };

  const handleStreamedQuestion = (raw) => {
    stats.received += 1;

    if (accepted - stats.unfixable >= MAX_PYQS) return;

    const text = typeof raw?.question === "string" ? raw.question.trim() : "";
    const marks = Number(raw?.marks);
    const diagram =
      typeof raw?.diagram === "string" ? raw.diagram.trim() : "";

    if (!text || !Number.isInteger(marks) || marks < 1 || marks > 6) {
      stats.invalid += 1;
      return;
    }

    const key = normUnicodeText(text);

    if (!key || seenExact.has(key) || !isNovel({ questionText: text })) {
      stats.duplicates += 1;
      return;
    }

    seenExact.add(key);

    const index = accepted;
    accepted += 1;

    // Not awaited: this question is checked/repaired while the model keeps
    // generating the next ones.
    tasks.push(
      processQuestion(
        {
          marks,
          text,
          diagram,
          origin: raw.origin === "generated" ? "generated" : "retrieved",
        },
        index
      )
    );
  };

  const runPass = async (system, user) => {
    const stream = await importantQuestionsOpenAI.chat.completions.create({
      model,
      stream: true,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "pyq_question_set",
          strict: true,
          schema: pyqResponseSchema,
        },
      },
    });

    const pushChunk = createQuestionExtractor(handleStreamedQuestion);
    let refusal = "";

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;

      if (delta?.refusal) refusal += delta.refusal;
      if (delta?.content) pushChunk(delta.content);
    }

    // Wait for repairs that are still running.
    await Promise.all(tasks);

    return refusal;
  };

  // 4. Main pass: fix retrieved PYQs and top up with generated ones.
  const refusal = await runPass(systemPrompt, userPrompt);

  if (!stats.received) {
    throw new Error(
      refusal
        ? `OpenAI refused the PYQ request: ${refusal}`
        : "OpenAI returned an empty PYQ response"
    );
  }

  // 5. Safety net: if duplicates / unfixable LaTeX left us under the minimum,
  //    ask only for the missing number of new questions.
  for (
    let pass = 1;
    pass <= MAX_TOP_UP_PASSES && finalItems.length < MIN_PYQS;
    pass += 1
  ) {
    const have = finalItems.length;
    const count = Math.min(MAX_PYQS - have, MIN_PYQS - have + 2);
    const receivedBefore = stats.received;

    stats.topUpPasses = pass;
    console.log(
      `[PYQ RAG] Only ${have}/${MIN_PYQS} valid questions, top-up pass ${pass} asking for ${count}`
    );

    try {
      await runPass(
        systemPrompt,
        buildTopUpUserPrompt({
          ...promptArgs,
          existing: finalItems.map((entry) => entry.item.question),
          count,
        })
      );
    } catch (error) {
      console.error("[PYQ RAG] Top-up pass failed:", error.message);
      break;
    }

    if (stats.received === receivedBefore) break;
  }

  if (!finalItems.length) {
    throw new Error(
      "No valid previous-year questions could be generated. Please retry."
    );
  }

  // 6. Final, clean, sequentially numbered result.
  const pyqs = finalItems
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_PYQS)
    .map((entry, i) => ({
      id: i + 1,
      year: requestedYear,
      marks: entry.item.marks,
      question: entry.item.question,
      ...(entry.item.diagram ? { diagram: entry.item.diagram } : {}),
    }));

  console.log(
    `[PYQ RAG] received=${stats.received}, duplicates=${stats.duplicates}, ` +
      `invalid=${stats.invalid}, unfixableLatex=${stats.unfixable}, ` +
      `fromRetrieved=${stats.fromRetrieved}, generated=${stats.generated}, ` +
      `topUpPasses=${stats.topUpPasses}, sent=${pyqs.length}`
  );

  return {
    content: {
      class: String(className).trim(),
      subject,
      chapter,
      year: requestedYear,
      version: RESPONSE_VERSION,
      pyqs,
    },
    stats,
  };
}