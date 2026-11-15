import { inngest } from "../../libs/inngest.js";
import { ImpTopicsModel } from "../../models/LastMinuteBeforeExam/impTopics.model.js";
import { parseSubject } from "../../utils/helper.js";
import { redis } from "../../libs/redis.js";
// Topics reuse the same realtime channel (keyed by jobId). The "question"
// topic carries { section: "markdown", index, markdown, jobId } for this feature.
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";
import { generateImportantTopicsOutput } from "../../services/last_night_before_exam/important_topics.service.js";
import {
  CACHE_TTL_SECONDS,
  createTopicsCacheKey,
  isValidTopicsResponse,
  normalizeTopicsContent,
} from "../../utils/last_night_before_exam/important_topics/cache.js";

export const lastNightImportantTopicsFn = inngest.createFunction(
  {
    name: "Generate LMP Important Topics",
    id: "last-night-important-topics",
    retries: 0,
    triggers: [{ event: "lmp/generate.importantTopics" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, jobId } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for Important Topics streaming.");
    }

    if (!className || !subject || !chapter) {
      throw new Error("className, subject and chapter are required.");
    }

    const { mainSubject } = parseSubject(subject);

    const cacheKey = createTopicsCacheKey(className, mainSubject, chapter);
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
          console.error("Failed to release Important Topics lock:", error.message);
        }
      });

    try {
      // 1. Notify the frontend.
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Generating important topics",
        jobId,
        className,
        subject: mainSubject,
        chapter,
      });

      // 2. Check MongoDB (covers a race with another request).
      const dbCache = await step.run("db-check-v2", async () =>
        ImpTopicsModel.findOne({
          className,
          subject: mainSubject,
          chapter,
        }).lean()
      );

      if (isValidTopicsResponse(dbCache?.content)) {
        const cachedData = normalizeTopicsContent(dbCache.content);

        await step.run("restore-redis-v2", async () => {
          await redis.set(cacheKey, JSON.stringify(cachedData), {
            ex: CACHE_TTL_SECONDS,
          });
        });

        await step.realtime.publish("complete-from-database", channel.complete, {
          success: true,
          data: cachedData,
          message: "Topics loaded from database",
          source: "database",
          jobId,
        });

        await releaseLock();
        return { source: "database" };
      }

      // 3. Generate. Each VALID topic is published the moment it is ready.
      //    This happens inside one memoized step, so later re-invocations of
      //    the function never re-send the topics.
      const generated = await step.run("generate-topics-v2", async () =>
        generateImportantTopicsOutput({
          className,
          subject: mainSubject,
          fullSubject: subject,
          chapter,
          onChunk: ({ index, markdown }) =>
            inngest.realtime.publish(channel.question, {
              section: "markdown",
              index,
              markdown,
              jobId,
            }),
        })
      );

      if (!isValidTopicsResponse(generated)) {
        throw new Error("Topics service returned an invalid response.");
      }

      const finalResult = normalizeTopicsContent(generated);

      // 4. Persist. A cache failure must never fail a successful generation.
      await step.run("persist-topics-v2", async () => {
        const results = await Promise.allSettled([
          redis.set(cacheKey, JSON.stringify(finalResult), {
            ex: CACHE_TTL_SECONDS,
          }),
          ImpTopicsModel.findOneAndUpdate(
            { className, subject: mainSubject, chapter },
            { $set: { content: finalResult } },
            { upsert: true, new: true }
          ),
        ]);

        results.forEach((result, i) => {
          if (result.status === "rejected") {
            console.error(
              `Important Topics ${i === 0 ? "Redis" : "MongoDB"} save failed:`,
              result.reason?.message
            );
          }
        });
      });

      // 5. Publish the completed response.
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: finalResult,
        message: "Topics generated successfully",
        source: "generated-v2",
        jobId,
      });

      await releaseLock();

      return {
        source: "generated-v2",
        topicCount: generated.topicCount,
        cacheKey,
      };
    } catch (error) {
      console.error("Important Topics generation error:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate topics",
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