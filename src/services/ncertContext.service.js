import { generateNcertEmbedding } from "./ncertEmbedding.service.js";
import { getNcertIndex } from "./ncertPinecone.service.js";

const DEFAULT_TOP_K = 8;
const DEFAULT_CANDIDATE_POOL = 50;
const MAX_TOP_K = 20;
const MAX_CONTEXT_CHARS = 18000;

const ALLOWED_RECORD_TYPES = [
  "ncert_content",
  "ncert_question",
  "ncert_question_part",
];

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeClass(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  const match = normalized.match(
    /^(?:class\s*)?(\d+)(?:st|nd|rd|th)?$/
  );

  return match ? String(Number(match[1])) : normalized;
}

function getMetadataText(metadata, ...keys) {
  for (const key of keys) {
    const value = metadata?.[key];

    if (value !== undefined && value !== null) {
      return String(value);
    }
  }

  return "";
}

/* -------------------------------------------------------------------------- */
/* Metadata extraction                                                        */
/* -------------------------------------------------------------------------- */

function extractChunk(match) {
  const metadata = match.metadata ?? {};

  return {
    id: match.id,
    score: Number(match.score ?? 0),

    recordType: metadata.recordType ?? null,

    className: getMetadataText(metadata, "className"),
    subject: getMetadataText(metadata, "subject"),

    bookId: getMetadataText(metadata, "bookId"),
    bookName: getMetadataText(metadata, "bookName"),

    chapterId: getMetadataText(metadata, "chapterId"),
    chapterNumber: getMetadataText(metadata, "chapterNumber"),
    chapterName: getMetadataText(metadata, "chapterName"),

    blockId: getMetadataText(metadata, "blockId"),
    blockType: getMetadataText(metadata, "blockType"),
    blockTitle: getMetadataText(
      metadata,
      "blockTitle",
      "sectionName"
    ),

    chunkId: getMetadataText(metadata, "chunkId"),

    content: getMetadataText(
      metadata,
      "content",
      "embeddingText"
    ),

    metadata,
  };
}

/* -------------------------------------------------------------------------- */
/* Relevance scoring                                                          */
/* -------------------------------------------------------------------------- */

function calculateRelevance(chunk, { subject, chapter }) {
  let score = chunk.score;

  const normalizedSubject = normalizeText(subject);
  const normalizedChapter = normalizeText(chapter);

  const chunkSubject = normalizeText(chunk.subject);
  const chunkChapter = normalizeText(chunk.chapterName);
  const chunkContent = normalizeText(chunk.content);

  if (
    normalizedSubject &&
    chunkSubject &&
    chunkSubject === normalizedSubject
  ) {
    score += 0.15;
  }

  if (
    normalizedChapter &&
    chunkChapter &&
    (
      chunkChapter.includes(normalizedChapter) ||
      normalizedChapter.includes(chunkChapter)
    )
  ) {
    score += 0.25;
  }

  if (
    normalizedChapter &&
    chunkContent.includes(normalizedChapter)
  ) {
    score += 0.05;
  }

  return score;
}

/* -------------------------------------------------------------------------- */
/* Deduplication                                                              */
/* -------------------------------------------------------------------------- */

function deduplicateChunks(chunks) {
  const uniqueChunks = new Map();

  for (const chunk of chunks) {
    const identity =
      chunk.chunkId ||
      chunk.blockId ||
      chunk.id;

    const existing = uniqueChunks.get(identity);

    if (!existing || chunk.score > existing.score) {
      uniqueChunks.set(identity, chunk);
    }
  }

  return [...uniqueChunks.values()];
}

/* -------------------------------------------------------------------------- */
/* Context builder                                                            */
/* -------------------------------------------------------------------------- */

