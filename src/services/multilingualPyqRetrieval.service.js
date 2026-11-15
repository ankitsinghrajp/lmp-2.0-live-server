
import "dotenv/config";
import { Pinecone } from "@pinecone-database/pinecone";
import { pipeline } from "@huggingface/transformers";

const MODEL_NAME = "Xenova/bge-m3";
const EMBEDDING_DIMENSIONS = 1024;
const NAMESPACE = "pyqs";
const DEFAULT_INDEX_NAME = "lmp-pyq-multilingual";

const DEFAULT_TOP_K = 20;
const MAX_TOP_K = 100;
const DEFAULT_CANDIDATE_POOL = 100;

let extractorPromise;
let indexInstance;

/* -------------------------------------------------------------------------- */
/* Embedding model                                                             */
/* -------------------------------------------------------------------------- */

async function getExtractor() {
  if (!extractorPromise) {
    console.log(`[Embedding] Loading ${MODEL_NAME}...`);

    extractorPromise = pipeline(
      "feature-extraction",
      MODEL_NAME,
      {
        dtype: "q8",
        progress_callback: (progress) => {
          if (progress.status === "progress_total") {
            console.log(
              `[Model download] Overall progress: ${
                progress.progress?.toFixed(1) ?? "?"
              }%`
            );
          } else if (
            ["initiate", "download", "done", "ready"].includes(
              progress.status
            )
          ) {
            console.log(
              `[Model] ${progress.status}: ${
                progress.file ?? progress.model ?? ""
              }`
            );
          }
        },
      }
    )
      .then((extractor) => {
        console.log("[Embedding] BGE-M3 loaded successfully.");
        return extractor;
      })
      .catch((error) => {
        extractorPromise = null;
        console.error("[Embedding] BGE-M3 loading failed:", error);
        throw error;
      });
  }

  return extractorPromise;
}

