import "dotenv/config";
import { retrieveNcertContext } from "../services/ncertContext.service.js";

const runTest = async () => {
  try {
  const result = await retrieveNcertContext({
  query: "Explain the tangent to a circle and its properties.",
  className: "10",
  subject: "Mathematics",
  chapter: "Circles",
  topK: 8,
  candidatePool: 50,
});

    console.log("\n========== NCERT RETRIEVAL TEST ==========");

    console.log("Total Retrieved:", result.totalRetrieved);
    console.log("Total Selected:", result.totalSelected);

    console.log("\n---------- SOURCES ----------");
    console.log(JSON.stringify(result.sources, null, 2));

    console.log("\n---------- RETRIEVED CONTEXT ----------");
    console.log(result.context || "No context returned");

    console.log("\n=========================================");

    if (!result.totalSelected || !result.context) {
      throw new Error("No NCERT context was retrieved");
    }

    console.log("\nNCERT RETRIEVAL TEST PASSED");
  } catch (error) {
    console.error("\nNCERT RETRIEVAL TEST FAILED:", error);
    process.exitCode = 1;
  }
};

runTest();