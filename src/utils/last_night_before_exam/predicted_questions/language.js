export const LANGUAGE_CONFIG = {
  hindi: {
    key: "hindi",
    label: "Hindi",
    answerLanguage: "Hindi (Devanagari script)",
    scriptRule:
      "Write every question in Hindi using Devanagari script only. Do not write any English or Roman-script (transliterated) words.",
  },
  sanskrit: {
    key: "sanskrit",
    label: "Sanskrit",
    answerLanguage: "Sanskrit (Devanagari script)",
    scriptRule:
      "Write every question in Sanskrit using Devanagari script only. Do not write any English, Hindi or Roman-script (transliterated) words.",
  },
  english: {
    key: "english",
    label: "English",
    answerLanguage: "English",
    scriptRule:
      "Write every question in English only. Do not write any Hindi or other-language text, except a word that is part of the lesson itself.",
  },
};

/**
 * Accepts "Hindi", "Hindi: Kshitij Part 2" or a separate bookName.
 * Looks only at the language part of the subject (text before ":").
 * Returns null for non-language subjects.
 */
export const getLanguageInfo = (subject = "", bookName = "") => {
  const raw = String(subject ?? "").normalize("NFKC").trim();
  const colon = raw.indexOf(":");
  const prefix = (colon >= 0 ? raw.slice(0, colon) : raw).toLowerCase();

  let key = null;
  if (/\bsanskrit\b|संस्कृत/.test(prefix)) key = "sanskrit";
  else if (/\bhindi\b|हिन्दी|हिंदी/.test(prefix)) key = "hindi";
  else if (/\benglish\b/.test(prefix)) key = "english";

  if (!key) return null;

  const bookFromSubject = colon >= 0 ? raw.slice(colon + 1).trim() : "";
  const book =
    String(bookName ?? "").trim() ||
    bookFromSubject ||
    "the prescribed NCERT/CBSE textbook";

  return { ...LANGUAGE_CONFIG[key], book };
};