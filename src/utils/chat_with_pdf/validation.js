const UNAVAILABLE_ANSWER =
  "This information is not available in the provided PDF.";

const LATEX_COMMAND_PATTERN =
  /\\(?:alpha|beta|theta|phi|Phi|vec|frac|sqrt|cos|sin|tan|Delta|pi|omega|lambda|mu|sigma|sum|int|times|cdot|rightarrow|leftarrow|text|mathrm|overrightarrow|hat|bar|nabla|epsilon|epsilon_0)\b/;

const getSubjectLanguage = (subject) => {
  const normalized = subject?.toLowerCase().trim();

  if (normalized === "hindi") return "hindi";
  if (normalized === "sanskrit") return "sanskrit";

  return "english";
};

const validateResponseStructure = ({ answer, isAvailableInPdf }) => {
  const errors = [];

  if (typeof answer !== "string" || !answer.trim()) {
    errors.push("Answer must be a non-empty string.");
  }

  if (typeof isAvailableInPdf !== "boolean") {
    errors.push("isAvailableInPdf must be a boolean.");
  }

  return errors;
};

const validateAvailability = ({ answer, isAvailableInPdf }) => {
  const errors = [];

  if (isAvailableInPdf === false) {
    if (answer?.trim() !== UNAVAILABLE_ANSWER) {
      errors.push(
        `When information is unavailable, answer exactly: "${UNAVAILABLE_ANSWER}"`
      );
    }
  }

  if (
    isAvailableInPdf === true &&
    answer?.trim() === UNAVAILABLE_ANSWER
  ) {
    errors.push(
      "Answer cannot be marked available while returning the unavailable message."
    );
  }

  return errors;
};

const validateLanguage = ({ answer, subject }) => {
  const errors = [];
  const language = getSubjectLanguage(subject);

  // Remove mathematical expressions before checking language.
  const text = answer.replace(
    /\$\$[\s\S]*?\$\$|\$(?!\$)[^$\n]+\$(?!\$)/g,
    ""
  );

  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  const hasLatin = /[a-zA-Z]/.test(text);

  if (language === "english" && hasDevanagari) {
    errors.push("English answers must not contain Hindi or Sanskrit text.");
  }

  if (language === "hindi" || language === "sanskrit") {
    if (!hasDevanagari) {
      errors.push(`Answer must be written in ${language}.`);
    }

    if (hasLatin) {
      errors.push(
        `${language} answers must not contain unnecessary English text.`
      );
    }
  }

  if (language === "sanskrit") {
    const lines = answer
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length > 3) {
      errors.push("Sanskrit answers must contain a maximum of 3 lines.");
    }
  }

  return errors;
};

const validateLatex = (answer) => {
  const errors = [];

  const outsideMath = answer.replace(
    /\$\$[\s\S]*?\$\$|\$(?!\$)[^$\n]+\$(?!\$)/g,
    ""
  );

  const dollarCount = (answer.match(/\$/g) || []).length;

  if (dollarCount % 2 !== 0) {
    errors.push("Unbalanced LaTeX math delimiters.");
  }

  if (LATEX_COMMAND_PATTERN.test(outsideMath)) {
    errors.push("LaTeX commands must be inside math delimiters.");
  }

  return errors;
};

const validateControlCharacters = (answer) => {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(answer)) {
    return ["Answer contains invalid control characters."];
  }

  return [];
};

export const validateChatWithPdf = ({
  result,
  subject,
}) => {
  if (!result || typeof result !== "object") {
    return {
      valid: false,
      errors: ["Invalid structured response."],
    };
  }

  const { answer, isAvailableInPdf } = result;

  const errors = [
    ...validateResponseStructure({
      answer,
      isAvailableInPdf,
    }),
  ];

  if (typeof answer !== "string" || !answer.trim()) {
    return {
      valid: false,
      errors,
    };
  }

  errors.push(
    ...validateAvailability({
      answer,
      isAvailableInPdf,
    })
  );

  if (isAvailableInPdf === true) {
    errors.push(
      ...validateLanguage({
        answer,
        subject,
      })
    );

    errors.push(...validateLatex(answer));
    errors.push(...validateControlCharacters(answer));
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};