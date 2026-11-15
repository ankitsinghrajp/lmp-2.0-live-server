import { randomUUID } from "node:crypto";
import { inngest } from "../libs/inngest.js";
import { redis } from "../libs/redis.js";
import { importantQuestionsRealtime } from "../libs/importantQuestionsRealtime.js";
import { ApiError } from "../utils/APIError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { parseSubject } from "../utils/helper.js";
import {
  PENDING_TTL_SECONDS,
  createBoostersCacheKey,
  isValidBoostersResponse,
  normalizeBoostersContent,
  parseCachedValue,
  resolveCacheSubject,
} from "../utils/last_night_before_exam/memory_boosters/cache.js";

const HEARTBEAT_MS = 15000;

function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return;

  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const LastMinutePanelMemoryBooster = async (req, res) => {
  let subscription;
  let pendingKey;
  let jobId;
  let heartbeat;
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
      console.error("[Memory Booster] Lock release failed:", error.message);
    }

    lockAcquired = false;
  };

  try {
    const { className, subject, chapter, bookName } = req.body || {};

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
    const { mainSubject } = parseSubject(subject);

    if (!mainSubject) {
      throw new ApiError(400, "Unable to identify the subject");
    }

    const cacheKey = createBoostersCacheKey(
      normalizedClassName,
      resolveCacheSubject(subject, mainSubject),
      normalizedChapter
    );

    pendingKey = `${cacheKey}:pending`;

    // 1. Redis cache.
    try {
      const cachedResult = parseCachedValue(await redis.get(cacheKey));

      if (isValidBoostersResponse(cachedResult)) {
        return res
          .status(200)
          .json(
            new ApiResponse(
              200,
              { data: normalizeBoostersContent(cachedResult) },
              "Memory Boosters Ready (Redis)"
            )
          );
      }
    } catch (error) {
      console.error("[Memory Booster] Redis cache read failed:", error.message);
    }

    // 2. Job-specific generation lock.
    jobId = randomUUID();

    const lockResult = await redis.set(pendingKey, jobId, {
      nx: true,
      ex: PENDING_TTL_SECONDS,
    });

    if (!lockResult) {
      return res
        .status(202)
        .json(
          new ApiResponse(
            202,
            null,
            "Memory booster generation is already in progress"
          )
        );
    }

    lockAcquired = true;

    // 3. Subscribe BEFORE triggering the background job.
    const channel = importantQuestionsRealtime({ jobId });

    subscription = await inngest.realtime.subscribe({
      channel,
      topics: ["status", "question", "complete", "error"],
    });

    // Stop listening as soon as the client goes away.
    res.on("close", () => {
      try {
        subscription?.close();
      } catch {
        /* already closed */
      }
    });

    // 4. Start the SSE response.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.flushHeaders?.();
    sseStarted = true;

    // Comment lines keep proxies from closing an idle stream.
    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
    }, HEARTBEAT_MS);

    writeSSE(res, "start", {
      jobId,
      message: "Generating memory boosters",
      className: normalizedClassName,
      subject: mainSubject,
      chapter: normalizedChapter,
    });

    // 5. Trigger the Inngest function (raw subject: the book name is needed
    //    for Hindi / Sanskrit / English prompts).
    await inngest.send({
      name: "lmp/generate.memoryBooster",
      data: {
        className: normalizedClassName,
        subject: subject.trim(),
        chapter: normalizedChapter,
        bookName: typeof bookName === "string" ? bookName.trim() : undefined,
        jobId,
      },
    });

    // The background function owns the lock from this point onward.
    lockAcquired = false;

    // 6. Forward realtime events to the client.
    const jsonStream = subscription.getJsonStream();

    for await (const message of jsonStream) {
      if (res.writableEnded || res.destroyed) break;

      const payload = message.data;

      switch (message.topic) {
        case "status":
          writeSSE(res, payload.event === "start" ? "start" : "status", payload);
          break;

        case "question":
          // Same realtime topic as Important Questions, exposed as "chunk".
          writeSSE(res, "chunk", payload);
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
    console.error("[Memory Booster Realtime] Request failed:", error);

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      writeSSE(res, "error", {
        success: false,
        message:
          error instanceof ApiError
            ? error.message
            : "Failed to generate memory boosters",
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
            error.message || "Failed to generate memory boosters"
          )
        );
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);

    if (subscription) {
      try {
        subscription.close();
      } catch (error) {
        console.error("[Memory Booster] Subscription cleanup failed:", error.message);
      }
    }

    await releaseOwnedLock();

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
};

export { LastMinutePanelMemoryBooster };