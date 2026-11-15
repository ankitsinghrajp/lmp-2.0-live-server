
import "dotenv/config";
import { Pinecone } from "@pinecone-database/pinecone";

const INDEX_NAME =
  process.env.MULTILINGUAL_PINECONE_INDEX_NAME ||
  "lmp-pyq-multilingual";

const NAMESPACE = "pyqs";
const BATCH_SIZE = 100;

async function main() {
  const client = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY,
  });

  const namespace = client.index(INDEX_NAME).namespace(NAMESPACE);

  let paginationToken;
  let scanned = 0;
  let updated = 0;

  do {
    const page = await namespace.listPaginated({
      limit: BATCH_SIZE,
      ...(paginationToken ? { paginationToken } : {}),
    });

    const ids = (page.vectors ?? [])
      .map((vector) => vector.id)
      .filter(Boolean);

    paginationToken = page.pagination?.next;
    scanned += ids.length;

    if (!ids.length) continue;

    const response = await namespace.fetch({ ids });
    const records = response.records ?? response.vectors ?? {};

    for (const id of ids) {
      const metadata = records[id]?.metadata;

      if (
        typeof metadata?.questionId !== "string" ||
        !metadata.questionId.includes("class12")
      ) {
        continue;
      }

      const correctedQuestionId = metadata.questionId.replace(
        /class12/g,
        "class10"
      );

      await namespace.update({
        id, // Keep the actual vector ID unchanged.
        metadata: {
          questionId: correctedQuestionId,
        },
      });

      updated++;
    }

    console.log(`Scanned: ${scanned}; updated: ${updated}`);
  } while (paginationToken);

  console.log("Finished.");
  console.log("Total scanned:", scanned);
  console.log("questionId fields updated:", updated);
}

main().catch((error) => {
  console.error("Update failed:", error);
  process.exitCode = 1;
});
