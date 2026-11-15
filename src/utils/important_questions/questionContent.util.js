
function parseJsonValue(value, fallback = []) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatQuestionPart(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";

  const label = value.label ?? value.part ?? value.name ?? "";
  const text =
    value.text ??
    value.questionText ??
    value.question ??
    value.value ??
    value.description ??
    "";

  return [label, text].filter(Boolean).join(" ").trim();
}

export function getCompleteQuestionText(question) {
  const parts = [];

  const mainText = String(
    question.questionText ?? question.question ?? ""
  ).trim();

  if (mainText) parts.push(mainText);

  const subQuestions = parseJsonValue(
    question.subQuestions ?? question.subQuestionsJson,
    []
  );

  if (Array.isArray(subQuestions)) {
    for (const part of subQuestions) {
      const formatted = formatQuestionPart(part);
      if (formatted) parts.push(formatted);
    }
  }

  const options = parseJsonValue(
    question.options ?? question.optionsJson,
    []
  );

  if (Array.isArray(options) && options.length) {
    const formattedOptions = options
      .map(formatQuestionPart)
      .filter(Boolean);

    if (formattedOptions.length) {
      parts.push(`Options: ${formattedOptions.join("; ")}`);
    }
  }

  const formulas = parseJsonValue(
    question.formulas ?? question.formulasJson,
    []
  );

  if (Array.isArray(formulas) && formulas.length) {
    parts.push(`Formulas: ${formulas.map(formatQuestionPart).filter(Boolean).join("; ")}`);
  }

  const tables = parseJsonValue(
    question.tables ?? question.tablesJson,
    []
  );

  if (Array.isArray(tables) && tables.length) {
    parts.push(`Tables: ${tables.map(formatQuestionPart).filter(Boolean).join("\n")}`);
  }

  const diagrams = parseJsonValue(
    question.diagrams ?? question.diagramsJson ?? question.visuals ?? question.visualsJson,
    []
  );

  if (Array.isArray(diagrams) && diagrams.length) {
    parts.push(`Diagrams: ${diagrams.map(formatQuestionPart).filter(Boolean).join("; ")}`);
  }

  const graphs = parseJsonValue(
    question.graphs ?? question.graphsJson,
    []
  );

  if (Array.isArray(graphs) && graphs.length) {
    parts.push(`Graphs: ${graphs.map(formatQuestionPart).filter(Boolean).join("; ")}`);
  }

  return [...new Set(parts)].join("\n").slice(0, 3000);
}

export function rankPyqs(questions) {
  return [...questions]
    .filter(
      (question) =>
        Number.isFinite(Number(question.score)) &&
        getCompleteQuestionText(question).trim().length > 0
    )
    .sort((a, b) => Number(b.score) - Number(a.score));
}
