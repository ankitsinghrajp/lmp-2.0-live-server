
import { retrieveMultilingualPyqs } from "./multilingualPyqRetrieval.service.js";
import { pipeline } from "@xenova/transformers";
import { pinecone } from "../db/pineconeClient.js";

import "dotenv/config";

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const NAMESPACE = "pyqs";
const EMBEDDING_DIMENSIONS = 384;

const DEFAULT_TOP_K = 20;
const MAX_TOP_K = 100;
const DEFAULT_CANDIDATE_POOL = 100;

const EMBEDDING_CONCURRENCY = 8;
const CHUNK_WORD_LIMIT = 100;
const CHUNK_OVERLAP = 20;

let embeddingPipeline;
let indexInstance;

/* -------------------------------------------------------------------------- */
/* Pinecone                                                                    */
/* -------------------------------------------------------------------------- */

async function getEmbeddingPipeline() {
  if (!embeddingPipeline) {
    embeddingPipeline = pipeline(
      "feature-extraction",
      MODEL_NAME
    );
  }

  return embeddingPipeline;
}

async function getIndex() {
  if (indexInstance) return indexInstance;

  const indexName =
    process.env.PINECONE_INDEX_NAME || "lmp-pyq-vectors";

  indexInstance = pinecone.index(indexName);

  return indexInstance;
}

/* -------------------------------------------------------------------------- */
/* Embeddings                                                                  */
/* -------------------------------------------------------------------------- */

