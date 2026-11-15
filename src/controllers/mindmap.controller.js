import { randomUUID } from "node:crypto";
import { inngest } from "../libs/inngest.js";
import { redis } from "../libs/redis.js";
import { ApiError } from "../utils/APIError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { parseSubject } from "../utils/helper.js";
import { ChapterWiseMindMapModel } from "../models/chapterWiseStudy/chapterWiseMindMap.model.js";
import {
  CACHE_TTL_SECONDS,
  PENDING_TTL_SECONDS,
  createMindMapCacheKey,
  errorKeyOf,
  isValidMindMap,
  normalizeMindMapContent,
  parseCachedValue,
  pendingKeyOf,
  resolveCacheSubject,
} from "../utils/chapterWiseStudy/mindmap/cache.js";

/**
 * Answers in one of three ways (the frontend already handles all of them):
 *   200  the mind map { version, title, nodes, edges }
 *   202  generation queued or already running: ask again
 *   4xx/5xx  failed
 */
export const chapterWiseMindMap = async (req, res) => {
  let pendingKey;
  let jobId;
  let lockAcquired = false;

  const releaseOwnedLock = async () => {
    if (!lockAcquired || !pendingKey || !jobId) return;

    try {
      const currentLock = await redis.get(pendingKey);
      if (currentLock === jobId) await redis.del(pendingKey);
    } catch (error) {
      console.error("[Mind Map] Lock release failed:", error.message);
    }

    lockAcquired = false;
  };

  try {
    const { className, subject, chapter } = req.body || {};

    if (
      typeof className !== "string" ||
      !className.trim() ||
      typeof subject !== "string" ||
      !subject.trim() ||
      typeof chapter !== "string" ||
      !chapter.trim()
    ) {
      throw new ApiError(400, "Missing class, subject or chapter");
    }

    const normalizedClassName = className.trim();
    const normalizedSubject = subject.trim();
    const normalizedChapter = chapter.trim();
    const { mainSubject } = parseSubject(normalizedSubject);

    if (!mainSubject) {
      throw new ApiError(400, "Unable to identify the subject");
    }

    const cacheSubject = resolveCacheSubject(normalizedSubject, mainSubject);
    const cacheKey = createMindMapCacheKey(
      normalizedClassName,
      cacheSubject,
      normalizedChapter
    );

    pendingKey = pendingKeyOf(cacheKey);
    const errorKey = errorKeyOf(cacheKey);

    // 1. Redis cache.
    try {
      const cached = parseCachedValue(await redis.get(cacheKey));

      if (isValidMindMap(cached)) {
        return res
          .status(200)
          .json(
            new ApiResponse(
              200,
              normalizeMindMapContent(cached),
              "MindMap Ready (Redis)"
            )
          );
      }
    } catch (error) {
      console.error("[Mind Map] Redis cache read failed:", error.message);
    }

    // 2. A job that just failed: report it once instead of starting another.
    let failure = null;

    try {
      failure = await redis.get(errorKey);
      if (failure) await redis.del(errorKey);
    } catch (error) {
      console.error("[Mind Map] Error marker read failed:", error.message);
    }

    if (failure) {
      return res
        .status(500)
        .json(
          new ApiResponse(
            500,
            null,
            typeof failure === "string"
              ? failure
              : "Failed to generate the mind map. Please retry."
          )
        );
    }

    // 3. MongoDB cache (only a valid v2 mind map counts).
    try {
      const doc = await ChapterWiseMindMapModel.findOne({
        className: normalizedClassName,
        subject: cacheSubject,
        chapter: normalizedChapter,
      }).lean();

      if (isValidMindMap(doc?.content)) {
        const content = normalizeMindMapContent(doc.content);

        try {
          await redis.set(cacheKey, JSON.stringify(content), {
            ex: CACHE_TTL_SECONDS,
          });
        } catch (error) {
          console.error("[Mind Map] Redis cache restore failed:", error.message);
        }

        return res
          .status(200)
          .json(new ApiResponse(200, content, "MindMap Ready (Database)"));
      }
    } catch (error) {
      console.error("[Mind Map] DB cache read failed:", error.message);
    }

    // 4. Job-specific generation lock.
    jobId = randomUUID();

    const lockResult = await redis.set(pendingKey, jobId, {
      nx: true,
      ex: PENDING_TTL_SECONDS,
    });

    if (!lockResult) {
      return res
        .status(202)
        .json(
          new ApiResponse(202, null, "MindMap generation already in progress")
        );
    }

    lockAcquired = true;

    // 5. Queue the Inngest function (raw subject: the book name is needed
    //    for Hindi / Sanskrit / English lessons).
    await inngest.send({
      name: "lmp/generate.chapterWiseMindMap",
      data: {
        className: normalizedClassName,
        subject: normalizedSubject,
        chapter: normalizedChapter,
        jobId,
      },
    });

    // The background function owns the lock from this point onward.
    lockAcquired = false;

    return res
      .status(202)
      .json(new ApiResponse(202, null, "MindMap generation queued"));
  } catch (error) {
    console.error("[Mind Map] Request failed:", error);

    await releaseOwnedLock();

    const statusCode =
      error instanceof ApiError ? error.statusCode || 400 : 500;

    return res
      .status(statusCode)
      .json(
        new ApiResponse(
          statusCode,
          null,
          error instanceof ApiError
            ? error.message
            : "Failed to queue mind map generation"
        )
      );
  }
};