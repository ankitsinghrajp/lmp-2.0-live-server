
function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseJson(value, fallback = []) {
  if (value == null || value === "") return fallback;

  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* Build complete semantic question content                                   */
/* -------------------------------------------------------------------------- */

function getQuestionContent(question) {
  const parts = [];

  // Main question
  if (question.questionText) {
    parts.push(String(question.questionText).trim());
  }

  // Topic: useful semantic information, not chapter metadata
  if (typeof question.topic === "string" && question.topic.trim()) {
    parts.push(`Topic: ${question.topic.trim()}`);
  }

  // Subquestions
  const subQuestions = parseJson(question.subQuestions, []);

  if (Array.isArray(subQuestions)) {
    for (const subQuestion of subQuestions) {
      if (typeof subQuestion === "string") {
        parts.push(subQuestion.trim());
      } else if (subQuestion && typeof subQuestion === "object") {
        const label = subQuestion.label
          ? `${subQuestion.label} `
          : "";

        const text =
          subQuestion.text ??
          subQuestion.questionText ??
          "";

        if (text) {
          parts.push(`${label}${text}`.trim());
        }
      }
    }
  }

  // Tags
  const tags = parseJson(question.tags, []);

  if (Array.isArray(tags) && tags.length) {
    const validTags = tags
      .filter(
        (tag) => typeof tag === "string" && tag.trim()
      )
      .map((tag) => tag.trim());

    if (validTags.length) {
      parts.push(`Tags: ${validTags.join("; ")}`);
    }
  }

  // Options
  const options = parseJson(question.options, []);

  if (Array.isArray(options) && options.length) {
    const formattedOptions = options
      .map((option) => {
        if (typeof option === "string") return option;

        if (!option || typeof option !== "object") {
          return "";
        }

        return [option.label, option.text ?? option.value]
          .filter(Boolean)
          .join(" ");
      })
      .filter(Boolean);

    if (formattedOptions.length) {
      parts.push(`Options: ${formattedOptions.join("; ")}`);
    }
  }

  // Visual descriptions
  const visuals = parseJson(question.visuals, []);

  if (Array.isArray(visuals) && visuals.length) {
    const descriptions = visuals
      .map((visual) => {
        if (typeof visual === "string") return visual;

        if (!visual || typeof visual !== "object") {
          return "";
        }

        return (
          visual.description ??
          visual.caption ??
          visual.alt ??
          visual.text ??
          ""
        );
      })
      .filter(Boolean);

    if (descriptions.length) {
      parts.push(`Visuals: ${descriptions.join("; ")}`);
    }
  }

  return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Deduplication                                                               */
/* -------------------------------------------------------------------------- */

function getQuestionIdentity(question) {
  // Include the full available content to avoid merging questions
  // that share a generic questionText but have different subquestions.
  const content = normalizeText(getQuestionContent(question));

  return content || question.id;
}

function getRelevanceScore(question) {
  const score = Number(question.score);
  return Number.isFinite(score) ? score : 0;
}

function getValidYear(question) {
  const year = Number(question.year);

  return Number.isInteger(year) && year > 0 ? year : null;
}

function getValidMarks(question) {
  const marks = Number(question.marks);

  return Number.isFinite(marks) && marks > 0 ? marks : null;
}

/* -------------------------------------------------------------------------- */
/* Build PYQ context                                                           */
/* -------------------------------------------------------------------------- */

export function buildPyqContext(questions = []) {
  if (!Array.isArray(questions)) {
    throw new TypeError("questions must be an array");
  }

  const uniqueQuestions = new Map();

  for (const question of questions) {
    if (
      !question ||
      !question.id ||
      typeof question.questionText !== "string" ||
      !question.questionText.trim()
    ) {
      continue;
    }

    const identity = getQuestionIdentity(question);
    const existing = uniqueQuestions.get(identity);

    if (
      !existing ||
      getRelevanceScore(question) >
        getRelevanceScore(existing)
    ) {
      uniqueQuestions.set(identity, question);
    }
  }

  // Preserve semantic retrieval ranking.
  const normalizedQuestions = [...uniqueQuestions.values()].sort(
    (a, b) =>
      getRelevanceScore(b) - getRelevanceScore(a)
  );

  const topicMap = new Map();

  for (const question of normalizedQuestions) {
    // Used for organizing statistics only.
    // Never use this label to decide semantic relevance.
    const topic =
      String(question.topic ?? "").trim() ||
      "Uncategorized";

    if (!topicMap.has(topic)) {
      topicMap.set(topic, {
        topic,
        questions: [],
        years: new Set(),
        totalMarks: 0,
        marksCount: 0,
        questionTypes: new Set(),
        bestSimilarity: 0,
        totalSimilarity: 0,
        similarityCount: 0,
      });
    }

    const group = topicMap.get(topic);
    const relevance = getRelevanceScore(question);

    group.questions.push(question);
    group.bestSimilarity = Math.max(
      group.bestSimilarity,
      relevance
    );
    group.totalSimilarity += relevance;
    group.similarityCount += 1;

    const year = getValidYear(question);

    if (year !== null) {
      group.years.add(year);
    }

    const marks = getValidMarks(question);

    if (marks !== null) {
      group.totalMarks += marks;
      group.marksCount += 1;
    }

    if (question.questionType) {
      group.questionTypes.add(question.questionType);
    }
  }

  const topics = [...topicMap.values()]
    .map((group) => ({
      topic: group.topic,
      questionCount: group.questions.length,

      years: [...group.years].sort(
        (a, b) => a - b
      ),

      yearCount: group.years.size,

      averageMarks: group.marksCount
        ? Number(
            (
              group.totalMarks / group.marksCount
            ).toFixed(2)
          )
        : null,

      questionTypes: [...group.questionTypes],

      bestSimilarity: Number(
        group.bestSimilarity.toFixed(4)
      ),

      averageSimilarity: group.similarityCount
        ? Number(
            (
              group.totalSimilarity /
              group.similarityCount
            ).toFixed(4)
          )
        : 0,

      questions: group.questions.sort(
        (a, b) =>
          getRelevanceScore(b) -
          getRelevanceScore(a)
      ),
    }))
    .sort(
      (a, b) =>
        b.bestSimilarity - a.bestSimilarity ||
        b.averageSimilarity - a.averageSimilarity ||
        b.yearCount - a.yearCount ||
        b.questionCount - a.questionCount
    );

  return {
    totalQuestions: normalizedQuestions.length,
    topics,
    questions: normalizedQuestions,
  };
}

/* -------------------------------------------------------------------------- */
/* Format context for the generation prompt                                    */
/* -------------------------------------------------------------------------- */

export function formatPyqContext(context) {
  if (!context || !Array.isArray(context.questions)) {
    throw new TypeError("A valid PYQ context is required");
  }

  return context.topics
    .map((topicGroup) => {
      const questionsText = topicGroup.questions
        .map((question) => {
          const details = [
            question.year
              ? `Year: ${question.year}`
              : null,

            question.marks
              ? `Marks: ${question.marks}`
              : null,

            question.questionType
              ? `Type: ${question.questionType}`
              : null,

            question.id
              ? `ID: ${question.id}`
              : null,

            Number.isFinite(Number(question.score))
              ? `Relevance: ${Number(question.score).toFixed(4)}`
              : null,
          ]
            .filter(Boolean)
            .join(" | ");

          return [
            `- ${details}`,
            `  Complete question:\n${getQuestionContent(question)}`,
          ].join("\n");
        })
        .join("\n\n");

      return [
        `Topic label: ${topicGroup.topic}`,
        `Recorded appearances: ${topicGroup.yearCount} distinct year(s)`,
        `Years: ${topicGroup.years.join(", ") || "Unknown"}`,
        `Average marks: ${topicGroup.averageMarks ?? "Unknown"}`,
        questionsText,
      ].join("\n");
    })
    .join("\n\n");
}