async function createEmbedding(text) {
  const extractor = await getEmbeddingPipeline();

  const output = await extractor(String(text ?? ""), {
    pooling: "mean",
    normalize: true,
  });

  const vector = Array.from(output.data);

  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS} dimensions, ` +
        `received ${vector.length}`
    );
  }

  return vector;
}

function cosineSimilarity(a, b) {
  if (!a?.length || a.length !== b?.length) {
    return 0;
  }

  let dot = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }

  return dot;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

function normalizeClassName(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  const match = normalized.match(
    /^(?:class\s*)?(\d+)(?:st|nd|rd|th)?$/
  );

  return match ? String(Number(match[1])) : normalized;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/* -------------------------------------------------------------------------- */
/* Safely read JSON fields from Pinecone metadata                              */
/* -------------------------------------------------------------------------- */

function parseJson(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getMetadataValue(metadata, ...keys) {
  for (const key of keys) {
    if (metadata[key] != null) {
      return metadata[key];
    }
  }

  return null;
}

function extractMetadata(match) {
  const metadata = match.metadata ?? {};

  const questionText = String(
    getMetadataValue(
      metadata,
      "questionText",
      "question",
      "text",
      "content"
    ) ?? ""
  );

  const subQuestions = parseJson(
    getMetadataValue(
      metadata,
      "subQuestions",
      "subQuestionsJson"
    ),
    []
  );

  const options = parseJson(
    getMetadataValue(metadata, "options", "optionsJson"),
    []
  );

  const visuals = parseJson(
    getMetadataValue(metadata, "visuals", "visualsJson"),
    []
  );

  const tags = parseJson(metadata.tags, []);

  const source = parseJson(
    getMetadataValue(metadata, "source", "sourceJson")
  );

  return {
    id: match.id,
    score: Number(match.score ?? 0),
    pineconeScore: Number(match.score ?? 0),

    questionId: metadata.questionId ?? match.id,
    className: metadata.className ?? null,
    subject: metadata.subject ?? null,
    board: metadata.board ?? null,
    year: metadata.year ?? null,

    chapter: metadata.chapter ?? null,
    topic: metadata.topic ?? null,
    marks: metadata.marks ?? null,
    questionNumber: metadata.questionNumber ?? null,
    questionType: metadata.questionType ?? null,

    questionText,
    subQuestions: Array.isArray(subQuestions)
      ? subQuestions
      : [],
    options: Array.isArray(options) ? options : [],
    visuals: Array.isArray(visuals) ? visuals : [],
    tags: Array.isArray(tags) ? tags : [],
    source,

    verificationStatus:
      metadata.verificationStatus ?? null,

    // Preserve the original record for downstream consumers.
    metadata,
  };
}

/* -------------------------------------------------------------------------- */
/* Build complete question content                                             */
/* -------------------------------------------------------------------------- */

/**
 * Use actual question content, not chapter/topic metadata.
 *
 * A question may have its meaningful wording in subQuestions,
 * its options, or a visual description.
 */
function getQuestionContentParts(question) {
  const parts = [];

  function addPart(label, value) {
    if (typeof value !== "string" || !value.trim()) {
      return;
    }

    parts.push({
      label,
      text: value.trim(),
    });
  }

  addPart("Main question", question.questionText);

  for (const item of question.subQuestions ?? []) {
    if (typeof item === "string") {
      addPart("Subquestion", item);
      continue;
    }

    if (!item || typeof item !== "object") continue;

    addPart(
      `Subquestion ${item.label ?? ""}`.trim(),
      item.text
    );
  }

  for (const option of question.options ?? []) {
    if (typeof option === "string") {
      addPart("Option", option);
    } else if (option && typeof option === "object") {
      addPart(
        "Option",
        option.text ?? option.label ?? ""
      );
    }
  }

  for (const visual of question.visuals ?? []) {
    if (typeof visual === "string") {
      addPart("Visual description", visual);
    } else if (visual && typeof visual === "object") {
      addPart(
        "Visual description",
        visual.description ?? visual.text ?? ""
      );
    }
  }

  return parts;
}

/**
 * Split long source passages into overlapping chunks.
 */
function splitIntoChunks(text) {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return [];

  if (words.length <= CHUNK_WORD_LIMIT) {
    return [words.join(" ")];
  }

  const chunks = [];
  const step = CHUNK_WORD_LIMIT - CHUNK_OVERLAP;

  for (
    let start = 0;
    start < words.length;
    start += step
  ) {
    chunks.push(
      words
        .slice(start, start + CHUNK_WORD_LIMIT)
        .join(" ")
    );

    if (start + CHUNK_WORD_LIMIT >= words.length) {
      break;
    }
  }

  return chunks;
}

/**
 * Embed the complete question content, including subquestions,
 * options, visuals, and chunks of long passages.
 */
function getQuestionChunks(question) {
  const parts = getQuestionContentParts(question);

  return parts.flatMap((part) =>
    splitIntoChunks(`${part.label}: ${part.text}`)
  );
}

/* -------------------------------------------------------------------------- */
/* Deduplication                                                               */
/* -------------------------------------------------------------------------- */

function getQuestionIdentity(question) {
  const identity = normalizeText(question.questionText);

  if (identity) return identity;

  // Avoid merging records with missing parent question text.
  return String(question.id);
}

/* -------------------------------------------------------------------------- */
/* Semantic reranking using complete question content                         */
/* -------------------------------------------------------------------------- */

async function rerankQuestion(question, queryVector) {
  const chunks = getQuestionChunks(question);

  if (!chunks.length) {
    return null;
  }

  const chunkScores = [];

  for (const chunk of chunks) {
    const vector = await createEmbedding(chunk);

    chunkScores.push(
      cosineSimilarity(queryVector, vector)
    );
  }

  chunkScores.sort((a, b) => b - a);

  const bestScore = chunkScores[0];
  const topScores = chunkScores.slice(0, 3);

  const topAverage =
    topScores.reduce((sum, score) => sum + score, 0) /
    topScores.length;

  const similarity =
    0.7 * bestScore + 0.3 * topAverage;

  return {
    ...question,
    score: Number(similarity.toFixed(4)),
    contentChunkCount: chunks.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Concurrency-limited processing                                               */
/* -------------------------------------------------------------------------- */

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        console.error(
          `[Pinecone] Failed to process candidate ` +
            `${items[index]?.id ?? index}:`,
          error.message
        );

        results[index] = null;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker()
    )
  );

  return results;
}

/* -------------------------------------------------------------------------- */
/* Main retrieval                                                              */
/* -------------------------------------------------------------------------- */

export async function retrievePyqs({
  query = "",
  topK = DEFAULT_TOP_K,
  candidatePool = DEFAULT_CANDIDATE_POOL,
  className,
  subject,
  chapter,
}) {
  if (!className) {
    throw new Error("className is required for PYQ retrieval");
  }

  if (typeof chapter !== "string" || !chapter.trim()) {
    throw new Error("chapter is required for PYQ retrieval");
  }

  /*
   * Dynamic model routing:
   * Hindi/Sanskrit -> BGE-M3, 1024 dimensions.
   * All other subjects -> existing MiniLM, 384 dimensions.
   *
   * Check both subject and chapter because the language may
   * be present in either field.
   */
  const routingText = `${subject ?? ""} ${chapter}`
    .normalize("NFKC")
    .trim()
    .toLowerCase();

  if (/\b(hindi|sanskrit)\b/.test(routingText)) {
    const detectedSubject = /\bsanskrit\b/.test(routingText)
      ? "Sanskrit"
      : "Hindi";

    console.log(
      `[PYQ Retrieval] Using BGE-M3 for ${detectedSubject}; ` +
        `class=${className}, chapter=${chapter}`
    );

    return retrieveMultilingualPyqs({
      query,
      topK,
      candidatePool,
      className,
      subject: detectedSubject,
      chapter,
    });
  }

  console.log(
    `[PYQ Retrieval] Using MiniLM; class=${className}, ` +
      `subject=${subject ?? "unspecified"}, chapter=${chapter}`
  );

  const normalizedClass = normalizeClassName(className);

  const requestedTopK = Math.max(
    1,
    Math.min(Number(topK) || DEFAULT_TOP_K, MAX_TOP_K)
  );

  const poolSize = Math.max(
    requestedTopK,
    Math.min(
      Number(candidatePool) || DEFAULT_CANDIDATE_POOL,
      MAX_TOP_K
    )
  );

  /*
   * Stage 1: Retrieve candidates from Pinecone.
   * The filter uses className only.
   */
  const relevanceQuery = [
    `CBSE Class ${normalizedClass}`,
    subject ? `Subject: ${subject}` : "",
    `Chapter: ${chapter.trim()}`,
    typeof query === "string" ? query.trim() : "",
  ]
    .filter(Boolean)
    .join(". ");

  const queryVector = await createEmbedding(relevanceQuery);

  const index = await getIndex();
  const namespace = index.namespace(NAMESPACE);

  const result = await namespace.query({
    vector: queryVector,
    topK: poolSize,
    filter: {
      className: normalizedClass,
    },
    includeMetadata: true,
  });

  const matches = result.matches ?? [];

  console.log(
    `[Pinecone] namespace=${NAMESPACE}, ` +
      `class=${normalizedClass}, ` +
      `requested=${poolSize}, returned=${matches.length}`
  );

  if (!matches.length) {
    console.warn(
      "[Pinecone] No candidates found. Check namespace, " +
        "index name, className metadata, and stored vectors."
    );

    return [];
  }

  /*
   * Stage 2: Extract question records and remove duplicates.
   */
  const candidates = new Map();

  for (const match of matches) {
    const question = extractMetadata(match);

    const hasQuestionContent =
      getQuestionContentParts(question).length > 0;

    if (!hasQuestionContent) {
      continue;
    }

    const identity = getQuestionIdentity(question);
    const existing = candidates.get(identity);

    if (
      !existing ||
      question.pineconeScore > existing.pineconeScore
    ) {
      candidates.set(identity, question);
    }
  }

  const uniqueCandidates = [...candidates.values()];

  /*
   * Stage 3: Rerank each candidate against its complete content.
   */
  const ranked = await mapWithConcurrency(
    uniqueCandidates,
    EMBEDDING_CONCURRENCY,
    (question) => rerankQuestion(question, queryVector)
  );

  const validRanked = ranked
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const finalResults = validRanked.slice(0, requestedTopK);

  console.log(
    `[Pinecone] uniqueCandidates=${uniqueCandidates.length}, ` +
      `reranked=${validRanked.length}, ` +
      `returned=${finalResults.length}`
  );

  console.log(
    "[Pinecone] Top complete-content similarities:",
    finalResults.slice(0, 10).map((question) => ({
      id: question.id,
      className: question.className,
      questionText: question.questionText,
      subQuestionCount: question.subQuestions.length,
      optionCount: question.options.length,
      visualCount: question.visuals.length,
      contentChunkCount: question.contentChunkCount,
      similarity: question.score,
      pineconeScore: question.pineconeScore,
    }))
  );

  return finalResults;
}
