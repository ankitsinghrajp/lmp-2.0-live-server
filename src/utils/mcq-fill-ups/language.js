/**
 * One place that decides which subjects are language subjects, so the
 * prompt and the validator can never disagree.
 *
 * Language subjects (Hindi, Sanskrit, English) use no LaTeX.
 * Every other subject is written in English and uses LaTeX for maths.
 */
const LANGUAGE_RE = /^\s*(hindi|sanskrit|english)\b/i;

export function isLanguageSubject(subject) {
  return LANGUAGE_RE.test(String(subject ?? ""));
}

export function getLanguage(subject) {
  const match = String(subject ?? "").match(LANGUAGE_RE);
  const name = match?.[1]?.toLowerCase();

  if (name === "hindi") return "Hindi";
  if (name === "sanskrit") return "Sanskrit";

  return "English";
}

/** [trueWord, falseWord] for the subject's language. */
export function getTrueFalseAnswers(language) {
  if (language === "Hindi") return ["सत्य", "असत्य"];
  if (language === "Sanskrit") return ["आम्", "न"];
  return ["True", "False"];
}