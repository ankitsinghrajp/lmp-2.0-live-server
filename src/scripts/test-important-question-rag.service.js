
import "dotenv/config";
import { generateImportantQuestionsWithRag } from "../services/importantQuestionRag.service.js";

async function main() {
  console.log("Testing RAG Important Questions generation...\n");

  const result = await generateImportantQuestionsWithRag({
    className: "10",
    subject: "Science",
    chapter: "Chemical Reactions and Equations",
    topK: 10,
  });

  // Confirm the service returned a JavaScript object.
  if (!result || typeof result !== "object") {
    throw new Error("Expected a JSON object");
  }

  const requiredFields = [
    "chapter",
    "whyImportant",
    "importantQuestions",
    "mustPracticeNumericals",
    "veryShortQuestions",
    "longAnswerQuestions",
    "examStrategy",
  ];

  for (const field of requiredFields) {
    if (!(field in result)) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  console.log("PASS: Required JSON fields are present.");
  console.log("Chapter:", result.chapter);
  console.log(
    "Important questions:",
    result.importantQuestions.length
  );
  console.log(
    "Numericals:",
    result.mustPracticeNumericals.length
  );
  console.log(
    "Very short questions:",
    result.veryShortQuestions.length
  );
  console.log(
    "Long answer questions:",
    result.longAnswerQuestions.length
  );
  console.log("Exam strategy items:", result.examStrategy.length);
  console.log(
    "Retrieved PYQs:",
    result._ragMetadata?.retrievedQuestionCount
  );

  console.log("\nGenerated JSON:\n");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("\nRAG generation test failed:");
  console.error(error.message);
  process.exitCode = 1;
});
