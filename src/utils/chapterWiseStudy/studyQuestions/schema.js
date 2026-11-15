/**
 * Chapter Wise Important Questions schema.
 *
 * Same strict structured-output shape as Predicted Questions
 * (questionText, options, formulas, tables, diagrams, graphs, subQuestions,
 * questionType, marks, importance). Re-exported so both features stay in sync.
 * The question count is enforced in code (see config.js), not in the schema.
 */
export {
  QUESTION_TYPES,
  LANGUAGE_QUESTION_TYPES,
  OBJECTIVE_TYPES,
  IMPORTANCE_LEVELS,
  getPredictedQuestionsSchema as getImportantQuestionsSchema,
} from "../../last_night_before_exam/predicted_questions/schema.js";