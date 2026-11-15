import { randomUUID } from "node:crypto";
import { inngest } from "../libs/inngest.js";
import { importantQuestionsRealtime } from "../libs/importantQuestionsRealtime.js";
import { redis } from "../libs/redis.js";
import { ApiError } from "../utils/APIError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { parseSubject } from "../utils/helper.js";
import { AiCoach } from "../models/LastMinuteBeforeExam/aiCoach.model.js";
import {
  CACHE_TTL_SECONDS,
  PENDING_TTL_SECONDS,
  createCacheKey,
  createPendingKey,
  isValidCoachResponse,
  parseCachedValue,
} from "../utils/last_night_before_exam/ai_coach/cache.js";

const LOG = "[AI Coach]";

// If the background job dies without publishing "complete" or "error", the
// SSE connection would otherwise stay open until the client gives up.
const STREAM_TIMEOUT_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;

function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return;

  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * POST { className, subject, chapter }
 *
 * - Cache hit (Redis / MongoDB): plain JSON 200 { data: { steps } }
 * - Generation already running:  JSON 202
 * - Otherwise: an SSE stream with events
 *     start, status, question (one per step), complete, error
 *   "question" payload: { section: "steps", index, item: { priority, action, formula } }
 *   "complete" payload: { success, data: { steps }, ... }  (replace the streamed list)
 */
export const lastNightAICoachStream = async (req, res) => {
  let subscription;
  let pendingKey;
  let jobId;
  let lockAcquired = false;
  let sseStarted = false;
  let timeoutTimer;
  let heartbeatTimer;
  let timedOut = false;

  const releaseOwnedLock = async () => {
    if (!lockAcquired || !pendingKey || !jobId) return;

    try {
      const currentLock = await redis.get(pendingKey);

      if (currentLock === jobId) {
        await redis.del(pendingKey);
      }
    } catch (error) {
      console.error(`${LOG} Lock release failed:`, error.message);
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
    // The RAW subject is sent to Inngest so the book name is not lost.
    const { mainSubject } = parseSubject(rawSubject);

    if (!mainSubject) {
      throw new ApiError(400, "Unable to identify the subject");
    }

    const cacheKey = createCacheKey(
      normalizedClassName,
      mainSubject,
      normalizedChapter
    );

    pendingKey = createPendingKey(
      normalizedClassName,
      mainSubject,
      normalizedChapter
    );

    // 1. Redis cache.
    try {
      const cachedResult = parseCachedValue(await redis.get(cacheKey));

      if (isValidCoachResponse(cachedResult)) {
        return res
          .status(200)
          .json(
            new ApiResponse(
              200,
              { data: cachedResult },
              "AI Coach Ready (Redis)"
            )
          );
      }
    } catch (error) {
      // A broken cache entry or Redis read error must not block generation.
      console.error(`${LOG} Redis cache read failed:`, error.message);
    }

    // 2. MongoDB cache.
    try {
      const dbCache = await AiCoach.findOne({
        className: normalizedClassName,
        subject: mainSubject,
        chapter: normalizedChapter,
      }).lean();

      if (isValidCoachResponse(dbCache?.content)) {
        const dbResult = JSON.parse(JSON.stringify(dbCache.content));

        try {
          await redis.set(cacheKey, JSON.stringify(dbResult), {
            ex: CACHE_TTL_SECONDS,
          });
        } catch (error) {
          console.error(`${LOG} Redis cache restore failed:`, error.message);
        }

        return res
          .status(200)
          .json(
            new ApiResponse(
              200,
              { data: dbResult },
              "AI Coach Ready (Database)"
            )
          );
      }
    } catch (error) {
      console.error(`${LOG} MongoDB cache read failed:`, error.message);
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
      console.error(`${LOG} Redis lock error:`, error.message);
      throw new ApiError(503, "Unable to start generation. Please retry.");
    }

    if (!lockResult) {
      return res
        .status(202)
        .json(
          new ApiResponse(202, null, "AI Coach generation is already in progress")
        );
    }

    lockAcquired = true;

    // 4. Subscribe BEFORE triggering the background job.
    const channel = importantQuestionsRealtime({ jobId });

    subscription = await inngest.realtime.subscribe({
      channel,
      topics: ["status", "question", "complete", "error"],
    });

    // Client went away: stop waiting. The Inngest job keeps running and
    // still fills the cache.
    res.on("close", () => {
      try {
        subscription?.close();
      } catch {
        // ignore
      }
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
      message: "Generating AI Coach steps",
      className: normalizedClassName,
      subject: mainSubject,
      chapter: normalizedChapter,
    });

    // 6. Trigger the Inngest function.
    await inngest.send({
      name: "lmp/generate.aiCoach",
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

    // Comment lines keep proxies from closing an idle connection.
    heartbeatTimer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
    }, HEARTBEAT_MS);

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
    console.error(`${LOG} Request failed:`, error);

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      writeSSE(res, "error", {
        success: false,
        message:
          error instanceof ApiError
            ? error.message
            : "Failed to generate AI Coach",
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
            error.message || "Failed to generate AI Coach"
          )
        );
    }
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(heartbeatTimer);

    if (subscription) {
      try {
        subscription.close();
      } catch (error) {
        console.error(`${LOG} Subscription cleanup failed:`, error.message);
      }
    }

    await releaseOwnedLock();

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
};