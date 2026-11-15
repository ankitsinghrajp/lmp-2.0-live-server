import { inngest } from "../../libs/inngest.js";
import { ImpQuestionModel } from "../../models/ImportantQuestionsPage/impquestions.model.js";
import { parseSubject } from "../../utils/helper.js";
import { generateImportantQuestionsWithRag } from "../../services/importantQuestionRag.service.js";
import { redis } from "../../libs/redis.js";
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 2;
const RESPONSE_VERSION = "v2";

function isValidQuestionResponse(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.questions) &&
    data.questions.every(
      (question) =>
        question &&
        typeof question.questionText === "string" &&
        Array.isArray(question.options) &&
        Array.isArray(question.formulas) &&
        Array.isArray(question.tables) &&
        Array.isArray(question.diagrams) &&
        Array.isArray(question.graphs) &&
        Array.isArray(question.subQuestions)
    )
  );
}

function createCacheKey(className, subject, chapter, index) {
  const topics =
    Array.isArray(index) && index.length > 0
      ? JSON.stringify(index)
      : "all-topics";

  return [
    "lmp",
    "impQ",
    RESPONSE_VERSION,
    className,
    subject,
    chapter,
    topics,
  ].join(":");
}

export const importantQuestionGeneratorFn = inngest.createFunction(
  {
    name: "Generate Important Question Set",
    id: "important-question-generator",
    // Must stay 0: a retry would re-publish questions that were already streamed.
    retries: 0,
    triggers: [{ event: "lmp/generate.importantQuestions" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, index, jobId } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for Important Questions streaming.");
    }

    if (!className || !subject || !chapter) {
      throw new Error("className, subject and chapter are required.");
    }

    const { mainSubject } = parseSubject(subject);

    const cacheKey = createCacheKey(className, mainSubject, chapter, index);

    const pendingKey = `${cacheKey}:pending`;
    const channel = importantQuestionsRealtime({ jobId });

    const releaseOwnedLock = async () => {
      try {
        const currentLock = await redis.get(pendingKey);

        if (currentLock === jobId) {
          await redis.del(pendingKey);
        }
      } catch (error) {
        console.error("Failed to release Important Questions lock:", error);
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
      const dbCache = await step.run("DB Check V2", async () =>
        ImpQuestionModel.findOne({
          className,
          subject: mainSubject,
          chapter,
        })
      );

      if (isValidQuestionResponse(dbCache?.content)) {
        const cachedData = JSON.parse(JSON.stringify(dbCache.content));

        await step.run("Restore Redis Cache V2", async () => {
          await redis.set(cacheKey, JSON.stringify(cachedData), {
            ex: CACHE_TTL_SECONDS,
          });
        });

        await step.realtime.publish("complete-from-database", channel.complete, {
          success: true,
          data: cachedData,
          message: "Questions loaded from database",
          source: "database",
          jobId,
        });

        return { source: "database" };
      }

      // Old-format cached content is intentionally ignored.
      // It will be replaced after successful generation.

      // 3. Generate questions and stream each one the moment it is ready.
      //    The service calls onQuestion as soon as a question has been
      //    parsed, deduplicated, validated and (if needed) repaired.
      const ragResult = await step.run(
        "Generate Questions With Pinecone RAG V2",
        async () => {
          // Publishes are chained so questions go out in the order they are
          // emitted, and so we can wait for all of them before the step ends.
          let publishChain = Promise.resolve();

          const result = await generateImportantQuestionsWithRag({
            className,
            subject: mainSubject,
            chapter,
            topK: 20,
            onQuestion: ({ section, index: questionIndex, item }) => {
              publishChain = publishChain
                .then(() =>
                  inngest.realtime.publish(channel.question, {
                    section,
                    index: questionIndex,
                    item,
                    jobId,
                  })
                )
                .catch((error) => {
                  console.error(
                    `Failed to publish question ${questionIndex + 1}:`,
                    error?.message
                  );
                });
            },
          });

          // Make sure every question is published before "complete" is sent.
          await publishChain;

          return result;
        }
      );

      if (!isValidQuestionResponse(ragResult)) {
        throw new Error("RAG service returned an invalid questions response.");
      }

      const finalResult = {
        questions: ragResult.questions,
      };

      // The old "publish every question in a loop" step is removed on purpose.
      // Questions were already streamed in step 3; keeping it would send
      // every question twice.

      // 4. Save the new-format result to Redis.
      await step.run("Cache Questions V2", async () => {
        await redis.set(cacheKey, JSON.stringify(finalResult), {
          ex: CACHE_TTL_SECONDS,
        });

        await redis.set(
          `${cacheKey}:status`,
          JSON.stringify({
            version: RESPONSE_VERSION,
            generatedAt: new Date().toISOString(),
          }),
          { ex: CACHE_TTL_SECONDS }
        );
      });

      // 5. Save the new-format result to MongoDB.
      await step.run("Save Questions V2 To DB", async () => {
        await ImpQuestionModel.findOneAndUpdate(
          {
            className,
            subject: mainSubject,
            chapter,
          },
          {
            $set: {
              content: finalResult,
            },
          },
          {
            upsert: true,
            new: true,
          }
        );
      });

      // 6. Publish the completed response.
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: finalResult,
        message: "Questions generated successfully",
        source: "pinecone-rag-v2",
        jobId,
      });

      return {
        source: "pinecone-rag-v2",
        questionCount: finalResult.questions.length,
        cacheKey,
      };
    } catch (error) {
      console.error("Important Questions generation error:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate questions",
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