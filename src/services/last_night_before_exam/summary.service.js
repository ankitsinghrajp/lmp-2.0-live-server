
import { openai } from "../../utils/OpenAI.js";

import { parseSubject, detectCategory } from "../../utils/helper.js";

import {
  summaryResponseSchema,
} from "../../utils/last_night_before_exam/summary/schema.js";

import {
  buildSummarySystemPrompt,
  buildSummaryUserPrompt,
} from "../../utils/last_night_before_exam/summary/prompt.js";

import {
  validateSummary,
} from "../../utils/last_night_before_exam/summary/validation.js";


const MODEL = "gpt-4o-mini";

const MAX_REPAIR_ATTEMPTS = 2;
const MAX_COMPLETION_TOKENS = 4096;


/**
 * Generate structured summary using OpenAI.
 */
async function generateStructuredSummary({
  systemPrompt,
  userPrompt,
  step,
  stepName,
}) {
  const call = () =>
    openai.chat.completions.create({
      model: MODEL,

      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],

      response_format: {
        type: "json_schema",
        json_schema: {
          name: "cbse_chapter_summary",
          strict: true,
          schema: summaryResponseSchema,
        },
      },

      max_completion_tokens: MAX_COMPLETION_TOKENS,
    });

  const response = step
    ? await step.run(stepName, call)
    : await call();

  const choice = response.choices?.[0];

  if (!choice) {
    throw new Error(
      "OpenAI returned no completion."
    );
  }

  if (choice.message?.refusal) {
    throw new Error(
      `OpenAI refused summary generation: ${choice.message.refusal}`
    );
  }

  if (choice.finish_reason === "length") {
    throw new Error(
      "Summary generation reached the token limit."
    );
  }

  const content = choice.message?.content;

  if (!content) {
    throw new Error(
      "OpenAI returned an empty structured summary."
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to parse structured summary: ${error.message}`
    );
  }

  return parsed;
}


export async function generateSummaryOutput({
  eventData,
  step,
}) {
  const {
    className,
    subject,
    chapter,
  } = eventData;

  if (!className || !subject || !chapter) {
    throw new Error(
      "className, subject and chapter are required."
    );
  }

  const {
    mainSubject,
    bookName,
  } = parseSubject(subject);

  const category = detectCategory(mainSubject);

  console.log("[Summary] Starting generation", {
    className,
    subject: mainSubject,
    chapter,
    category,
  });

  // 1. Build system prompt.
  const systemPrompt = buildSummarySystemPrompt({
    subject: mainSubject,
    category,
  });

  // 2. Build user prompt.
  const userPrompt = buildSummaryUserPrompt({
    className,
    subject,
    mainSubject,
    bookName,
    chapter,
    category,
  });

  if (process.env.DEBUG_SUMMARY) {
    console.log(
      "[Summary] SYSTEM PROMPT:\n",
      systemPrompt
    );

    console.log(
      "[Summary] USER PROMPT:\n",
      userPrompt
    );
  }

  // 3. Generate initial summary.
  let summary = await generateStructuredSummary({
    systemPrompt,
    userPrompt,
    step,
    stepName: "Generate Structured Summary",
  });

  // 4. Validate and regenerate if necessary.
  for (
    let attempt = 0;
    attempt <= MAX_REPAIR_ATTEMPTS;
    attempt++
  ) {
    const validation = validateSummary({
      summary,
      subject: mainSubject,
      chapter,
    });

    if (validation.valid) {
      console.log(
        "[Summary] Validation successful",
        {
          className,
          subject: mainSubject,
          chapter,
        }
      );

      return {
        summary: summary.summary,
        chapter,
        class: String(className),
        subject: mainSubject,
      };
    }

    if (attempt === MAX_REPAIR_ATTEMPTS) {
      console.error(
        "[Summary] Validation failed after retries:",
        validation.issues
      );

      throw new Error(
        "Summary validation failed: " +
        validation.issues.join("; ")
      );
    }

    console.warn(
      `[Summary] Regenerating summary. Attempt ${attempt + 1}`,
      validation.issues
    );

    // 5. Regenerate with validation feedback.
    const retryPrompt = `
${userPrompt}

YOUR PREVIOUS SUMMARY FAILED AUTOMATIC VALIDATION.

Problems found:
${validation.issues
  .map((issue, index) => `${index + 1}. ${issue}`)
  .join("\n")}

Generate the COMPLETE summary again.

STRICT REQUIREMENTS:
- Follow the original system prompt.
- Follow the exact required summary structure.
- Use the correct language for the subject.
- Preserve the original class, subject and chapter.
- Follow all formatting restrictions.
- Fix every validation problem.
- Return only the structured JSON response.

Do not explain the corrections.
`;

    summary = await generateStructuredSummary({
      systemPrompt,
      userPrompt: retryPrompt,
      step,
      stepName: `Regenerate Summary ${attempt + 1}`,
    });
  }

  throw new Error(
    "Unable to generate a valid summary."
  );
}
