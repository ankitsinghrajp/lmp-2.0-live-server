
function getLanguage(subject) {
  const normalized = String(subject || "")
    .trim()
    .toLowerCase();

  if (normalized === "hindi") return "Hindi";
  if (normalized === "sanskrit") return "Hindi";

  return "English";
}


/**
 * Count sentences in a paragraph.
 */
function countSentences(text) {
  const sentences = text
    .split(/[.!?।॥]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return sentences.length;
}


/**
 * Validate summary content.
 */
function validateSummaryContent({
  summary,
  language,
  isLanguageSubject,
  isDualChapter,
}) {
  const issues = [];

  if (
    typeof summary !== "string" ||
    !summary.trim()
  ) {
    return {
      valid: false,
      issues: ["Summary must be a non-empty string."],
    };
  }

  const text = summary.trim();

  // 1. Markdown and formatting validation.
  if (/(\*\*|__|~~|`)/.test(text)) {
    issues.push(
      "Summary must not contain Markdown formatting."
    );
  }

  if (/^\s*[-*•]\s+/m.test(text)) {
    issues.push(
      "Summary must not contain bullet points."
    );
  }

  if (/^\s*\d+[.)]\s+/m.test(text)) {
    issues.push(
      "Summary must not contain numbered lists."
    );
  }

  if (/^#{1,6}\s+/m.test(text)) {
    issues.push(
      "Summary must not contain headings."
    );
  }

  // 2. Unexpected characters.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    issues.push(
      "Summary contains unexpected control characters."
    );
  }

  // 3. Language validation.
  if (language === "English") {
    if (/[\u0900-\u097F]/.test(text)) {
      issues.push(
        "English summary must not contain Devanagari characters."
      );
    }
  }

  if (language === "Hindi") {
    if (/[a-zA-Z]/.test(text)) {
      issues.push(
        "Hindi summary must not contain English characters."
      );
    }

    if (!/[\u0900-\u097F]/.test(text)) {
      issues.push(
        "Hindi summary must use Devanagari script."
      );
    }
  }

  // 4. Sentence and paragraph validation.
  if (isLanguageSubject) {
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    if (isDualChapter) {
      if (paragraphs.length < 4 || paragraphs.length > 6) {
        issues.push(
          "Dual chapter summary must contain 4-6 paragraphs."
        );
      }

      // Each work must have 2-3 paragraphs.
      const firstWork = paragraphs.slice(
        0,
        Math.floor(paragraphs.length / 2)
      );

      const secondWork = paragraphs.slice(
        Math.floor(paragraphs.length / 2)
      );

      if (
        firstWork.length < 2 ||
        firstWork.length > 3 ||
        secondWork.length < 2 ||
        secondWork.length > 3
      ) {
        issues.push(
          "Each work in a dual chapter summary must contain 2-3 paragraphs."
        );
      }

    } else {
      if (paragraphs.length < 2 || paragraphs.length > 3) {
        issues.push(
          "Language summary must contain 2-3 paragraphs."
        );
      }
    }

    paragraphs.forEach((paragraph, index) => {
      const sentences = countSentences(paragraph);

      if (sentences < 3 || sentences > 4) {
        issues.push(
          `Paragraph ${index + 1} must contain 3-4 sentences.`
        );
      }
    });

  } else {
    const paragraphs = text
      .split(/\n\s*\n/)
      .filter(Boolean);

    if (paragraphs.length !== 1) {
      issues.push(
        "General subject summary must contain exactly one paragraph."
      );
    }

    const sentenceCount = countSentences(text);

    if (sentenceCount < 3 || sentenceCount > 4) {
      issues.push(
        "General subject summary must contain 3-4 sentences."
      );
    }
  }

  // 5. Mathematical formatting restriction.
  if (isLanguageSubject && /\$|\\frac|\\sqrt/.test(text)) {
    issues.push(
      "Language summary must not contain mathematical expressions."
    );
  }

  if (!isLanguageSubject) {
    if (
      /\$\$?[\s\S]*?\$\$?/.test(text) ||
      /\\(frac|sqrt|sum|int|lim|times|cdot)\b/.test(text)
    ) {
      issues.push(
        "General summary must not contain mathematical formulas."
      );
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}


/**
 * Main summary validator.
 */
export function validateSummary({
  summary,
  subject,
  chapter,
}) {
  const issues = [];

  if (!summary || typeof summary !== "object") {
    return {
      valid: false,
      issues: [
        "Summary response must be a valid object.",
      ],
    };
  }

  if (
    typeof summary.summary !== "string" ||
    !summary.summary.trim()
  ) {
    return {
      valid: false,
      issues: [
        "Summary field must be a non-empty string.",
      ],
    };
  }

  const language = getLanguage(subject);

  const isLanguageSubject = [
    "hindi",
    "sanskrit",
  ].includes(
    String(subject || "").trim().toLowerCase()
  );

  const isDualChapter =
    String(chapter || "").includes("/");

  const contentValidation = validateSummaryContent({
    summary: summary.summary,
    language,
    isLanguageSubject,
    isDualChapter,
  });

  issues.push(...contentValidation.issues);

  return {
    valid: issues.length === 0,
    issues,
  };
}
