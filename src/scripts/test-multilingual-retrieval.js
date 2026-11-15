
import "dotenv/config";
import { retrieveMultilingualPyqs } from "../services/multilingualPyqRetrieval.service.js";

const TEST_CASES = [
  {
    name: "Hindi — Letter Writing",
    className: "12",
    subject: "Hindi",
    chapter: "Hindi: Antara Part 2",
    query:
      "पत्र लेखन, प्रधानाचार्य को पत्र, प्रशंसनीय व्यवहार का वर्णन, औपचारिक पत्र",
    expectedConcepts: [
      "पत्र",
      "प्रधानाचार्य",
      "व्यवहार",
      "लिखिए",
      "लिखिए।",
    ],
  },
  {
    name: "Hindi — Poetry Comprehension",
    className: "12",
    subject: "Hindi",
    chapter: "Hindi: Aaroh Part 2",
    query:
      "काव्य सौंदर्य, कविता का आशय, विरह वेदना, काव्य पंक्तियों की व्याख्या",
    expectedConcepts: [
      "काव्य",
      "कविता",
      "विरह",
      "पंक्तियों",
      "आशय",
    ],
  },
  {
    name: "Sanskrit — Grammar and Text",
    className: "10",
    subject: "Sanskrit",
    chapter: "Sanskrit: Bhaswati",
    query:
      "संस्कृत पाठ के प्रश्न, श्लोक का अर्थ, व्याकरण, शब्द रूप और धातु रूप",
    expectedConcepts: [
      "श्लोक",
      "अर्थ",
      "व्याकरण",
      "शब्द",
      "धातु",
    ],
  },
];

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getQuestionText(question) {
  const subQuestions = Array.isArray(question.subQuestions)
    ? question.subQuestions
        .map((item) =>
          typeof item === "string" ? item : item?.text ?? ""
        )
        .filter(Boolean)
    : [];

  const tags = Array.isArray(question.tags)
    ? question.tags
    : [];

  return normalize(
    [
      question.questionText,
      question.topic,
      ...subQuestions,
      ...tags,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function getSubQuestions(question) {
  return (question.subQuestions ?? [])
    .map((item) =>
      typeof item === "string" ? item : item?.text ?? ""
    )
    .filter(Boolean);
}

function calculateLexicalOverlap(question, expectedConcepts) {
  const text = getQuestionText(question);

  const matches = expectedConcepts.filter((concept) =>
    text.includes(normalize(concept))
  );

  return {
    matched: matches,
    count: matches.length,
    total: expectedConcepts.length,
    ratio: matches.length / expectedConcepts.length,
  };
}

function printQuestion(question, index, expectedConcepts) {
  const overlap = calculateLexicalOverlap(
    question,
    expectedConcepts
  );

  console.log(`\n${index + 1}. ${question.questionText}`);
  console.log("ID:", question.id);
  console.log("Topic:", question.topic ?? "N/A");
  console.log("Stored chapter:", question.chapter ?? "N/A");
  console.log("Year:", question.year ?? "N/A");
  console.log("Pinecone score:", question.pineconeScore ?? "N/A");
  console.log("Semantic score:", question.score ?? "N/A");
  console.log("Tags:", JSON.stringify(question.tags ?? []));
  console.log("Subquestions:", getSubQuestions(question).length);
  console.log(
    "Concept overlap:",
    `${overlap.count}/${overlap.total}`,
    overlap.matched.length
      ? `(${overlap.matched.join(", ")})`
      : "(none)"
  );

  for (const subQuestion of getSubQuestions(question)) {
    console.log("  -", subQuestion);
  }
}

async function runTest(testCase) {
  console.log("\n" + "=".repeat(80));
  console.log("TEST:", testCase.name);
  console.log("Class:", testCase.className);
  console.log("Subject:", testCase.subject);
  console.log("Requested chapter:", testCase.chapter);
  console.log("Query:", testCase.query);
  console.log("=".repeat(80));

  const startedAt = Date.now();

  const results = await retrieveMultilingualPyqs({
    query: testCase.query,
    topK: 10,
    candidatePool: 100,
    className: testCase.className,
    subject: testCase.subject,
    chapter: testCase.chapter,
  });

  const elapsedMs = Date.now() - startedAt;

  console.log("\nRESULT COUNT:", results.length);
  console.log("TIME:", `${(elapsedMs / 1000).toFixed(2)} seconds`);

  if (!results.length) {
    console.error(
      "FAIL: No results returned. Check index, namespace, and class metadata."
    );

    return {
      name: testCase.name,
      count: 0,
      elapsedMs,
      pass: false,
    };
  }

  const normalizedClass = String(testCase.className)
    .replace(/^class\s*/i, "")
    .trim();

  let wrongClassCount = 0;
  let emptyContentCount = 0;

  const seen = new Set();
  let duplicateCount = 0;

  results.forEach((question, index) => {
    printQuestion(question, index, testCase.expectedConcepts);

    if (
      String(question.className ?? "").replace(/^class\s*/i, "").trim() !==
      normalizedClass
    ) {
      wrongClassCount += 1;
    }

    if (!getQuestionText(question)) {
      emptyContentCount += 1;
    }

    const identity = normalize(question.questionText);

    if (identity && seen.has(identity)) {
      duplicateCount += 1;
    }

    if (identity) seen.add(identity);
  });

  const overlapScores = results.map((question) =>
    calculateLexicalOverlap(
      question,
      testCase.expectedConcepts
    ).ratio
  );

  const averageOverlap =
    overlapScores.reduce((sum, score) => sum + score, 0) /
    overlapScores.length;

  const summary = {
    name: testCase.name,
    count: results.length,
    elapsedMs,
    wrongClassCount,
    emptyContentCount,
    duplicateCount,
    averageConceptOverlap: Number(averageOverlap.toFixed(3)),
    pass:
      results.length > 0 &&
      wrongClassCount === 0 &&
      emptyContentCount === 0,
  };

  console.log("\nTEST SUMMARY");
  console.log(JSON.stringify(summary, null, 2));

  return summary;
}

async function main() {
  const summaries = [];

  for (const testCase of TEST_CASES) {
    try {
      summaries.push(await runTest(testCase));
    } catch (error) {
      console.error(`\nTEST FAILED: ${testCase.name}`);
      console.error(error.stack ?? error);

      summaries.push({
        name: testCase.name,
        pass: false,
        error: error.message,
      });
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("OVERALL RESULTS");
  console.log("=".repeat(80));
  console.table(summaries);

  const passed = summaries.filter((item) => item.pass).length;

  console.log(`Passed: ${passed}/${summaries.length}`);

  if (passed !== summaries.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Retrieval test failed:", error);
  process.exitCode = 1;
});