function buildContext(chunks) {
  const contextParts = [];
  let totalChars = 0;

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];

    const content = chunk.content.trim();

    if (!content) continue;

    const source = [
      `[SOURCE ${index + 1}]`,
      `Book: ${chunk.bookName || "NCERT"}`,
      `Subject: ${chunk.subject || "Unknown"}`,
      `Chapter: ${chunk.chapterName || "Unknown"}`,
      `Section: ${chunk.blockTitle || "General"}`,
      `Content:\n${content}`,
    ].join("\n");

    if (totalChars + source.length > MAX_CONTEXT_CHARS) {
      break;
    }

    contextParts.push(source);
    totalChars += source.length;
  }

  return contextParts.join("\n\n---\n\n");
}

/* -------------------------------------------------------------------------- */
/* Main NCERT retrieval                                                       */
/* -------------------------------------------------------------------------- */

export async function retrieveNcertContext({
  query,
  className,
  subject,
  chapter,
  topK = DEFAULT_TOP_K,
  candidatePool = DEFAULT_CANDIDATE_POOL,
}) {
  if (!className) {
    throw new Error("className is required for NCERT retrieval");
  }

  if (typeof query !== "string" || !query.trim()) {
    throw new Error("A non-empty query is required for NCERT retrieval");
  }

  const normalizedClass = normalizeClass(className);

  const requestedTopK = Math.max(
    1,
    Math.min(Number(topK) || DEFAULT_TOP_K, MAX_TOP_K)
  );

  const poolSize = Math.max(
    requestedTopK,
    Math.min(
      Number(candidatePool) || DEFAULT_CANDIDATE_POOL,
      200
    )
  );

  const relevanceQuery = [
    `NCERT Class ${normalizedClass}`,
    subject ? `Subject: ${subject}` : "",
    chapter ? `Chapter: ${chapter}` : "",
    query.trim(),
  ]
    .filter(Boolean)
    .join(". ");

  console.log(
    `[NCERT Retrieval] Generating embedding for class ${normalizedClass}`
  );

  const queryVector = await generateNcertEmbedding(relevanceQuery);

  const index = getNcertIndex();

  const result = await index.query({
    vector: queryVector,
    topK: poolSize,
    filter: {
      className: normalizedClass,
      recordType: {
        $in: ALLOWED_RECORD_TYPES,
      },
    },
    includeMetadata: true,
  });

  const matches = result.matches ?? [];

  console.log(
    `[NCERT Pinecone] class=${normalizedClass}, ` +
    `requested=${poolSize}, returned=${matches.length}`
  );

  if (!matches.length) {
    console.warn(
      "[NCERT Retrieval] No results found. Check className, " +
      "recordType, namespace, and stored metadata."
    );

    return {
      context: "",
      totalRetrieved: 0,
      totalSelected: 0,
      sources: [],
    };
  }

  // Strict class validation as an additional safeguard.
  const classFiltered = matches
    .map(extractChunk)
    .filter(
      (chunk) =>
        normalizeClass(chunk.className) === normalizedClass
    )
    .filter((chunk) => chunk.content.trim());

  // Prioritize subject and chapter without discarding
  // potentially useful same-class content.
  const ranked = classFiltered
    .map((chunk) => ({
      ...chunk,
      relevanceScore: calculateRelevance(chunk, {
        subject,
        chapter,
      }),
    }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  const uniqueChunks = deduplicateChunks(ranked);

  const selectedChunks = uniqueChunks.slice(0, requestedTopK);

  const context = buildContext(selectedChunks);

  const sources = selectedChunks.map((chunk) => ({
    id: chunk.id,
    recordType: chunk.recordType,
    bookName: chunk.bookName,
    subject: chunk.subject,
    chapterName: chunk.chapterName,
    sectionName: chunk.blockTitle,
    score: Number(chunk.score.toFixed(4)),
    relevanceScore: Number(chunk.relevanceScore.toFixed(4)),
  }));

  console.log(
    `[NCERT Retrieval] classFiltered=${classFiltered.length}, ` +
    `unique=${uniqueChunks.length}, ` +
    `selected=${selectedChunks.length}`
  );

  return {
    context,
    totalRetrieved: matches.length,
    totalSelected: selectedChunks.length,
    sources,
  };
}