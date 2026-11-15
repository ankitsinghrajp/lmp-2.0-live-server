import { runStreamStep } from "../utils/visual/openAiStreamUp.js";
import {
  buildVisualSystemPrompt,
  buildVisualUserPrompt,
} from "../utils/visual/prompt.js";
import { validateVisual } from "../utils/visual/validation.js";

const MODEL = process.env.OPENAI_VISUAL_MODEL || "gpt-4o-mini";
const MAX_TOKENS = 600; // a small text diagram never needs more

// Rewrite rounds after the first attempt (only used when validation fails).
const MAX_REPAIR_ROUNDS = 2;

/**
 * @param {object}   args
 * @param {object}   args.eventData  { type, description, subject, className }
 * @param {object}   args.step       Inngest step tools
 * @param {Function} args.onChunk    async ({ index, text }) => void
 * @param {Function} args.onReset    async () => void  (called before EVERY attempt)
 * @returns {{ type, format, diagram, markdown, generatedAt }}
 */
export async function generateVisualOutput({ eventData, step, onChunk, onReset }) {
  const { type, description = "", subject = "", className = "" } = eventData;

  if (!["diagram", "graph"].includes(type)) {
    throw new Error("type must be diagram or graph");
  }
  if (!description.trim()) {
    throw new Error("A visual description is required.");
  }

  console.log("[Visual] Starting generation", { type, subject, className });

  const systemPrompt = buildVisualSystemPrompt();

  let previousResponse = "";
  let validationErrors = [];

  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
    const userPrompt = buildVisualUserPrompt({
      type,
      description,
      subject,
      className,
      previousResponse,
      validationErrors,
    });

    const { text } = await runStreamStep({
      model: MODEL,
      maxTokens: MAX_TOKENS,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      step,
      stepName: round === 0 ? "Generate Visual" : `Repair Visual ${round}`,
      onChunk,
      // Always passed: it also clears the client if Inngest retries a step.
      onReset,
      logTag: "Visual",
    });

    const validation = validateVisual({ raw: text, type });

    if (validation.valid) {
      console.log("[Visual] Validation successful");
      return {
        type,
        format: "text/plain",
        diagram: validation.code,
        markdown: validation.markdown,
        generatedAt: new Date().toISOString(),
      };
    }

    console.warn(`[Visual] Validation failed (round ${round}):`, validation.issues);

    previousResponse = validation.code || text;
    validationErrors = validation.issues;
  }

  throw new Error(
    `Generated visual failed validation: ${validationErrors.join(" | ")}`
  );
}