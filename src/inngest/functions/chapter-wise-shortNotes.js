import { inngest } from "../../libs/inngest.js";
import { ChapterWiseShortNotesModel } from "../../models/chapterWiseStudy/chapterWiseShortNotes.model.js";
import { parseSubject } from "../../utils/helper.js";
import { redis } from "../../libs/redis.js";
// Short notes reuse the same realtime channel (keyed by jobId). The "question"
// topic carries { section: "markdown", index, markdown, jobId } for this feature.
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";
import { generateShortNotesOutput } from "../../services/chapter_wise_study/shortNotes.service.js";
import {
  CACHE_TTL_SECONDS,
  createNotesCacheKey,
  isValidNotesResponse,
  normalizeNotesContent,
  resolveCacheSubject,
} from "../../utils/chapterWiseStudy/shortNotes/cache.js";

export const chapterWiseShortNotesFn = inngest.createFunction(
  {
    name: "Generate Chapter Wise Short Notes",
    id: "chapter-wise-short-notes",
    // Must stay 0: a retry would re-publish concepts that were already streamed.
    retries: 0,
    triggers: [{ event: "lmp/generate.chapterWiseShortNotes" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, bookName, jobId } = event.data;

    if (!jobId) {
      throw new Error("Missing jobId for Short Notes streaming.");
    }

    if (!className || !subject || !chapter) {
      throw new Error("className, subject and chapter are required.");
    }

    // `subject` is the raw string (e.g. "Hindi: Kshitij Part 2").
    const { mainSubject, bookName: parsedBookName } = parseSubject(subject);
    const cacheSubject = resolveCacheSubject(subject, mainSubject);

    const cacheKey = createNotesCacheKey(className, cacheSubject, chapter);
    const pendingKey = `${cacheKey}:pending`;
    const channel = importantQuestionsRealtime({ jobId });

    // Released through a step (not a `finally`) so it only runs once, when
    // the job is really over. The controller's lock TTL is the safety net.
    const releaseLock = () =>
      step.run("release-lock", async () => {
        try {
          const currentLock = await redis.get(pendingKey);
          if (currentLock === jobId) await redis.del(pendingKey);
        } catch (error) {
          console.error("Failed to release Short Notes lock:", error.message);
        }
      });

    try {
      // 1. Notify the frontend.
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Generating short notes",
        jobId,
        className,
        subject: mainSubject,
        chapter,
      });

      // 2. Generate. Each finished concept is published the moment it is ready.
      //    This happens inside one memoized step, so later re-invocations of
      //    the function never re-send the concepts.
      const generated = await step.run("generate-short-notes-v2", async () =>
        generateShortNotesOutput({
          className,
          subject: mainSubject,
          fullSubject: subject,
          chapter,
          bookName: bookName || parsedBookName,
          onChunk: ({ index, markdown }) =>
            inngest.realtime.publish(channel.question, {
              section: "markdown",
              index,
              markdown,
              jobId,
            }),
        })
      );

      if (!isValidNotesResponse(generated)) {
        throw new Error("Short notes service returned an invalid response.");
      }

      const finalResult = normalizeNotesContent(generated);

      // 3. Persist. A storage failure must never fail a successful generation.
      await step.run("persist-short-notes-v2", async () => {
        try {
          await redis.set(cacheKey, JSON.stringify(finalResult), {
            ex: CACHE_TTL_SECONDS,
          });
        } catch (error) {
          console.error("Short Notes Redis save failed:", error.message);
        }

        try {
          await ChapterWiseShortNotesModel.findOneAndUpdate(
            { className, subject: cacheSubject, chapter },
            { $set: { content: finalResult.markdown } },
            { upsert: true, new: true }
          );
        } catch (error) {
          console.error("Short Notes DB save failed:", error.message);
        }
      });

      // 4. Publish the completed response (client replaces streamed blocks with it).
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: finalResult,
        message: "Short notes generated successfully",
        source: "generated-v2",
        jobId,
      });

      await releaseLock();

      return {
        source: "generated-v2",
        conceptCount: generated.conceptCount,
        cacheKey,
      };
    } catch (error) {
      console.error("Short Notes generation error:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate short notes",
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