import { pipeline } from "@xenova/transformers";

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIMENSIONS = 384;

let embeddingPipeline = null;

/**
 * Load the embedding model once and reuse it.
 */
async function getEmbeddingPipeline() {
  if (!embeddingPipeline) {
    embeddingPipeline = pipeline(
      "feature-extraction",
      MODEL_NAME
    );
  }

  return embeddingPipeline;
}

/**
 * Generate a normalized 384-dimensional embedding.
 */
export async function generateNcertEmbedding(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(
      "A non-empty string is required for NCERT embedding"
    );
  }

  const extractor = await getEmbeddingPipeline();

  const output = await extractor(text.trim(), {
    pooling: "mean",
    normalize: true,
  });

  const vector = Array.from(output.data);

  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Invalid NCERT embedding dimensions. Expected ` +
      `${EMBEDDING_DIMENSIONS}, received ${vector.length}`
    );
  }

  return vector;
}