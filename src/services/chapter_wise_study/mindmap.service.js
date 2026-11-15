import { openai } from "../../utils/OpenAI.js";
import { getLanguageInfo } from "../../utils/last_night_before_exam/predicted_questions/language.js";
import {
  buildMindMapSystemPrompt,
  buildMindMapUserPrompt,
} from "../../utils/chapterWiseStudy/mindmap/prompt.js";
import { mindMapResponseSchema } from "../../utils/chapterWiseStudy/mindmap/schema.js";
import { normalizeMindMap } from "../../utils/chapterWiseStudy/mindmap/normalize.js";

const MODEL = "gpt-4o-mini";
const LOG = "[Mind Map]";

const TEMPERATURE = 0.3;
const MAX_COMPLETION_TOKENS = 4000;
const MAX_ATTEMPTS = 2;

/**
 * @param subject      main subject, e.g. "Hindi"
 * @param fullSubject  raw subject as the user sent it, e.g. "Hindi: Kshitij Part 2"
 * @returns { version, title, nodes, edges }
 */
export const generateMindMapOutput = async ({
  className,
  subject,
  fullSubject,
  chapter,
  bookName,
}) => {
  if (!className || !subject || !chapter) {
    throw new Error("className, subject and chapter are required.");
  }

  const displaySubject = fullSubject || subject;
  const info = getLanguageInfo(displaySubject, bookName);

  // Make sure a language prompt always has a book name.
  const languageInfo = info
    ? {
        ...info,
        book:
          info.book ||
          (displaySubject.includes(":")
            ? displaySubject.slice(displaySubject.indexOf(":") + 1).trim()
            : "") ||
          "the prescribed NCERT/CBSE textbook",
      }
    : null;

  const promptArgs = {
    className,
    subject: displaySubject,
    chapter,
    bookName,
    languageInfo,
  };

  const systemPrompt = buildMindMapSystemPrompt(promptArgs);
  const userPrompt = buildMindMapUserPrompt(promptArgs);

  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: languageInfo ? "language_mind_map" : "chapter_mind_map",
            strict: true,
            schema: mindMapResponseSchema,
          },
        },
      });

      const choice = response.choices?.[0];

      if (choice?.message?.refusal) {
        lastError = `OpenAI refused the request: ${choice.message.refusal}`;
        continue;
      }

      if (choice?.finish_reason === "length") {
        throw new Error("The response was cut off before the mind map finished");
      }

      const content = choice?.message?.content;
      if (!content) throw new Error("OpenAI returned an empty response");

      const mindMap = normalizeMindMap(JSON.parse(content));

      console.log(
        `${LOG} Generated ${mindMap.nodes.length} nodes (attempt ${attempt}/${MAX_ATTEMPTS})`
      );

      return mindMap;
    } catch (error) {
      lastError = error.message;
      console.error(
        `${LOG} Attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
        error.message
      );
    }
  }

  throw new Error(
    lastError
      ? `Could not generate the mind map: ${lastError}`
      : "Could not generate the mind map. Please retry."
  );
};