import { pinecone } from "../db/pineconeClient.js";

const INDEX_NAME =
  process.env.NCERT_INDEX_NAME || "lastminutepreparation-ncert";

const NAMESPACE = "ncert";

export const getNcertIndex = () => {
  return pinecone.index(INDEX_NAME).namespace(NAMESPACE);
};

export const testNcertPineconeConnection = async () => {
  try {
    const index = pinecone.index(INDEX_NAME);
    const stats = await index.describeIndexStats();

    console.log("[NCERT Pinecone] Connection successful");
    console.log("[NCERT Pinecone] Index:", INDEX_NAME);
    console.log("[NCERT Pinecone] Namespace:", NAMESPACE);
    console.log("[NCERT Pinecone] Dimension:", stats.dimension);
    console.log(
      "[NCERT Pinecone] Vector count:",
      stats.totalRecordCount ?? stats.totalVectorCount
    );

    return stats;
  } catch (error) {
    console.error("[NCERT Pinecone] Connection failed:", error);
    throw error;
  }
};