async function generateEmbedding(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Cannot generate an embedding from empty text.");
  }

  const extractor = await getExtractor();

  const output = await extractor(text, {
    pooling: "cls",
    normalize: true,
  });

  const vector = Array.from(output.data);

  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS} dimensions, received ${vector.length}.`
    );
  }

  if (!vector.every(Number.isFinite)) {
    throw new Error("Embedding contains invalid numeric values.");
  }

  return vector;
}

/* -------------------------------------------------------------------------- */
/* Pinecone                                                                    */
/* -------------------------------------------------------------------------- */

async function getIndex() {
  if (indexInstance) return indexInstance;

  const apiKey = process.env.PINECONE_API_KEY;
  const indexName =
    process.env.MULTILINGUAL_PINECONE_INDEX_NAME ||
    DEFAULT_INDEX_NAME;

  if (!apiKey) {
    throw new Error("Missing PINECONE_API_KEY in environment.");
  }

  const client = new Pinecone({ apiKey });

  indexInstance = client.index(indexName);

  console.log(
    `[Pinecone] Multilingual index=${indexName}, namespace=${NAMESPACE}`
  );

  return indexInstance;
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
/* Metadata helpers                                                            */
/* -------------------------------------------------------------------------- */

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;

  if (typeof value !== "string") return value;

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
    getMetadataValue(
      metadata,
      "visuals",
      "visualsJson"
    ),
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

    metadata,
  };
}

/* -------------------------------------------------------------------------- */
/* Build semantic content from trusted question fields                        */
/* -------------------------------------------------------------------------- */

/**
 * Do not use the stored chapter name for semantic relevance.
 *
 * The meaningful content comes from:
 * questionText, topic, subQuestions, and tags.
 */
function buildQuestionEmbeddingText(question) {
  const subQuestions = (question.subQuestions ?? [])
    .map((item) => {
      if (typeof item === "string") return item;

      if (item && typeof item === "object") {
        return [
          item.label,
          item.text,
        ]
          .filter(
            (value) =>
              typeof value === "string" && value.trim()
          )
          .join(": ");
      }

      return "";
    })
    .filter(Boolean);

  const tags = (question.tags ?? [])
    .filter(
      (tag) =>
        typeof tag === "string" && tag.trim()
    );

  return [
    question.questionText,
    question.topic,
    ...subQuestions,
    ...tags,
  ]
    .filter(
      (value) =>
        typeof value === "string" && value.trim()
    )
    .join("\n");
}

/**
 * Build the search intent from the user's request.
 *
 * The requested chapter can provide context, but stored chapter
 * metadata is never used to rank candidate question content.
 */
function buildSearchText({
  query,
  subject,
  chapter,
  className,
}) {
  return [
    `CBSE Class ${className}`,
    subject ? `Subject: ${subject}` : "",
    chapter ? `Requested chapter: ${chapter}` : "",
    typeof query === "string" ? query.trim() : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* Similarity and deduplication                                                 */
/* -------------------------------------------------------------------------- */

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

function getQuestionIdentity(question) {
  const identity = normalizeText(question.questionText);

  if (identity) return identity;

  return String(question.id);
}

/* -------------------------------------------------------------------------- */
/* Main retrieval                                                              */
/* -------------------------------------------------------------------------- */

export async function retrieveMultilingualPyqs({
  query = "",
  topK = DEFAULT_TOP_K,
  candidatePool = DEFAULT_CANDIDATE_POOL,
  className,
  subject,
  chapter,
}) {
  if (!className) {
    throw new Error(
      "className is required for multilingual PYQ retrieval."
    );
  }

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
   * Stage 1:
   * Embed the user's search intent using BGE-M3.
   */
  const searchText = buildSearchText({
    query,
    subject,
    chapter,
    className: normalizedClass,
  });

  const queryVector = await generateEmbedding(searchText);

  const index = await getIndex();
  const namespace = index.namespace(NAMESPACE);

  /*
   * Filter only by class.
   *
   * Do not filter by stored chapter, topic, or subject labels:
   * these metadata labels may be inconsistent.
   */
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
    `[Multilingual Pinecone] class=${normalizedClass}, ` +
      `requested=${poolSize}, returned=${matches.length}`
  );

  if (!matches.length) {
    console.warn(
      "[Multilingual Pinecone] No candidates found. " +
        "Check the index, namespace, className metadata, and stored vectors."
    );

    return [];
  }

  /*
   * Stage 2:
   * Extract usable questions and deduplicate identical wording.
   */
  const uniqueCandidates = new Map();

  for (const match of matches) {
    const question = extractMetadata(match);

    const content = buildQuestionEmbeddingText(question);

    if (!content.trim()) {
      continue;
    }

    const identity = getQuestionIdentity(question);
    const existing = uniqueCandidates.get(identity);

    if (
      !existing ||
      question.pineconeScore > existing.pineconeScore
    ) {
      uniqueCandidates.set(identity, {
        ...question,
        semanticContent: content,
      });
    }
  }

  const candidates = [...uniqueCandidates.values()];

  /*
   * Stage 3:
   * Embed each candidate using questionText, topic,
   * subQuestions, and tags. Never use stored chapter labels.
   */
  const reranked = [];

  for (const question of candidates) {
    try {
      const contentVector = await generateEmbedding(
        question.semanticContent
      );

      const semanticScore = cosineSimilarity(
        queryVector,
        contentVector
      );

      reranked.push({
        ...question,
        score: Number(semanticScore.toFixed(4)),
      });
    } catch (error) {
      console.error(
        `[Multilingual Pinecone] Reranking failed for ${question.id}:`,
        error.message
      );
    }
  }

  reranked.sort((a, b) => b.score - a.score);

  const finalResults = reranked
    .slice(0, requestedTopK)
    .map(({ semanticContent, ...question }) => question);

  console.log(
    `[Multilingual Pinecone] candidates=${candidates.length}, ` +
      `reranked=${reranked.length}, returned=${finalResults.length}`
  );

  console.log(
    "[Multilingual Pinecone] Top semantic matches:",
    finalResults.slice(0, 10).map((question) => ({
      id: question.id,
      className: question.className,
      topic: question.topic,
      questionText: question.questionText,
      subQuestionCount: question.subQuestions.length,
      tags: question.tags,
      semanticScore: question.score,
      pineconeScore: question.pineconeScore,
    }))
  );

  return finalResults;
}
