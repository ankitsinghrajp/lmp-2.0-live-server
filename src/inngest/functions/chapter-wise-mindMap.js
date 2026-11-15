import { inngest } from "../../libs/inngest.js";
import { ChapterWiseMindMapModel } from "../../models/chapterWiseStudy/chapterWiseMindMap.model.js";
import { parseSubject } from "../../utils/helper.js";
import { redis } from "../../libs/redis.js";
import { generateMindMapOutput } from "../../services/chapter_wise_study/mindmap.service.js";
import {
  CACHE_TTL_SECONDS,
  ERROR_TTL_SECONDS,
  createMindMapCacheKey,
  errorKeyOf,
  isValidMindMap,
  normalizeMindMapContent,
  pendingKeyOf,
  resolveCacheSubject,
} from "../../utils/chapterWiseStudy/mindmap/cache.js";

export const chapterWiseMindMapFn = inngest.createFunction(
  {
    name: "Generate Chapter Wise MindMap",
    id: "chapter-wise-mindmap",
    retries: 0,
    triggers: [{ event: "lmp/generate.chapterWiseMindMap" }],
  },

  async ({ event, step }) => {
    const { className, subject, chapter, bookName, jobId } = event.data;

    if (!className || !subject || !chapter) {
      throw new Error("className, subject and chapter are required.");
    }

    // `subject` is the raw string (e.g. "Hindi: Kshitij Part 2").
    const { mainSubject, bookName: parsedBookName } = parseSubject(subject);
    const cacheSubject = resolveCacheSubject(subject, mainSubject);

    const cacheKey = createMindMapCacheKey(className, cacheSubject, chapter);
    const pendingKey = pendingKeyOf(cacheKey);
    const errorKey = errorKeyOf(cacheKey);

    // Released through a step so it runs once, when the job is really over.
    // Only the owner (same jobId) may release; the lock TTL is the safety net.
    const releaseLock = () =>
      step.run("release-lock", async () => {
        try {
          if (!jobId) return;
          const currentLock = await redis.get(pendingKey);
          if (currentLock === jobId) await redis.del(pendingKey);
        } catch (error) {
          console.error("Failed to release Mind Map lock:", error.message);
        }
      });

    try {
      // 1. MongoDB: a stored v2 mind map is reused.
      const stored = await step.run("db-check-v2", async () => {
        const doc = await ChapterWiseMindMapModel.findOne({
          className,
          subject: cacheSubject,
          chapter,
        }).lean();

        return isValidMindMap(doc?.content) ? doc.content : null;
      });

      if (stored) {
        const content = normalizeMindMapContent(stored);

        await step.run("restore-redis-v2", async () => {
          try {
            await redis.set(cacheKey, JSON.stringify(content), {
              ex: CACHE_TTL_SECONDS,
            });
          } catch (error) {
            console.error("Mind Map Redis restore failed:", error.message);
          }
        });

        await releaseLock();
        return { source: "database", nodeCount: content.nodes.length };
      }

      // 2. Generate with structured output.
      const generated = await step.run("generate-mindmap-v2", async () =>
        generateMindMapOutput({
          className,
          subject: mainSubject,
          fullSubject: subject,
          chapter,
          bookName: bookName || parsedBookName,
        })
      );

      if (!isValidMindMap(generated)) {
        throw new Error("Mind map service returned an invalid response.");
      }

      const finalResult = normalizeMindMapContent(generated);

      // 3. Persist. A storage failure must never fail a successful generation.
      await step.run("persist-mindmap-v2", async () => {
        try {
          await redis.set(cacheKey, JSON.stringify(finalResult), {
            ex: CACHE_TTL_SECONDS,
          });
        } catch (error) {
          console.error("Mind Map Redis save failed:", error.message);
        }

        try {
          await ChapterWiseMindMapModel.findOneAndUpdate(
            { className, subject: cacheSubject, chapter },
            { $set: { content: finalResult } },
            { upsert: true, new: true }
          );
        } catch (error) {
          console.error("Mind Map DB save failed:", error.message);
        }
      });

      await releaseLock();

      return {
        source: "generated-v2",
        nodeCount: finalResult.nodes.length,
        cacheKey,
      };
    } catch (error) {
      console.error("Mind Map generation error:", error);

      // The client is polling: leave a short-lived failure marker so the
      // controller can report the error instead of starting another job.
      try {
        await redis.set(
          errorKey,
          error?.message || "Failed to generate the mind map.",
          { ex: ERROR_TTL_SECONDS }
        );
      } catch (markerError) {
        console.error("Failed to store Mind Map error marker:", markerError);
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