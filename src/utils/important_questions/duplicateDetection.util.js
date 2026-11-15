
export function normalizeQuestionForDeduplication(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(?:question|ques|q)\s*[-.#:]?\s*\d+\b/g, " ")
    .replace(
      /\b(?:cbse|set|series|code|paper)\s*[-:#]?\s*[a-z0-9-]+\b/g,
      " "
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getQuestionTokens(value) {
  return new Set(
    normalizeQuestionForDeduplication(value)
      .split(" ")
      .filter((token) => token.length > 1)
  );
}

function areNearDuplicateQuestions(first, second) {
  const a = normalizeQuestionForDeduplication(first);
  const b = normalizeQuestionForDeduplication(second);

  if (!a || !b) return false;
  if (a === b) return true;

  const tokensA = getQuestionTokens(a);
  const tokensB = getQuestionTokens(b);

  if (!tokensA.size || !tokensB.size) return false;

  let intersection = 0;

  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }

  const smallerSize = Math.min(tokensA.size, tokensB.size);
  const jaccard =
    intersection / (tokensA.size + tokensB.size - intersection);

  return intersection / smallerSize >= 0.94 && jaccard >= 0.78;
}

export function deduplicateRankedPyqs(questions) {
  const kept = [];

  for (const question of questions) {
    const duplicate = kept.some((existing) =>
      areNearDuplicateQuestions(
        getCompleteQuestionText(existing),
        getCompleteQuestionText(question)
      )
    );

    if (!duplicate) kept.push(question);
  }

  return kept;
}

export function selectYearDiverseEvidence(questions, limit = 15) {
  const sorted = [...questions].sort(
    (a, b) => Number(b.score ?? 0) - Number(a.score ?? 0)
  );

  const yearBuckets = new Map();

  for (const question of sorted) {
    const year = String(
      question.year ?? question.paperYear ?? "unknown"
    );

    if (!yearBuckets.has(year)) yearBuckets.set(year, []);
    yearBuckets.get(year).push(question);
  }

  const selected = [];
  const buckets = [...yearBuckets.values()];
  let index = 0;

  while (selected.length < limit) {
    let added = false;

    for (const bucket of buckets) {
      if (bucket[index] && selected.length < limit) {
        selected.push(bucket[index]);
        added = true;
      }
    }

    if (!added) break;
    index += 1;
  }

  return selected;
}

export function createGeneratedQuestionDeduplicator() {
  const seen = [];

  return (item) => {
    const questionText = item?.questionText;

    if (
      typeof questionText !== "string" ||
      !questionText.trim()
    ) {
      return false;
    }

    const duplicate = seen.some((existing) =>
      areNearDuplicateQuestions(existing, questionText)
    );

    if (duplicate) return false;

    seen.push(questionText);
    return true;
  };
}

// Import required by the existing PYQ deduplication logic.
import { getCompleteQuestionText } from "./questionContent.util.js";
