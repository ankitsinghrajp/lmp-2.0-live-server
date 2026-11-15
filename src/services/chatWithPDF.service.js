import { openai } from "../utils/OpenAI.js";

import {
  chatWithPdfResponseSchema,
} from "../utils/chat_with_pdf/schema.js";

import {
  buildChatWithPdfSystemPrompt,
  buildChatWithPdfUserPrompt,
} from "../utils/chat_with_pdf/prompt.js";

import {
  validateChatWithPdf,
} from "../utils/chat_with_pdf/validation.js";

const MODEL = "gpt-4o-mini";
const MAX_REPAIR_ATTEMPTS = 2;

const generateStructuredAnswer = async ({
  systemPrompt,
  userPrompt,
}) => {
  const response = await openai.chat.completions.create({
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
        name: "chat_with_pdf",
        strict: true,
        schema: chatWithPdfResponseSchema,
      },
    },
    max_completion_tokens: 6000,
  });

  const choice = response.choices?.[0];
  const message = choice?.message;

  if (message?.refusal) {
    throw new Error(`OpenAI refused the request: ${message.refusal}`);
  }

  if (choice?.finish_reason === "length") {
    throw new Error("PDF answer generation was truncated.");
  }

  if (!message?.content) {
    throw new Error("OpenAI returned an empty response.");
  }

  try {
    return JSON.parse(message.content);
  } catch {
    throw new Error("OpenAI returned invalid structured JSON.");
  }
};

export const generateChatWithPdfAnswer = async ({
  question,
  extractedText,
  subject = "English",
}) => {
  if (!question?.trim()) {
    throw new Error("Question is required.");
  }

  if (!extractedText?.trim()) {
    throw new Error("PDF content is empty.");
  }

  const systemPrompt = buildChatWithPdfSystemPrompt({
    subject,
  });

  let validationErrors = [];

  for (
    let attempt = 0;
    attempt <= MAX_REPAIR_ATTEMPTS;
    attempt++
  ) {
    const userPrompt = buildChatWithPdfUserPrompt({
      question,
      extractedText,
      validationErrors,
    });

    const result = await generateStructuredAnswer({
      systemPrompt,
      userPrompt,
    });

    const validation = validateChatWithPdf({
      result,
      subject,
    });

    if (validation.valid) {
      return {
        answer: result.answer
          .replace(/\r/g, "")
          .replace(/[\u200B-\u200F\uFEFF]/g, "")
          .replace(/\n{3,}/g, "\n")
          .trim(),

        isAvailableInPdf: result.isAvailableInPdf,
      };
    }

    validationErrors = validation.errors;
  }

  throw new Error(
    `PDF answer failed validation: ${validationErrors.join(" | ")}`
  );
};