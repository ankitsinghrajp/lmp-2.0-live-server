import { inngest } from "../../libs/inngest.js";
import { LastMinuteMCQModel } from "../../models/LastMinuteBeforeExam/lastMinuteMcq.model.js";
import { parseSubject } from "../../utils/helper.js";
import { redis } from "../../libs/redis.js";
// The realtime channel is keyed only by jobId (a fresh UUID per request), so the
// Important Questions channel is reused as is: topics status / question /
// complete / error.
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";
import { generateMCQsOutput } from "../../services/last_night_before_exam/mcq.service.js";
import {
  CACHE_TTL_SECONDS,
  RESPONSE_VERSION,
  createCacheKey,
  isValidMcqResponse,
} from "../../utils/last_night_before_exam/mcqs/cache.js";

export const lastNightMCQsFn = inngest.createFunction(
  {
    id: "lmp-mcqs",
    name: "Generate LMP MCQs",
    retries: 0,
    triggers: [{ event: "lmp/generate.mcqs" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, jobId } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for MCQs streaming.");
    }

    if (!className || !subject || !chapter) {
      throw new Error("className, subject and chapter are required.");
    }

    // subject is the RAW subject (e.g. "Hindi: Kshitij Part 2") so the book
    // name is not lost.
    const { mainSubject, bookName } = parseSubject(subject);

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
        console.error("Failed to release MCQs lock:", error);
      }
    };

    try {
      // 1. Notify the frontend.
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Generating MCQs",
        jobId,
        className,
        subject: mainSubject,
        chapter,
      });

      // 2. Check MongoDB for a response in the new format.
      //    Old-format documents fail isValidMcqResponse and are replaced
      //    after a successful generation.
      const dbCache = await step.run("DB Check MCQs V2", async () =>
        LastMinuteMCQModel.findOne({
          className,
          subject: mainSubject,
          chapter,
        }).lean()
      );

      if (isValidMcqResponse(dbCache?.content)) {
        const cachedData = JSON.parse(JSON.stringify(dbCache.content));

        await step.run("Restore MCQs Redis Cache V2", async () => {
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
            message: "MCQs loaded from database",
            source: "database",
            jobId,
          }
        );

        return { source: "database" };
      }

      // 3. Generate. Every valid MCQ is published the moment it is ready,
      //    while the model is still writing the next ones.
      const generated = await step.run("Generate MCQs V2", async () => {
        // Publishes run one after another so MCQs reach the client in the
        // order they were completed. A failed publish never blocks the rest.
        let publishChain = Promise.resolve();

        const result = await generateMCQsOutput({
          className,
          subject: mainSubject,
          chapter,
          bookName,
          onMcq: ({ section, index, item }) => {
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
                  `Failed to publish MCQ ${index + 1}:`,
                  error?.message
                );
              });
          },
        });

        await publishChain;
        return result;
      });

      if (!isValidMcqResponse(generated)) {
        throw new Error("MCQ service returned an invalid response.");
      }

      const finalResult = { mcqs: generated.mcqs };

      // 4. Save to Redis.
      await step.run("Cache MCQs V2", async () => {
        await redis.set(cacheKey, JSON.stringify(finalResult), {
          ex: CACHE_TTL_SECONDS,
        });
      });

      // 5. Save to MongoDB (replaces any old-format document).
      await step.run("Save MCQs V2 To DB", async () => {
        await LastMinuteMCQModel.findOneAndUpdate(
          { className, subject: mainSubject, chapter },
          { $set: { content: finalResult } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      });

      // 6. Publish the completed response.
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: finalResult,
        message: "MCQs generated successfully",
        source: `mcqs-${RESPONSE_VERSION}`,
        jobId,
      });

      return {
        source: `mcqs-${RESPONSE_VERSION}`,
        mcqCount: finalResult.mcqs.length,
        cacheKey,
      };
    } catch (error) {
      console.error("MCQs Inngest error:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate MCQs",
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