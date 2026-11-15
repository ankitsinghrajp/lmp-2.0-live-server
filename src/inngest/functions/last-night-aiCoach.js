import { inngest } from "../../libs/inngest.js";
import { AiCoach } from "../../models/LastMinuteBeforeExam/aiCoach.model.js";
import { parseSubject, detectCategory } from "../../utils/helper.js";
import { redis } from "../../libs/redis.js";
// The realtime channel is keyed only by jobId, so the Important Questions
// channel is reused as is: topics status / question / complete / error.
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";
import { generateAICoachOutput } from "../../services/last_night_before_exam/ai_coach.service.js";
import {
  CACHE_TTL_SECONDS,
  createCacheKey,
  createPendingKey,
  isValidCoachResponse,
} from "../../utils/last_night_before_exam/ai_coach/cache.js";

export const lastNightAICoachFn = inngest.createFunction(
  {
    id: "lmp-ai-coach",
    name: "Generate LMP AI Coach",
    retries: 0,
    triggers: [{ event: "lmp/generate.aiCoach" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, jobId } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for AI Coach streaming.");
    }

    if (!className || !subject || !chapter) {
      throw new Error("className, subject and chapter are required.");
    }

    // subject is the RAW subject (e.g. "Hindi: Kshitij Part 2") so the book
    // name is not lost.
    const { mainSubject, bookName } = parseSubject(subject);
    const category = detectCategory(mainSubject);

    const cacheKey = createCacheKey(className, mainSubject, chapter);
    const pendingKey = createPendingKey(className, mainSubject, chapter);
    const channel = importantQuestionsRealtime({ jobId });

    try {
      // 1. Notify the frontend.
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Generating AI Coach steps",
        jobId,
        className,
        subject: mainSubject,
        chapter,
      });

      // 2. MongoDB cache.
      const dbCache = await step.run("check-ai-coach-db", async () =>
        AiCoach.findOne({
          className,
          subject: mainSubject,
          chapter,
        }).lean()
      );

      if (isValidCoachResponse(dbCache?.content)) {
        const cachedData = JSON.parse(JSON.stringify(dbCache.content));

        await step.run("restore-ai-coach-cache", async () => {
          await redis.set(cacheKey, JSON.stringify(cachedData), {
            ex: CACHE_TTL_SECONDS,
          });
        });

        await step.realtime.publish("complete-from-database", channel.complete, {
          success: true,
          data: cachedData,
          message: "AI Coach loaded from database",
          source: "database",
          jobId,
        });

        return { source: "database" };
      }

      // 3. Generate. Every valid step is published the moment it is ready,
      //    while the model is still writing the next ones.
      const generated = await step.run("generate-ai-coach", async () => {
        // Publishes run one after another so steps reach the client in order.
        // A failed publish never blocks the rest.
        let publishChain = Promise.resolve();

        const result = await generateAICoachOutput({
          className,
          subject: mainSubject,
          chapter,
          bookName,
          category,
          onStep: ({ index, item }) => {
            publishChain = publishChain
              .then(() =>
                inngest.realtime.publish(channel.question, {
                  section: "steps",
                  index,
                  item,
                  jobId,
                })
              )
              .catch((error) => {
                console.error(
                  `Failed to publish AI Coach step ${index + 1}:`,
                  error?.message
                );
              });
          },
        });

        await publishChain;
        return result;
      });

      if (!isValidCoachResponse(generated)) {
        throw new Error("AI Coach service returned an invalid response.");
      }

      const finalResult = { steps: generated.steps };

      // 4. Save to MongoDB and Redis.
      await step.run("save-ai-coach", async () => {
        await AiCoach.findOneAndUpdate(
          { className, subject: mainSubject, chapter },
          { $set: { content: finalResult } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        await redis.set(cacheKey, JSON.stringify(finalResult), {
          ex: CACHE_TTL_SECONDS,
        });
      });

      // 5. Publish the completed response.
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: finalResult,
        message: "AI Coach generated successfully",
        source: "generated",
        jobId,
      });

      return { source: "generated", stepCount: finalResult.steps.length };
    } catch (error) {
      console.error("AI Coach Inngest error:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate AI Coach",
          jobId,
        });
      } catch (publishError) {
        console.error("Failed to publish AI Coach error:", publishError);
      }

      throw error;
    } finally {
      // Memoized step: the lock is released exactly once, and only by its owner.
      await step.run("release-ai-coach-lock", async () => {
        const currentLock = await redis.get(pendingKey);

        if (currentLock === jobId) {
          await redis.del(pendingKey);
        }
      });
    }
  }
);