import { inngest } from "../../libs/inngest.js";
import { redis } from "../../libs/redis.js";
import { McqModel } from "../../models/ImportantMcqsTrueFalse/mcq.model.js";

import { parseSubject } from "../../utils/helper.js";

import {
  generateQuizOutput,
} from "../../services/quizFillUps.service.js";
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 2;

export const quizMcqFillupTrueFalseFn = inngest.createFunction(
  {
    id: "quiz-mcq-fillup-truefalse",
    name: "Generate Quiz (MCQ, Fillups, True/False)",
    // Must stay 0: a retry would re-publish questions that were already streamed.
    retries: 0,
    triggers: [
      {
        event: "lmp/generate.quizMcqFillupTrueFalse",
      },
    ],
  },

  async ({ event, step }) => {
    const {
      className,
      subject,
      chapter,
      index = [],
      difficulty = "Medium",
      jobId,
    } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for Quiz streaming.");
    }

    if (!className || !subject || !chapter) {
      throw new Error(
        "className, subject and chapter are required."
      );
    }

    const { mainSubject } = parseSubject(subject);

    const topics =
      Array.isArray(index) && index.length > 0
        ? JSON.stringify(index)
        : "All key topics";

    const cacheKey =
      `lmp:quiz:${className}:${mainSubject}:${chapter}:${topics}`;

    const pendingKey =
      `lmp:quiz:pending:${className}:${mainSubject}:${chapter}:${topics}`;

    const channel = importantQuestionsRealtime({ jobId });

    // Only delete the lock if this job still owns it.
    const releaseOwnedLock = async () => {
      try {
        const currentLock = await redis.get(pendingKey);

        if (currentLock === jobId) {
          await redis.del(pendingKey);
        }
      } catch (redisError) {
        console.error(
          "[Quiz Inngest] Failed to release pending lock:",
          redisError
        );
      }
    };

    try {
      console.log("[Quiz Inngest] Starting job", {
        className,
        subject: mainSubject,
        chapter,
        topics,
      });

      // 1. Notify the frontend.
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Generating quiz",
        jobId,
        className,
        subject: mainSubject,
        chapter,
      });

      // 2. Check MongoDB for existing quiz.
      const dbCache = await step.run(
        "Check MongoDB",
        async () => {
          return await McqModel.findOne({
            className,
            subject: mainSubject,
            chapter,
          }).lean();
        }
      );

      if (dbCache?.content) {
        const safeDBData = dbCache.content;

        // 3. Restore Redis cache.
        await step.run("Restore Redis Cache", async () => {
          await redis.set(cacheKey, safeDBData, {
            ex: CACHE_TTL_SECONDS,
          });
        });

        await step.realtime.publish(
          "complete-from-database",
          channel.complete,
          {
            success: true,
            data: safeDBData,
            message: "Quiz loaded from database",
            source: "database",
            jobId,
          }
        );

        console.log("[Quiz Inngest] Served from MongoDB");

        return {
          success: true,
          source: "database",
        };
      }

      // 4. Generate the quiz. Each question is checked on its own and published
      //    the moment it passes validation. Only failed questions are rewritten.
      const result = await generateQuizOutput({
        eventData: {
          className,
          subject,
          chapter,
          index,
          difficulty,
        },
        step,

        onQuestion: async ({ index: questionIndex, item }) => {
          await inngest.realtime.publish(channel.question, {
            section: "questions",
            index: questionIndex,
            item,
            jobId,
          });
        },
      });

      if (
        !result ||
        !Array.isArray(result.questions) ||
        result.questions.length === 0
      ) {
        throw new Error(
          "Quiz service returned an invalid result."
        );
      }

      // 5. Save final quiz in MongoDB.
      await step.run("Save Quiz to MongoDB", async () => {
        await McqModel.findOneAndUpdate(
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
      });

      // 6. Save final quiz in Redis.
      await step.run("Save Quiz to Redis", async () => {
        await redis.set(cacheKey, result, {
          ex: CACHE_TTL_SECONDS,
        });
      });

      // 7. Publish the completed (validated) quiz.
      await step.realtime.publish(
        "complete-generated",
        channel.complete,
        {
          success: true,
          data: result,
          message: "Quiz generated successfully",
          source: "generated",
          jobId,
        }
      );

      console.log("[Quiz Inngest] Job completed", {
        className,
        subject: mainSubject,
        chapter,
        questions: result.questions.length,
      });

      return {
        success: true,
        source: "generated",
      };

    } catch (error) {
      console.error(
        "[Quiz Inngest] Job failed:",
        error
      );

      try {
        await step.realtime.publish(
          "generation-error",
          channel.error,
          {
            success: false,
            message: error?.message || "Failed to generate quiz",
            jobId,
          }
        );
      } catch (publishError) {
        console.error(
          "[Quiz Inngest] Failed to publish error:",
          publishError
        );
      }

      throw error;
    } finally {
      // 8. Clear pending lock (success, cache hit or failure).
      await releaseOwnedLock();
    }
  }
);