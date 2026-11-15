import { inngest } from "../../libs/inngest.js";
import { redis } from "../../libs/redis.js";
import { parseSubject } from "../../utils/helper.js";
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";

import { generateTopperAnswerOutput } from "../../services/topperStyleAnswer.service.js";

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days (same as before)
const CACHE_PREFIX = "lmp:topper:v2";

export const topperStyleAnswerFn = inngest.createFunction(
  {
    id: "topper-style-answer",
    name: "Generate Topper Style Answer",
    // Must stay 0: a retry would re-publish chunks that were already streamed.
    retries: 0,
    triggers: [{ event: "lmp/generate.topperAnswer" }],
  },
  async ({ event, step }) => {
    const {
      jobId,
      contentHash,
      question = "",
      selectedClass = "",
      selectedSubject = "",
      selectedChapter = "",
    } = event.data;

    if (!jobId || !contentHash) {
      throw new Error("Missing jobId or contentHash in Topper Answer event");
    }

    if (!question.trim()) {
      throw new Error("A question is required.");
    }

    const { mainSubject, bookName } = parseSubject(selectedSubject);

    const cacheKey = `${CACHE_PREFIX}:${contentHash}`;
    const pendingKey = `${CACHE_PREFIX}:pending:${contentHash}`;
    const channel = importantQuestionsRealtime({ jobId });

    // Only delete the lock if this job still owns it.
    const releaseOwnedLock = async () => {
      try {
        const currentLock = await redis.get(pendingKey);
        if (currentLock === jobId) await redis.del(pendingKey);
      } catch (redisError) {
        console.error("[Topper Inngest] Lock release failed:", redisError);
      }
    };

    try {
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Writing your answer",
        jobId,
      });

      // 1. Generate. Chunks are streamed live; the result is validated and
      //    rewritten (with a reset event) if it breaks a rule.
      const result = await generateTopperAnswerOutput({
        eventData: {
          question,
          className: selectedClass,
          subject: mainSubject,
          bookName,
          chapter: selectedChapter,
        },
        step,

        onChunk: async ({ index, text }) => {
          await inngest.realtime.publish(channel.question, {
            section: "answer",
            index,
            item: { text },
            jobId,
          });
        },

        onReset: async () => {
          await inngest.realtime.publish(channel.status, {
            event: "reset",
            message: "Improving the answer",
            jobId,
          });
        },
      });

      if (!result || typeof result.answer !== "string" || !result.answer.trim()) {
        throw new Error("Topper Answer service returned an invalid result");
      }

      // 2. Cache the validated result (also overwrites an older answer when
      //    the user pressed "regenerate").
      await step.run("Save Redis", async () => {
        await redis.set(cacheKey, { answer: result.answer }, { ex: CACHE_TTL_SECONDS });
      });

      // 3. Final, validated text replaces whatever was streamed.
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: { answer: result.answer },
        message: "Answer ready",
        source: "generated",
        jobId,
      });

      return { success: true, jobId };
    } catch (error) {
      console.error(`[Topper Inngest] Job failed: ${jobId}`, error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to answer the question",
          jobId,
        });
      } catch (publishError) {
        console.error("[Topper Inngest] Failed to publish error:", publishError);
      }

      throw error;
    } finally {
      await releaseOwnedLock();
    }
  }
);