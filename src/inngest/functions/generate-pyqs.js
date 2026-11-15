import { inngest } from "../../libs/inngest.js";
import { PyqModel } from "../../models/PreviousYearQuestions/pyq.model.js";
import { parseSubject } from "../../utils/helper.js";
import { redis } from "../../libs/redis.js";
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";
import { generatePyqsWithRag } from "../../services/pyqRag.service.js";
import {
  CACHE_TTL_SECONDS,
  MIN_PYQS,
  RESPONSE_VERSION,
  createPyqCacheKey,
  isCurrentPyqResponse,
} from "../../utils/pyqs/shared.js";

export const generatePYQsFn = inngest.createFunction(
  {
    name: "Generate PYQs",
    id: "generate-pyqs",
    // Must stay 0: a retry would re-publish questions that were already streamed.
    retries: 0,
    triggers: [{ event: "lmp/generate.pyqs" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, year, jobId } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for PYQ streaming.");
    }

    if (!className || !subject || !chapter || !year) {
      throw new Error("className, subject, chapter and year are required.");
    }

    const { mainSubject, bookName } = parseSubject(subject);
    const numericYear = Number(year);

    const cacheKey = createPyqCacheKey(
      className,
      mainSubject,
      chapter,
      numericYear
    );
    const pendingKey = `${cacheKey}:pending`;
    const channel = importantQuestionsRealtime({ jobId });

    const releaseOwnedLock = async () => {
      try {
        const currentLock = await redis.get(pendingKey);

        if (currentLock === jobId) {
          await redis.del(pendingKey);
        }
      } catch (error) {
        console.error("Failed to release PYQ lock:", error);
      }
    };

    // NOTE: the lock is released explicitly on every exit path (success,
    // database hit, error) instead of in a `finally`. Inngest re-enters this
    // handler after each step, and a `finally` could release the lock before
    // generation has finished.
    try {
      // 1. Notify the frontend.
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Preparing previous-year questions",
        jobId,
        className,
        subject: mainSubject,
        chapter,
        year: numericYear,
      });

      // 2. Safety check for a v2 response already stored in MongoDB
      //    (the controller checks too; this covers a race between requests).
      const dbCache = await step.run("DB Check V2", async () =>
        PyqModel.findOne({
          className,
          subject: mainSubject,
          chapter,
          year: numericYear,
        })
      );

      if (isCurrentPyqResponse(dbCache?.content)) {
        const cachedData = JSON.parse(JSON.stringify(dbCache.content));

        await step.run("Restore Redis Cache V2", async () => {
          await redis.set(cacheKey, JSON.stringify(cachedData), {
            ex: CACHE_TTL_SECONDS,
          });
        });

        await step.realtime.publish("complete-from-database", channel.complete, {
          success: true,
          data: cachedData,
          message: "PYQs loaded from database",
          source: "database",
          jobId,
        });

        await releaseOwnedLock();
        return { source: "database" };
      }

      // 3. Retrieve PYQs, fix half-written ones, generate any shortfall, and
      //    stream each question the moment it is ready.
      const ragResult = await step.run(
        "Generate PYQs With Pinecone RAG V2",
        async () => {
          // Publishes are chained so questions go out in the order they are
          // emitted, and so we can wait for all of them before the step ends.
          let publishChain = Promise.resolve();

          const result = await generatePyqsWithRag({
            className,
            subject: mainSubject,
            bookName,
            chapter,
            year: numericYear,
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
                    `Failed to publish PYQ ${index + 1}:`,
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

      const finalContent = ragResult?.content;

      if (!isCurrentPyqResponse(finalContent)) {
        throw new Error("PYQ service returned an invalid response.");
      }

      // A short set is shown to the user but never cached or stored, so a
      // retry can produce a full one.
      const isFullSet = finalContent.pyqs.length >= MIN_PYQS;

      if (isFullSet) {
        // 4. Save to Redis.
        await step.run("Cache PYQs V2", async () => {
          await redis.set(cacheKey, JSON.stringify(finalContent), {
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

        // 5. Save to MongoDB (keyed by year, so years never overwrite each other).
        await step.run("Save PYQs V2 To DB", async () => {
          await PyqModel.findOneAndUpdate(
            {
              className,
              subject: mainSubject,
              chapter,
              year: numericYear,
            },
            { $set: { content: finalContent } },
            { upsert: true, new: true }
          );
        });
      } else {
        console.warn(
          `PYQ set for ${cacheKey} has ${finalContent.pyqs.length} questions (< ${MIN_PYQS}); not cached.`
        );
      }

      // 6. Publish the completed response.
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: finalContent,
        message: isFullSet
          ? "PYQs generated successfully"
          : "Fewer questions than usual were generated. Please try again for a full set.",
        source: "pinecone-rag-v2",
        jobId,
      });

      await releaseOwnedLock();

      return {
        source: "pinecone-rag-v2",
        questionCount: finalContent.pyqs.length,
        cached: isFullSet,
        stats: ragResult.stats,
        cacheKey,
      };
    } catch (error) {
      console.error("PYQ generation error:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate PYQs",
          jobId,
        });
      } catch (publishError) {
        console.error("Failed to publish PYQ generation error:", publishError);
      }

      await releaseOwnedLock();

      throw error;
    }
  }
);