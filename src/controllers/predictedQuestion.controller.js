import { randomUUID } from "node:crypto";
import { inngest } from "../libs/inngest.js";
import { importantQuestionsRealtime } from "../libs/importantQuestionsRealtime.js";
import { redis } from "../libs/redis.js";
import { ApiError } from "../utils/APIError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { parseSubject } from "../utils/helper.js";
import { PredictedQuestionModel } from "../models/LastMinuteBeforeExam/predictedQuestion.model.js";
import {
  CACHE_TTL_SECONDS,
  PENDING_TTL_SECONDS,
  createCacheKey,
  isValidQuestionResponse,
  parseCachedValue,
} from "../utils/last_night_before_exam/predicted_questions/cache.js";

// If the background job dies without publishing "complete" or "error", the
// SSE connection would otherwise stay open until the client gives up.
const STREAM_TIMEOUT_MS = 3 * 60 * 1000;

function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return;

  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * POST { className, subject, chapter }
 *
 * - Cache hit (Redis / MongoDB): plain JSON 200 { data: { questions } }
 * - Generation already running:  JSON 202
 * - Otherwise: an SSE stream with events
 *     start, status, question (one per valid question), complete, error
 */
export const predictedQuestionGeneratorStream = async (req, res) => {
  let subscription;
  let pendingKey;
  let jobId;
  let lockAcquired = false;
  let sseStarted = false;
  let timeoutTimer;
  let timedOut = false;

  const releaseOwnedLock = async () => {
    if (!lockAcquired || !pendingKey || !jobId) return;

    try {
      const currentLock = await redis.get(pendingKey);

      if (currentLock === jobId) {
        await redis.del(pendingKey);
      }
    } catch (error) {
      console.error("[Predicted Questions] Lock release failed:", error.message);
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
      throw new ApiError(400, "className, subject and chapter are required");
    }

    const normalizedClassName = className.trim();
    const normalizedChapter = chapter.trim();
    const rawSubject = subject.trim();

    // mainSubject is used for cache / lock keys and the DB query.
    // The RAW subject (e.g. "Hindi: Kshitij Part 2") is sent to Inngest so the
    // book name is not lost.
    const { mainSubject } = parseSubject(rawSubject);

    if (!mainSubject) {
      throw new ApiError(400, "Unable to identify the subject");
    }

    const cacheKey = createCacheKey(
      normalizedClassName,
      mainSubject,
      normalizedChapter
    );

    pendingKey = `${cacheKey}:pending`;

    // 1. Redis cache.
    try {
      const cachedResult = parseCachedValue(await redis.get(cacheKey));

      if (isValidQuestionResponse(cachedResult)) {
        return res
          .status(200)
          .json(
            new ApiResponse(
              200,
              { data: cachedResult },
              "Predicted Questions Ready (Redis)"
            )
          );
      }
    } catch (error) {
      // A broken cache entry or Redis read error must not block generation.
      console.error("[Predicted Questions] Redis cache read failed:", error.message);
    }

    // 2. MongoDB cache (old-format documents fail the check and are regenerated).
    try {
      const dbCache = await PredictedQuestionModel.findOne({
        className: normalizedClassName,
        subject: mainSubject,
        chapter: normalizedChapter,
      }).lean();

      if (isValidQuestionResponse(dbCache?.content)) {
        const dbResult = JSON.parse(JSON.stringify(dbCache.content));

        try {
          await redis.set(cacheKey, JSON.stringify(dbResult), {
            ex: CACHE_TTL_SECONDS,
          });
        } catch (error) {
          console.error(
            "[Predicted Questions] Redis cache restore failed:",
            error.message
          );
        }

        return res
          .status(200)
          .json(
            new ApiResponse(
              200,
              { data: dbResult },
              "Predicted Questions Ready (Database)"
            )
          );
      }
    } catch (error) {
      console.error("[Predicted Questions] MongoDB cache read failed:", error.message);
    }

    // 3. Acquire a job-specific generation lock.
    jobId = randomUUID();

    let lockResult;

    try {
      lockResult = await redis.set(pendingKey, jobId, {
        nx: true,
        ex: PENDING_TTL_SECONDS,
      });
    } catch (error) {
      console.error("[Predicted Questions] Redis lock error:", error.message);
      throw new ApiError(503, "Unable to start generation. Please retry.");
    }

    if (!lockResult) {
      return res
        .status(202)
        .json(
          new ApiResponse(
            202,
            null,
            "Predicted questions generation is already in progress"
          )
        );
    }

    lockAcquired = true;

    // 4. Subscribe BEFORE triggering the background job.
    const channel = importantQuestionsRealtime({ jobId });

    subscription = await inngest.realtime.subscribe({
      channel,
      topics: ["status", "question", "complete", "error"],
    });

    // 5. Start the SSE response.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.flushHeaders?.();
    sseStarted = true;

    writeSSE(res, "start", {
      jobId,
      message: "Generating predicted questions",
      className: normalizedClassName,
      subject: mainSubject,
      chapter: normalizedChapter,
    });

    // 6. Trigger the Inngest function.
    await inngest.send({
      name: "lmp/generate.predictedQuestions",
      data: {
        className: normalizedClassName,
        subject: rawSubject,
        chapter: normalizedChapter,
        jobId,
      },
    });

    // The background function owns the lock from this point onward.
    lockAcquired = false;

    timeoutTimer = setTimeout(() => {
      timedOut = true;

      try {
        subscription?.close();
      } catch {
        // ignore
      }
    }, STREAM_TIMEOUT_MS);

    // 7. Forward Realtime events to the client.
    const jsonStream = subscription.getJsonStream();

    for await (const message of jsonStream) {
      if (res.writableEnded || res.destroyed) break;

      const payload = message.data;

      switch (message.topic) {
        case "status":
          writeSSE(res, payload.event === "start" ? "start" : "status", payload);
          break;

        case "question":
          writeSSE(res, "question", payload);
          break;

        case "complete":
          writeSSE(res, "complete", payload);
          return;

        case "error":
          writeSSE(res, "error", payload);
          return;
      }
    }

    if (timedOut) {
      writeSSE(res, "error", {
        success: false,
        message: "Generation timed out. Please retry.",
      });
    }
  } catch (error) {
    console.error("[Predicted Questions] Request failed:", error);

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      writeSSE(res, "error", {
        success: false,
        message:
          error instanceof ApiError
            ? error.message
            : "Failed to generate predicted questions",
      });
    } else if (!res.headersSent) {
      const statusCode =
        error instanceof ApiError ? error.statusCode || 400 : 500;

      return res
        .status(statusCode)
        .json(
          new ApiResponse(
            statusCode,
            null,
            error.message || "Failed to generate predicted questions"
          )
        );
    }
  } finally {
    clearTimeout(timeoutTimer);

    if (subscription) {
      try {
        subscription.close();
      } catch (error) {
        console.error(
          "[Predicted Questions] Subscription cleanup failed:",
          error.message
        );
      }
    }

    await releaseOwnedLock();

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
};