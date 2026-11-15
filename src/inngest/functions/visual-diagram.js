import { inngest } from "../../libs/inngest.js";
import { redis } from "../../libs/redis.js";
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";
import { generateVisualOutput } from "../../services/visual.service.js";

const RESULT_TTL_SECONDS = 60 * 60 * 24 * 30;

export const generateQuestionVisual = inngest.createFunction(
  {
    id: "generate-question-visual",
    retries: 1,
    triggers: [{ event: "lmp/generate.questionVisual" }],
  },
  async ({ event, step }) => {
    const { jobId, type, description, subject, className, cacheKey, pendingKey } =
      event.data;

    const channel = importantQuestionsRealtime({ jobId });

    // Same publish style as the PYQ function: the topic object is passed as an
    // argument. Only call this inside a step.run (or inside runStreamStep,
    // which runs inside a step).
    const send = (topic, data) =>
      inngest.realtime.publish(channel[topic], data);

    try {
      // Publishes live inside steps so a replay does not repeat them.
      await step.run("Publish Start", () =>
        send("status", { event: "start", message: "Drawing your diagram" })
      );

      const result = await generateVisualOutput({
        eventData: { type, description, subject, className },
        step,
        onChunk: (chunk) => send("question", chunk), // client sees these as "chunk"
        onReset: () => send("status", { event: "reset" }),
      });

      await step.run("Cache Visual", () =>
        redis.set(cacheKey, JSON.stringify(result), { ex: RESULT_TTL_SECONDS })
      );

      await step.run("Publish Complete", () =>
        send("complete", { success: true, data: result })
      );

      return { success: true };
    } catch (error) {
      console.error("[Visual Job] Failed:", error?.message);

      await step
        .run("Publish Error", () =>
          send("error", {
            success: false,
            message: "Could not draw this diagram. Please try again.",
          })
        )
        .catch(() => {});

      return { success: false };
    } finally {
      // The function owns the lock once the controller has queued the job.
      await step
        .run("Release Lock", async () => {
          const current = await redis.get(pendingKey);
          if (current === jobId) await redis.del(pendingKey);
        })
        .catch((error) =>
          console.error("[Visual Job] Lock release failed:", error?.message)
        );
    }
  }
);