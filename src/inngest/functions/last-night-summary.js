import "dotenv/config.js"
import { inngest } from "../../libs/inngest.js";
import { redis } from "../../libs/redis.js";

import {
  LastMinuteSummaryModel,
} from "../../models/LastMinuteBeforeExam/summary.model.js";

import { parseSubject } from "../../utils/helper.js";

import {
  generateSummaryOutput,
} from "../../services/last_night_before_exam/summary.service.js";


export const lastNightSummaryFn = inngest.createFunction(
  {
    id: "last-night-summary",
    name: "Generate LMP Summary",
    retries: 0,
    triggers: [
      {
        event: "lmp/generate.summary",
      },
    ],
  },

  async ({ event, step }) => {
    const {
      className,
      subject,
      chapter,
    } = event.data;

    if (!className || !subject || !chapter) {
      throw new Error(
        "className, subject and chapter are required."
      );
    }

    const { mainSubject } = parseSubject(subject);

    const cacheKey =
      `lmp:summary:${className}:${mainSubject}:${chapter}`;

    const pendingKey =
      `lmp:summary:pending:${className}:${mainSubject}:${chapter}`;

    try {
      console.log("[Summary Inngest] Starting generation", {
        className,
        subject: mainSubject,
        chapter,
      });

      // 1. Check MongoDB for an existing summary.
      const dbCache = await step.run(
        "Check MongoDB",
        async () => {
          return await LastMinuteSummaryModel.findOne({
            className,
            subject: mainSubject,
            chapter,
          }).lean();
        }
      );

      // 2. Restore Redis if summary exists in MongoDB.
      if (dbCache?.content) {
        const safeDBContent = dbCache.content;

        await step.run(
          "Restore Redis Cache",
          async () => {
            await redis.set(
              cacheKey,
              safeDBContent,
              {
                ex: 60 * 60 * 24 * 2,
              }
            );
          }
        );

        await step.run(
          "Clear Pending Lock",
          async () => {
            await redis.del(pendingKey);
          }
        );

        console.log(
          "[Summary Inngest] Summary served from MongoDB"
        );

        return {
          success: true,
          source: "database",
          summary: safeDBContent,
        };
      }

      // 3. Generate structured summary.
      const result = await generateSummaryOutput({
        eventData: {
          className,
          subject,
          chapter,
        },
        step,
      });

      // 4. Validate service response.
      if (
        !result ||
        typeof result.summary !== "string" ||
        !result.summary.trim()
      ) {
        throw new Error(
          "Summary service returned an invalid result."
        );
      }

      // 5. Save summary in MongoDB.
      await step.run(
        "Save Summary to MongoDB",
        async () => {
          await LastMinuteSummaryModel.findOneAndUpdate(
            {
              className,
              subject: mainSubject,
              chapter,
            },
            {
              $set: {
                content: result,
              },
            },
            {
              upsert: true,
              new: true,
            }
          );
        }
      );

      // 6. Save summary in Redis.
      await step.run(
        "Save Summary to Redis",
        async () => {
          await redis.set(
            cacheKey,
            result,
            {
              ex: 60 * 60 * 24 * 2,
            }
          );
        }
      );

      // 7. Clear pending lock.
      await step.run(
        "Clear Pending Lock",
        async () => {
          await redis.del(pendingKey);
        }
      );

      console.log(
        "[Summary Inngest] Generation completed",
        {
          className,
          subject: mainSubject,
          chapter,
        }
      );

      return {
        success: true,
        source: "generated",
        summary: result,
      };

    } catch (error) {
      console.error(
        "[Summary Inngest] Generation failed:",
        error
      );

      // 8. Clear pending lock on failure.
      try {
        await redis.del(pendingKey);
      } catch (redisError) {
        console.error(
          "[Summary Inngest] Failed to clear pending lock:",
          redisError
        );
      }

      throw error;
    }
  }
);
