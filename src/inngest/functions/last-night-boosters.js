import { inngest } from "../../libs/inngest.js";
import { parseSubject } from "../../utils/helper.js";
import { redis } from "../../libs/redis.js";
// Boosters reuse the same realtime channel (keyed by jobId). The "question"
// topic carries { section: "markdown", index, markdown, jobId } for this feature.
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";
import { generateMemoryBoosterOutput } from "../../services/last_night_before_exam/memory_boosters.service.js";
import {
  CACHE_TTL_SECONDS,
  createBoostersCacheKey,
  isValidBoostersResponse,
  normalizeBoostersContent,
  resolveCacheSubject,
} from "../../utils/last_night_before_exam/memory_boosters/cache.js";

export const lastNightMemoryBoosterFn = inngest.createFunction(
  {
    name: "Generate LMP Memory Boosters",
    id: "last-night-memory-boosters",
    retries: 0,
    triggers: [{ event: "lmp/generate.memoryBooster" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, bookName, jobId } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for Memory Booster streaming.");
    }

    if (!className || !subject || !chapter) {
      throw new Error("className, subject and chapter are required.");
    }

    // `subject` is the raw string (e.g. "Hindi: Kshitij Part 2").
    const { mainSubject } = parseSubject(subject);

    const cacheKey = createBoostersCacheKey(
      className,
      resolveCacheSubject(subject, mainSubject),
      chapter
    );
    const pendingKey = `${cacheKey}:pending`;
    const channel = importantQuestionsRealtime({ jobId });

    // Released through a step (not a `finally`) so it only runs once, when
    // the job is really over, and never on an Inngest re-invocation.
    // The controller's lock TTL is the safety net if the function dies.
    const releaseLock = () =>
      step.run("release-lock", async () => {
        try {
          const currentLock = await redis.get(pendingKey);
          if (currentLock === jobId) await redis.del(pendingKey);
        } catch (error) {
          console.error("Failed to release Memory Booster lock:", error.message);
        }
      });

    try {
      // 1. Notify the frontend.
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Generating memory boosters",
        jobId,
        className,
        subject: mainSubject,
        chapter,
      });

      // 2. Generate. Each VALID booster is published the moment it is ready.
      //    This happens inside one memoized step, so later re-invocations of
      //    the function never re-send the boosters.
      const generated = await step.run("generate-boosters-v3", async () =>
        generateMemoryBoosterOutput({
          className,
          subject: mainSubject,
          fullSubject: subject,
          chapter,
          bookName,
          onChunk: ({ index, markdown }) =>
            inngest.realtime.publish(channel.question, {
              section: "markdown",
              index,
              markdown,
              jobId,
            }),
        })
      );

      if (!isValidBoostersResponse(generated)) {
        throw new Error("Memory booster service returned an invalid response.");
      }

      const finalResult = normalizeBoostersContent(generated);

      // 3. Persist. A cache failure must never fail a successful generation.
      await step.run("persist-boosters-v3", async () => {
        try {
          await redis.set(cacheKey, JSON.stringify(finalResult), {
            ex: CACHE_TTL_SECONDS,
          });
        } catch (error) {
          console.error("Memory Booster Redis save failed:", error.message);
        }
      });

      // 4. Publish the completed response (client replaces streamed blocks with it).
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: finalResult,
        message: "Memory boosters generated successfully",
        source: "generated-v3",
        jobId,
      });

      await releaseLock();

      return {
        source: "generated-v3",
        boosterCount: generated.boosterCount,
        cacheKey,
      };
    } catch (error) {
      console.error("Memory Booster generation error:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate memory boosters",
          jobId,
        });
      } catch (publishError) {
        console.error("Failed to publish generation error:", publishError);
      }

      try {
        await releaseLock();
      } catch (lockError) {
        console.error("Failed to release lock after error:", lockError);
      }

      throw error;
    }
  }
);