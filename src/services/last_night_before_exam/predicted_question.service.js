import { openai } from "../../utils/OpenAI.js";

import { getLanguageInfo } from "../../utils/last_night_before_exam/predicted_questions/language.js";
import {
  getPredictedQuestionsSchema,
  OBJECTIVE_TYPES,
  IMPORTANCE_LEVELS,
} from "../../utils/last_night_before_exam/predicted_questions/schema.js";
import {
  buildPredictedQuestionsSystemPrompt,
  buildPredictedQuestionsUserPrompt,
} from "../../utils/last_night_before_exam/predicted_questions/prompt.js";
import { createQuestionExtractor } from "../../utils/last_night_before_exam/predicted_questions/streaming.js";
import {
  sanitizePredictedQuestion,
  validateAndRepairQuestion,
  looksLikeMcqStem,
  hasInlineOptions,
  isObjectiveQuestion,
  createDuplicateTracker,
} from "../../utils/last_night_before_exam/predicted_questions/validation.js";

// RAG (same building blocks as the Important Questions feature)
import { retrievePyqs } from "../pyqRetrieval.service.js";
import {
  deduplicateRankedPyqs,
  selectYearDiverseEvidence,
} from "../../utils/important_questions/duplicateDetection.util.js";
import {
  getCompleteQuestionText,
  rankPyqs,
} from "../../utils/important_questions/questionContent.util.js";
import {
  isSameClass,
  normalizeClass,
} from "../../utils/important_questions/validation.utils.js";

const LOG = "[Predicted Questions]";

const MODEL = "gpt-4o-mini";
const TEMPERATURE = 0.3;
const MAX_COMPLETION_TOKENS = 6000;

const MIN_QUESTIONS = 5;
const MAX_QUESTIONS = 6;
const MAX_OBJECTIVE = 0; // no MCQ / Assertion Reason at all
const MIN_VERY_HIGH = 3;

// A generation attempt that produces ZERO valid questions is retried once.
// Nothing has been sent to the client in that case, so a retry is safe.
const MAX_ATTEMPTS = 2;

// RAG settings
const DEFAULT_TOP_K = 50;
const MAX_CONTEXT_QUESTIONS = 20;

const IMPORTANCE_ORDER = Object.fromEntries(
  IMPORTANCE_LEVELS.map((level, i) => [level, i])
);

/* -------------------------------------------------------------------------- */
/*                                RAG routing                                 */
/* -------------------------------------------------------------------------- */

/**
 * Same routing as Important Questions (languages are handled before this):
 *  - Class 9 and 11: never use RAG.
 *  - Class 10: RAG only for mathematics, science, social science.
 *  - Class 12: RAG only for the subjects listed below.
 *  - Any other class: RAG.
 */
const NO_RAG_CLASSES = new Set([9, 11]);

const RAG_SUBJECTS_BY_CLASS = {
  10: ["mathematics", "science", "social science"],
  12: [
    "physics",
    "chemistry",
    "mathematics",
    "biology",
    "accountancy",
    "history",
    "geography",
    "sociology",
    "political science",
    "economics",
    "business studies",
    "informatics practices",
  ],
};

const classNumber = (value) => {
  const match = String(value ?? "").match(/\d+/);
  return match ? Number(match[0]) : NaN;
};

