import { inngest } from "../../libs/inngest.js";
import { ChapterWiseSummaryModel } from "../../models/chapterWiseStudy/chapterWiseSummary.model.js";
import { parseSubject, detectCategory } from "../../utils/helper.js";
import { redis } from "../../libs/redis.js";

import { generateSmartChapterSummary } from "../../services/chapter_wise_study/smartSummary.service.js";
import {
  CACHE_TTL_SECONDS,
  createCacheKey,
  isValidSummaryResponse,
} from "../../utils/chapterWiseStudy/smartChapterSummary/shared.js";
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";

export const smartChapterSummaryFn = inngest.createFunction(
  {
    name: "Generate Smart Chapter Summary",
    id: "smart-chapter-summary",
    // Must stay 0: a retry would re-publish chunks that were already streamed.
    retries: 0,
    triggers: [{ event: "lmp/generate.smartChapterSummary" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, jobId } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for Smart Summary streaming.");
    }

    if (!className || !subject || !chapter) {
      throw new Error("className, subject and chapter are required.");
    }

    const { mainSubject, bookName } = parseSubject(subject);
    const category = detectCategory(mainSubject);

    const cacheKey = createCacheKey(className, mainSubject, chapter);
    const pendingKey = `${cacheKey}:pending`;
    const channel = importantQuestionsRealtime({ jobId });

    const releaseOwnedLock = async () => {
      try {
        const currentLock = await redis.get(pendingKey);

        if (currentLock === jobId) {
          await redis.del(pendingKey);
        }
      } catch (error) {
        console.error("Failed to release Smart Summary lock:", error);
      }
    };

    try {
      // 1. Notify the frontend.
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Generating smart summary",
        jobId,
        className,
        subject: mainSubject,
        chapter,
      });

      // 2. Check MongoDB.
      const dbCache = await step.run("DB Check", async () =>
        ChapterWiseSummaryModel.findOne({
          className,
          subject: mainSubject,
          chapter,
        }).lean()
      );

      if (isValidSummaryResponse(dbCache?.content)) {
        const cachedData = JSON.parse(JSON.stringify(dbCache.content));

        await step.run("Restore Redis Cache", async () => {
          await redis.set(cacheKey, JSON.stringify(cachedData), {
            ex: CACHE_TTL_SECONDS,
          });
        });

        await step.realtime.publish("complete-from-database", channel.complete, {
          success: true,
          data: cachedData,
          message: "Summary loaded from database",
          source: "database",
          jobId,
        });

        return { source: "database" };
      }

      // 3. Generate and stream chunks the moment they arrive.
      const result = await step.run("Generate Smart Summary", async () => {
        // Publishes are chained so chunks go out in order, and so we can
        // wait for all of them before the step ends.
        let publishChain = Promise.resolve();

        const generated = await generateSmartChapterSummary({
          className,
          mainSubject,
          bookName,
          category,
          chapter,
          onChunk: ({ index, text }) => {
            publishChain = publishChain
              .then(() =>
                inngest.realtime.publish(channel.chunk, {
                  index,
                  text,
                  jobId,
                })
              )
              .catch((error) => {
                console.error(
                  `Failed to publish summary chunk ${index}:`,
                  error?.message
                );
              });
          },
        });

        // Make sure every chunk is published before "complete" is sent.
        await publishChain;

        return generated;
      });

      if (!isValidSummaryResponse(result)) {
        throw new Error("Summary service returned an invalid response.");
      }

      const finalResult = { summary: result.summary };

      // 4. Save to Redis.
      await step.run("Cache Summary", async () => {
        await redis.set(cacheKey, JSON.stringify(finalResult), {
          ex: CACHE_TTL_SECONDS,
        });
      });

      // 5. Save to MongoDB (upsert, so a race can never create duplicates).
      await step.run("Save Summary To DB", async () => {
        await ChapterWiseSummaryModel.findOneAndUpdate(
          { className, subject: mainSubject, chapter },
          { $set: { content: finalResult } },
          { upsert: true, new: true }
        );
      });

      // 6. Publish the completed response (authoritative final text).
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: finalResult,
        message: "Summary generated successfully",
        source: "openai",
        jobId,
      });

      return { source: "openai", cacheKey };
    } catch (error) {
      console.error("Smart Summary generation error:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate summary",
          jobId,
        });
      } catch (publishError) {
        console.error("Failed to publish generation error:", publishError);
      }

      throw error;
    } finally {
      await releaseOwnedLock();
    }
  }
);