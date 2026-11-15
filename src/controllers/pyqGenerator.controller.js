import { randomUUID } from "node:crypto";
import { inngest } from "../libs/inngest.js";
import { ApiError } from "../utils/APIError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { parseSubject } from "../utils/helper.js";
import { redis } from "../libs/redis.js";
import { PyqModel } from "../models/PreviousYearQuestions/pyq.model.js";
import {
  CACHE_TTL_SECONDS,
  PENDING_TTL_SECONDS,
  createPyqCacheKey,
  isCurrentPyqResponse,
  parseCachedValue,
} from "../utils/pyqs/shared.js";
import { importantQuestionsRealtime } from "../libs/importantQuestionsRealtime.js";

const HEARTBEAT_MS = 15000;

function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return;

  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Not wrapped in asyncHandler: this handler owns its own error responses
// because it may already be streaming when something fails.
export const generatePYQsStream = async (req, res) => {
  let subscription;
  let heartbeat;
  let streamTimeout;
  let pendingKey;
  let jobId;
  let lockAcquired = false;
  let sseStarted = false;

  const releaseOwnedLock = async () => {
    if (!lockAcquired || !pendingKey || !jobId) return;

    try {
      const currentLock = await redis.get(pendingKey);

      if (currentLock === jobId) {
        await redis.del(pendingKey);
      }
    } catch (error) {
      console.error("[PYQ] Lock release failed:", error.message);
    }

    lockAcquired = false;
  };

  try {
    const { className, subject, chapter, year } = req.body || {};

    if (
      typeof className !== "string" ||
      !className.trim() ||
      typeof subject !== "string" ||
      !subject.trim() ||
      typeof chapter !== "string" ||
      !chapter.trim()
    ) {
      throw new ApiError(
        400,
        "className, subject, chapter and year are required"
      );
    }

    const yearText = String(year ?? "").trim();

    if (!/^\d{4}$/.test(yearText)) {
      throw new ApiError(400, "A valid 4-digit year is required");
    }

    const normalizedClassName = className.trim();
    const normalizedSubject = subject.trim();
    const normalizedChapter = chapter.trim();
    const normalizedYear = Number(yearText);
    const { mainSubject } = parseSubject(normalizedSubject);

    if (!mainSubject) {
      throw new ApiError(400, "Unable to identify the subject");
    }

    // Same versioned key builder as the Inngest function.
    const cacheKey = createPyqCacheKey(
      normalizedClassName,
      mainSubject,
      normalizedChapter,
      normalizedYear
    );

    pendingKey = `${cacheKey}:pending`;

    // 1. Check Redis cache.
    try {
      const cachedResult = parseCachedValue(await redis.get(cacheKey));

      if (isCurrentPyqResponse(cachedResult)) {
        return res
          .status(200)
          .json(
            new ApiResponse(200, { data: cachedResult }, "PYQs Ready (Redis)")
          );
      }
    } catch (error) {
      console.error("[PYQ] Redis cache read failed:", error.message);
    }

    // 2. Check MongoDB cache (v2 documents only; older non-RAG documents are
    //    ignored and replaced after the next successful generation).
    const dbCache = await PyqModel.findOne({
      className: normalizedClassName,
      subject: mainSubject,
      chapter: normalizedChapter,
      year: normalizedYear,
    });

    if (isCurrentPyqResponse(dbCache?.content)) {
      const dbResult = JSON.parse(JSON.stringify(dbCache.content));

      try {
        await redis.set(cacheKey, JSON.stringify(dbResult), {
          ex: CACHE_TTL_SECONDS,
        });
      } catch (error) {
        console.error("[PYQ] Redis cache restore failed:", error.message);
      }

      return res
        .status(200)
        .json(new ApiResponse(200, { data: dbResult }, "PYQs Ready (Database)"));
    }

    // 3. Acquire a job-specific generation lock.
    jobId = randomUUID();

    const lockResult = await redis.set(pendingKey, jobId, {
      nx: true,
      ex: PENDING_TTL_SECONDS,
    });

    if (!lockResult) {
      return res
        .status(202)
        .json(
          new ApiResponse(202, null, "PYQs generation already in progress")
        );
    }

    lockAcquired = true;

    // 4. Subscribe before triggering the background job.
    const channel = importantQuestionsRealtime({ jobId });

    subscription = await inngest.realtime.subscribe({
      channel,
      topics: ["status", "question", "complete", "error"],
    });

    // Stop listening as soon as the browser disconnects.
    res.on("close", () => {
      try {
        subscription?.close();
      } catch {
        /* already closed */
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

    // Keeps proxies from closing an idle connection during long generations.
    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
    }, HEARTBEAT_MS);

    // Never keep the connection open longer than the lock lives.
    streamTimeout = setTimeout(() => {
      writeSSE(res, "error", {
        success: false,
        message: "Generation timed out. Please try again.",
      });

      try {
        subscription?.close();
      } catch {
        /* already closed */
      }
    }, PENDING_TTL_SECONDS * 1000);

    writeSSE(res, "start", {
      jobId,
      message: "Preparing previous-year questions",
      className: normalizedClassName,
      subject: mainSubject,
      chapter: normalizedChapter,
      year: normalizedYear,
    });

    // 6. Trigger the Inngest function. The raw subject is sent so the
    //    function can read the book name from it as well.
    await inngest.send({
      name: "lmp/generate.pyqs",
      data: {
        className: normalizedClassName,
        subject: normalizedSubject,
        chapter: normalizedChapter,
        year: normalizedYear,
        jobId,
      },
    });

    // The background function owns the lock from this point onward.
    lockAcquired = false;

    // 7. Forward Realtime events to the client.
    const jsonStream = subscription.getJsonStream();

    for await (const message of jsonStream) {
      if (res.writableEnded || res.destroyed) break;

      const payload = message.data;

      switch (message.topic) {
        case "status":
          // "start" was already sent above, so everything here is a status.
          writeSSE(res, "status", payload);
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
  } catch (error) {
    console.error("[PYQ Realtime] Request failed:", error);

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      writeSSE(res, "error", {
        success: false,
        message:
          error instanceof ApiError
            ? error.message
            : "Failed to generate previous-year questions",
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
            error.message || "Failed to generate previous-year questions"
          )
        );
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(streamTimeout);

    if (subscription) {
      try {
        subscription.close();
      } catch (error) {
        console.error("[PYQ] Subscription cleanup failed:", error.message);
      }
    }

    await releaseOwnedLock();

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
};