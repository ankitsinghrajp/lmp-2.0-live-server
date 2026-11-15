import { Pinecone } from "@pinecone-database/pinecone";

const API_KEY = process.env.PINECONE_API_KEY;

if (!API_KEY) {
  throw new Error("PINECONE_API_KEY is missing");
}

export const pinecone = new Pinecone({
  apiKey: API_KEY,
});