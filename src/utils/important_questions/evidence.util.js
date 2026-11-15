import { normalizeQuestionForDeduplication } from "./duplicateDetection.util.js";
import { getCompleteQuestionText } from "./questionContent.util.js";

export function getEvidenceIds(questions) {
  return new Set(
    questions
      .flatMap((question) => [
        question.id,
        question.questionId,
      ])
      .filter(Boolean)
      .map(String)
  );
}

export function validateProvenance(items, evidenceIds, sectionName) {
  return items.filter((item) => {
    if (!Array.isArray(item.sourceQuestionIds)) return false;

    const validIds = item.sourceQuestionIds.filter((id) =>
      evidenceIds.has(String(id))
    );

    if (item.sourceType !== "predicted" && validIds.length === 0) {
      console.warn(
        `[Important Questions RAG] Removing ${sectionName} without valid source IDs`
      );
      return false;
    }

    item.sourceQuestionIds = validIds;
    return true;
  });
}

export function enforceSourceLabels(item, evidenceById) {
  if (!item || !Array.isArray(item.sourceQuestionIds)) {
    return item;
  }

  if (item.sourceType === "predicted") {
    item.sourceQuestionIds = [];
    return item;
  }

  const sources = item.sourceQuestionIds
    .map((id) => evidenceById.get(String(id)))
    .filter(Boolean);

  if (sources.length === 0) {
    item.sourceType = "predicted";
    item.sourceQuestionIds = [];
    return item;
  }

  item.sourceQuestionIds = [
    ...new Set(
      sources.map((source) =>
        String(source.id ?? source.questionId)
      )
    ),
  ];

  const canBeHistorical = sources.every(
    (source) =>
      source._evidenceType === "complete_question" &&
      !source._wasRepaired &&
      normalizeQuestionForDeduplication(item.question) ===
        normalizeQuestionForDeduplication(
          getCompleteQuestionText(source)
        )
  );

  item.sourceType = canBeHistorical ? "historical" : "adapted";
  return item;
}