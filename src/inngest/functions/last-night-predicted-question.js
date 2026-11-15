import { inngest } from "../../libs/inngest.js";
import { PredictedQuestionModel } from "../../models/LastMinuteBeforeExam/predictedQuestion.model.js";
import { parseSubject, detectCategory } from "../../utils/helper.js";
import { redis } from "../../libs/redis.js";
// The realtime channel is keyed only by jobId (a fresh UUID per request), so the
// Important Questions channel is reused as is: topics status / question /
// complete / error.
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";
import { generatePredictedQuestionsOutput } from "../../services/last_night_before_exam/predicted_question.service.js";
import {
  CACHE_TTL_SECONDS,
  RESPONSE_VERSION,
  createCacheKey,
  isValidQuestionResponse,
} from "../../utils/last_night_before_exam/predicted_questions/cache.js";

export const lastNightPredictedQuestionsFn = inngest.createFunction(
  {
    id: "lmp-predicted-questions",
    name: "Generate LMP Predicted Questions",
    retries: 0,
    triggers: [{ event: "lmp/generate.predictedQuestions" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, jobId } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for Predicted Questions streaming.");
    }

    if (!className || !subject || !chapter) {
      throw new Error("className, subject and chapter are required.");
    }

    // subject is the RAW subject (e.g. "Hindi: Kshitij Part 2") so the book
    // name is not lost.
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
        console.error("Failed to release Predicted Questions lock:", error);
      }
    };

    try {
      // 1. Notify the frontend.
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Generating predicted questions",
        jobId,
        className,
        subject: mainSubject,
        chapter,
      });

      // 2. Check MongoDB for a response in the new format.
      //    Old-format documents fail isValidQuestionResponse and are replaced
      //    after a successful generation.
      const dbCache = await step.run("DB Check Predicted V2", async () =>
        PredictedQuestionModel.findOne({
          className,
          subject: mainSubject,
          chapter,
        }).lean()
      );

      if (isValidQuestionResponse(dbCache?.content)) {
        const cachedData = JSON.parse(JSON.stringify(dbCache.content));

        await step.run("Restore Predicted Redis Cache V2", async () => {
          await redis.set(cacheKey, JSON.stringify(cachedData), {
            ex: CACHE_TTL_SECONDS,
          });
        });

        await step.realtime.publish(
          "complete-from-database",
          channel.complete,
          {
            success: true,
            data: cachedData,
            message: "Predicted questions loaded from database",
            source: "database",
            jobId,
          }
        );

        return { source: "database" };
      }

      // 3. Generate. Every valid question is published the moment it is ready,
      //    while the model is still writing the next ones.
      const generated = await step.run(
        "Generate Predicted Questions V2",
        async () => {
          // Publishes run one after another so questions reach the client in
          // the order they were completed. A failed publish never blocks the rest.
          let publishChain = Promise.resolve();

          const result = await generatePredictedQuestionsOutput({
            className,
            subject: mainSubject,
            chapter,
            bookName,
            category,
            onQuestion: ({ section, index, item }) => {
              publishChain = publishChain
                .then(() =>
                  inngest.realtime.publish(channel.question, {
                    section,
                    index,
                    item,
                    jobId,
                  })
                )
                .catch((error) => {
                  console.error(
                    `Failed to publish predicted question ${index + 1}:`,
                    error?.message
                  );
                });
            },
          });

          await publishChain;
          return result;
        }
      );

      if (!isValidQuestionResponse(generated)) {
        throw new Error("Predicted questions service returned an invalid response.");
      }

      const finalResult = { questions: generated.questions };

      // 4. Save to Redis.
      await step.run("Cache Predicted Questions V2", async () => {
        await redis.set(cacheKey, JSON.stringify(finalResult), {
          ex: CACHE_TTL_SECONDS,
        });
      });

      // 5. Save to MongoDB (replaces any old-format document).
      await step.run("Save Predicted Questions V2 To DB", async () => {
        await PredictedQuestionModel.findOneAndUpdate(
          { className, subject: mainSubject, chapter },
          { $set: { content: finalResult } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      });

      // 6. Publish the completed response. This one is sorted (Very High first),
      //    so the frontend should replace its streamed list with it.
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: finalResult,
        message: "Predicted questions generated successfully",
        source: `predicted-${RESPONSE_VERSION}`,
        jobId,
      });

      return {
        source: `predicted-${RESPONSE_VERSION}`,
        questionCount: finalResult.questions.length,
        cacheKey,
      };
    } catch (error) {
      console.error("Predicted Questions Inngest error:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate predicted questions",
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