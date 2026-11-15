
import "dotenv/config";
import { retrievePyqs } from "../services/pyqRetrieval.service.js";

async function main() {
  console.log("Testing Pinecone PYQ retrieval...\n");

  const questions = await retrievePyqs({
    query: "Important CBSE Class 10 Science questions about chemical reactions and equations",
    topK: 5,
    className: "10",
    subject: "Science",
    chapter: "Chemical Reactions and Equations",
  });

  console.log(`Retrieved ${questions.length} questions.\n`);

  if (questions.length === 0) {
    console.log(
      "No matches found. We need to verify the metadata filters and stored values."
    );
    return;
  }

  for (const [index, question] of questions.entries()) {
    console.log(`--- Question ${index + 1} ---`);
    console.log("ID:", question.id);
    console.log("Similarity:", question.score);
    console.log("Class:", question.className);
    console.log("Subject:", question.subject);
    console.log("Year:", question.year);
    console.log("Chapter:", question.chapter);
    console.log("Topic:", question.topic);
    console.log("Marks:", question.marks);
    console.log("Question:", question.questionText);
    console.log("Verification:", question.verificationStatus);
    console.log();
  }
}

main().catch((error) => {
  console.error("Retrieval test failed:", error.message);
  process.exitCode = 1;
});