const shouldSkipRag = (requestedClass, className, subject) => {
  const classNum = Number.isNaN(classNumber(requestedClass))
    ? classNumber(className)
    : classNumber(requestedClass);

  if (NO_RAG_CLASSES.has(classNum)) return true;

  const ragSubjects = RAG_SUBJECTS_BY_CLASS[classNum];
  if (!ragSubjects) return false; // other classes keep using RAG

  const normalizedSubject = String(subject ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ");

  return !ragSubjects.some((name) => normalizedSubject.includes(name));
};

const normText = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Generic subject check. Records without a subject are kept. */
const isSameSubject = (recordSubject, requestedSubject) => {
  if (!recordSubject) return true;

  const a = normText(recordSubject);
  const b = normText(requestedSubject);

  return a === b || a.includes(b) || b.includes(a);
};

/**
 * retrieve -> same class -> same subject -> rank + dedupe ->
 * year-diverse evidence -> compact evidence list for the prompt.
 *
 * Returns an array of evidence items, or null when RAG is not used or
 * produced nothing usable (the caller then falls back to the no-RAG prompt).
 */
const fetchPyqEvidence = async ({ className, subject, chapter }) => {
  const requestedClass = normalizeClass(className);

  try {
    const retrievedQuestions = await retrievePyqs({
      query: `${chapter} most repeated important CBSE board previous-year questions`,
      className,
      subject,
      chapter,
      topK: Math.min(DEFAULT_TOP_K, 50),
      candidatePool: 100,
    });

    if (!retrievedQuestions?.length) {
      console.warn(`${LOG} No PYQs retrieved. Falling back to no-RAG.`);
      return null;
    }

    const sameClass = retrievedQuestions.filter((question) =>
      isSameClass(question.className, requestedClass)
    );

    if (!sameClass.length) {
      console.warn(
        `${LOG} ${retrievedQuestions.length} PYQs retrieved, none for Class ${requestedClass}. Falling back to no-RAG.`
      );
      return null;
    }

    const sameSubject = sameClass.filter((question) =>
      isSameSubject(question.subject, subject)
    );
    const scoped = sameSubject.length ? sameSubject : sameClass;

    const deduplicated = deduplicateRankedPyqs(rankPyqs(scoped));

    if (!deduplicated.length) {
      console.warn(`${LOG} No usable PYQs after dedupe. Falling back to no-RAG.`);
      return null;
    }

    const relevant = selectYearDiverseEvidence(
      deduplicated,
      MAX_CONTEXT_QUESTIONS
    );

    const evidence = relevant.map((question) => ({
      id: String(question.id ?? question.questionId ?? ""),
      question: getCompleteQuestionText(question),
      year: question.year ?? question.paperYear ?? null,
      marks: question.marks ?? null,
      questionType: question.questionType ?? question.type ?? null,
    }));

    console.log(`${LOG} Sending ${evidence.length} PYQs to OpenAI`);

    return evidence;
  } catch (error) {
    // Retrieval problems must not break the feature: predict without evidence.
    console.error(
      `${LOG} PYQ retrieval failed, falling back to no-RAG:`,
      error.message
    );
    return null;
  }
};

/**
 * Generates predicted exam questions.
 *
 * Retrieval: for non-language subjects that qualify for RAG (see routing
 * above) the previous-year questions are retrieved first and sent to the
 * model as evidence. Everything else uses the original no-RAG prompt.
 *
 * Pipeline:
 *   stream from the model -> pull each COMPLETE question out of the stream ->
 *   sanitize -> dedupe -> cap objective questions -> validate / repair LaTeX
 *   in the background -> hand each valid question to onQuestion immediately.
 *
 * onQuestion({ section: "questions", index, item }) is called once per valid
 * question as soon as it is ready. The returned value is
 *   { questions }   (Very High first)
 */
export const generatePredictedQuestionsOutput = async ({
  className,
  subject,
  chapter,
  bookName,
  category,
  onQuestion,
}) => {
  if (!className || !subject || !chapter) {
    throw new Error("className, subject and chapter are required.");
  }

  const languageInfo = getLanguageInfo(subject, bookName);
  const isLanguage = Boolean(languageInfo);
  const languageKey = languageInfo?.key ?? null;

  // Language subjects never use RAG. Others follow the class/subject routing.
  let pyqEvidence = null;

  if (!isLanguage) {
    const requestedClass = normalizeClass(className);

    if (shouldSkipRag(requestedClass, className, subject)) {
      console.log(
        `${LOG} Skipping RAG for Class ${requestedClass} "${subject}".`
      );
    } else {
      pyqEvidence = await fetchPyqEvidence({ className, subject, chapter });
    }
  }

  const promptArgs = {
    className,
    subject,
    chapter,
    bookName,
    category,
    languageInfo,
    pyqEvidence,
  };

  const systemPrompt = buildPredictedQuestionsSystemPrompt(promptArgs);
  const userPrompt = buildPredictedQuestionsUserPrompt(promptArgs);
  const schema = getPredictedQuestionsSchema(isLanguage);

  if (isLanguage) {
    console.log(
      `${LOG} ${languageInfo.label} detected (book: "${languageInfo.book}", chapter: "${chapter}")`
    );
  }

  const runAttempt = async (attempt) => {
    const tracker = createDuplicateTracker();
    const tasks = [];
    const emissions = [];
    const finalQuestions = []; // { index, question }

    let receivedCount = 0;
    let acceptedCount = 0;
    let objectiveCount = 0;
    let rejectedCount = 0;
    let duplicateCount = 0;
    let unfixableCount = 0;
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
          name: isLanguage
            ? "predicted_language_questions"
            : "predicted_questions",
          strict: true,
          schema,
        },
      },
    });

    const emitQuestion = (index, question) => {
      finalQuestions.push({ index, question });

      if (typeof onQuestion !== "function") return;

      emissions.push(
        Promise.resolve()
          .then(() => onQuestion({ section: "questions", index, item: question }))
          .catch((error) => {
            console.error(
              `${LOG} onQuestion failed for question ${index + 1}:`,
              error.message
            );
          })
      );
    };

    const processQuestion = async (question, index) => {
      let fixed = null;

      try {
        fixed = await validateAndRepairQuestion(question, index, {
          client: openai,
          model: MODEL,
          isLanguage,
          languageKey,
        });
      } catch (error) {
        console.error(
          `${LOG} Validation crashed for question ${index + 1}:`,
          error.message
        );
      }

      if (fixed) {
        emitQuestion(index, fixed);
      } else {
        unfixableCount += 1;
      }
    };

    const handleStreamedQuestion = (rawQuestion) => {
      receivedCount += 1;

      if (process.env.DEBUG_PREDICTED_QUESTIONS) {
        console.log(
          `${LOG} raw ${receivedCount}:`,
          JSON.stringify(rawQuestion).slice(0, 400)
        );
      }

      if (acceptedCount >= MAX_QUESTIONS) return;

      // Language subjects never get MCQs: drop objective types and
      // MCQ-style stems that have no options array.
      if (
        isLanguage &&
        (OBJECTIVE_TYPES.includes(rawQuestion?.questionType) ||
          looksLikeMcqStem(rawQuestion))
      ) {
        rejectedCount += 1;
        return;
      }

      // No MCQs for any subject: drop options typed inline as (A) (B) (C) (D).
      if (!isLanguage && hasInlineOptions(rawQuestion)) {
        rejectedCount += 1;
        return;
      }

      const question = sanitizePredictedQuestion(rawQuestion, { isLanguage });

      if (!question) {
        rejectedCount += 1;
        return;
      }

      // Hard cap on objective questions (0 = none). Guarantees it even if
      // the model ignores the instruction (PYQ evidence can contain MCQs).
      const objective = isObjectiveQuestion(question);

      if (objective && objectiveCount >= MAX_OBJECTIVE) {
        rejectedCount += 1;
        return;
      }

      if (!tracker.register(question.questionText)) {
        duplicateCount += 1;
        return;
      }

      if (objective) objectiveCount += 1;

      const index = acceptedCount;
      acceptedCount += 1;

      // Not awaited: this question is checked / repaired while the model
      // keeps generating the next ones.
      tasks.push(processQuestion(question, index));
    };

    const pushChunk = createQuestionExtractor(handleStreamedQuestion);

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;

        if (delta?.refusal) refusal += delta.refusal;
        if (delta?.content) pushChunk(delta.content);
      }
    } catch (error) {
      // Keep whatever was already completed; the caller decides what to do.
      streamError = error;
      console.error(
        `${LOG} Stream error on attempt ${attempt}:`,
        error.message
      );
    }

    // Wait for repairs and for every onQuestion call that is still running.
    await Promise.all(tasks);
    await Promise.all(emissions);

    console.log(
      `${LOG} Attempt ${attempt}: received=${receivedCount}, ` +
        `rejected=${rejectedCount}, duplicates=${duplicateCount}, ` +
        `unfixableLatex=${unfixableCount}, sent=${finalQuestions.length}`
    );

    return { finalQuestions, refusal, streamError, receivedCount };
  };

  let result = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const attemptResult = await runAttempt(attempt);

      if (attemptResult.finalQuestions.length) {
        result = attemptResult;
        break;
      }

      lastError = new Error(
        attemptResult.refusal
          ? `OpenAI refused the request: ${attemptResult.refusal}`
          : attemptResult.streamError?.message ||
              (attemptResult.receivedCount
                ? "No valid questions could be produced"
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
      `Predicted Questions generation failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`
    );
  }

  // Generation order first, then make sure at least MIN_VERY_HIGH questions
  // carry the "Very High" label, then put "Very High" first.
  const questions = result.finalQuestions
    .sort((a, b) => a.index - b.index)
    .map((entry) => ({ ...entry.question }));

  let veryHighCount = questions.filter(
    (q) => q.importance === "Very High"
  ).length;

  for (const question of questions) {
    if (veryHighCount >= Math.min(MIN_VERY_HIGH, questions.length)) break;

    if (question.importance !== "Very High") {
      question.importance = "Very High";
      veryHighCount += 1;
    }
  }

  // Array.prototype.sort is stable, so generation order is kept inside a group.
  questions.sort(
    (a, b) =>
      (IMPORTANCE_ORDER[a.importance] ?? 2) -
      (IMPORTANCE_ORDER[b.importance] ?? 2)
  );

  if (questions.length < MIN_QUESTIONS) {
    console.warn(
      `${LOG} Only ${questions.length} valid questions (target ${MIN_QUESTIONS}-${MAX_QUESTIONS})`
    );
  }

  return { questions };
};