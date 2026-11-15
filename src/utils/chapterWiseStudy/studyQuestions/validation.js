// Same sanitize -> fix -> KaTeX -> LLM-repair pipeline as Predicted Questions.
// Re-exported so a LaTeX fix in one place applies to both features.
export {
  sanitizePredictedQuestion,
  validateAndRepairQuestion,
  looksLikeMcqStem,
  hasInlineOptions,
  isObjectiveQuestion,
  createDuplicateTracker,
} from "../../last_night_before_exam/predicted_questions/validation.js";