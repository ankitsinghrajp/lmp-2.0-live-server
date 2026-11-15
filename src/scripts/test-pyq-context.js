
import { retrievePyqs } from "../services/pyqRetrieval.service.js";
import {
  buildPyqContext,
  formatPyqContext,
} from "../services/pyqContext.service.js";

async function main() {
  console.log("Fetching real PYQs from Pinecone...\n");

  const questions = await retrievePyqs({
    query:
      "CBSE Class 10 Science chemical reactions, decomposition and balancing equations",
    topK: 10,
    className: "10",
    subject: "Science",
    chapter: "Chemical Reactions and Equations",
  });

  console.log("Retrieved questions:", questions.length);

  if (questions.length === 0) {
    console.log(
      "No matching records found. Check the retrieval filters before proceeding."
    );
    return;
  }

  const context = buildPyqContext(questions);

  console.log("Unique questions:", context.totalQuestions);
  console.log("\nTopic summary:");

  for (const topic of context.topics) {
    console.log({
      topic: topic.topic,
      questionCount: topic.questionCount,
      years: topic.years,
      yearCount: topic.yearCount,
      averageMarks: topic.averageMarks,
    });
  }

  console.log("\nFormatted context for the LLM:\n");
  console.log(formatPyqContext(context));

  if (context.totalQuestions !== questions.length) {
    console.warn(
      "\nNote: duplicate question IDs were removed during context preparation."
    );
  }

  console.log("\nPASS: Live retrieval and context preparation completed.");
}

main().catch((error) => {
  console.error("Live context test failed:", error);
  process.exitCode = 1;
});
