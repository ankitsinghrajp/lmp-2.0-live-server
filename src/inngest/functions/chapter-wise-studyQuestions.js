import { inngest } from "../../libs/inngest.js";
import { ChapterWiseImportantQuestionModel } from "../../models/chapterWiseStudy/chapterWiseImportantQuestion.model.js";
import { parseSubject, detectCategory } from "../../utils/helper.js";
import { redis } from "../../libs/redis.js";
// The realtime channel is keyed only by jobId (a fresh UUID per request), so the
// Important Questions channel is reused as is: topics status / question /
// complete / error.
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";
import { generateImportantQuestionsOutput } from "../../services/chapter_wise_study/studyQuestions.service.js";
import {
  CACHE_TTL_SECONDS,
  RESPONSE_VERSION,
  createCacheKey,
  isValidQuestionResponse,
} from "../../utils/chapterWiseStudy/studyQuestions/cache.js";

/**
 * Streams the chapter-wise important questions (RAG + structured output).
 *
 * This replaces both the old "primary + background LaTeX fixer" functions:
 * every question is now validated and repaired before it is published, so the
 * fixer function (lmp/fix.chapterWiseStudyQuestions) is no longer needed.
 */
export const chapterWiseStudyQuestionsFn = inngest.createFunction(
  {
    id: "chapter-wise-study-questions",
    name: "Generate Chapter Wise Study Questions",
    retries: 0,
    triggers: [{ event: "lmp/generate.chapterWiseStudyQuestions" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, jobId } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for Chapter Wise Questions streaming.");
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
        console.error("Failed to release Chapter Wise Questions lock:", error);
      }
    };

    try {
      // 1. Notify the frontend.
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Generating important questions",
        jobId,
        className,
        subject: mainSubject,
        chapter,
      });

      // 2. Check MongoDB for a response in the new format.
      //    Old-format documents ({ question } only) fail isValidQuestionResponse
      //    and are replaced after a successful generation.
      const dbCache = await step.run("DB Check Chapter Questions V2", async () =>
        ChapterWiseImportantQuestionModel.findOne({
          className,
          subject: mainSubject,
          chapter,
        }).lean()
      );

      if (isValidQuestionResponse(dbCache?.content)) {
        const cachedData = JSON.parse(JSON.stringify(dbCache.content));

        await step.run("Restore Chapter Questions Redis Cache V2", async () => {
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
            message: "Important questions loaded from database",
            source: "database",
            jobId,
          }
        );

        return { source: "database" };
      }

      // 3. Generate. Every valid question is published the moment it is ready,
      //    while the model is still writing the next ones.
      const generated = await step.run(
        "Generate Chapter Questions V2",
        async () => {
          // Publishes run one after another so questions reach the client in
          // the order they were completed. A failed publish never blocks the rest.
          let publishChain = Promise.resolve();

          const result = await generateImportantQuestionsOutput({
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
                    `Failed to publish chapter question ${index + 1}:`,
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
        throw new Error("Chapter questions service returned an invalid response.");
      }

      const finalResult = { questions: generated.questions };

      // 4. Save to Redis.
      await step.run("Cache Chapter Questions V2", async () => {
        await redis.set(cacheKey, JSON.stringify(finalResult), {
          ex: CACHE_TTL_SECONDS,
        });
      });

      // 5. Save to MongoDB (replaces any old-format document).
      await step.run("Save Chapter Questions V2 To DB", async () => {
        await ChapterWiseImportantQuestionModel.findOneAndUpdate(
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
        message: "Important questions generated successfully",
        source: `chapter-questions-${RESPONSE_VERSION}`,
        jobId,
      });

      return {
        source: `chapter-questions-${RESPONSE_VERSION}`,
        questionCount: finalResult.questions.length,
        cacheKey,
      };
    } catch (error) {
      console.error("Chapter Wise Questions Inngest error:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate important questions",
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