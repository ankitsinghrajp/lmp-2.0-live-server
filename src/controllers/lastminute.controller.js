import { redis } from "../libs/redis.js";
import { inngest } from "../libs/inngest.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { parseSubject } from "../utils/helper.js";
import { randomUUID } from "node:crypto";
import { importantQuestionsRealtime } from "../libs/importantQuestionsRealtime.js";
import { ImpTopicsModel } from "../models/LastMinuteBeforeExam/impTopics.model.js";
const HEARTBEAT_MS = 15000;

import {
  CACHE_TTL_SECONDS,
  PENDING_TTL_SECONDS,
  createTopicsCacheKey,
  isValidTopicsResponse,
  normalizeTopicsContent,
  parseCachedValue,
} from "../utils/last_night_before_exam/important_topics/cache.js";


const LastMinutePanelSummary = asyncHandler(
  async (req, res) => {
    const { className, subject, chapter } = req.body;

    // 1. Validate request
    if (!className || !subject || !chapter) {
      throw new ApiError(
        400,
        "className, subject and chapter are required."
      );
    }

    const { mainSubject } = parseSubject(subject);

    // 2. Redis keys
    const cacheKey =
      `lmp:summary:${className}:${mainSubject}:${chapter}`;

    const pendingKey =
      `lmp:summary:pending:${className}:${mainSubject}:${chapter}`;

    // 3. Check Redis cache
    const cachedSummary = await redis.get(cacheKey);

    if (cachedSummary) {
      const finalData =
        typeof cachedSummary === "string"
          ? JSON.parse(cachedSummary)
          : cachedSummary;

      return res.status(200).json(
        new ApiResponse(
          200,
          finalData,
          "Summary fetched successfully"
        )
      );
    }

    // 4. Acquire generation lock
    const lockAcquired = await redis.set(
      pendingKey,
      "1",
      {
        nx: true,
        ex: 300,
      }
    );

    if (!lockAcquired) {
      return res.status(202).json(
        new ApiResponse(
          202,
          null,
          "Summary generation is already in progress"
        )
      );
    }

    try {
      // 5. Trigger Inngest
      await inngest.send({
        name: "lmp/generate.summary",
        data: {
          className,
          subject,
          chapter,
        },
      });

      return res.status(202).json(
        new ApiResponse(
          202,
          null,
          "Summary generation started"
        )
      );

    } catch (error) {
      // 6. Rollback lock if event dispatch fails
      await redis.del(pendingKey);

      console.error(
        "[Summary Controller] Failed to trigger generation:",
        error
      );

      throw new ApiError(
        500,
        "Failed to start summary generation"
      );
    }
  }
);


function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return;

  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const LastMinutePanelImportantTopics = async (req, res) => {
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
      console.error("[Important Topics] Lock release failed:", error.message);
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
    const { mainSubject } = parseSubject(subject);

    if (!mainSubject) {
      throw new ApiError(400, "Unable to identify the subject");
    }

    const cacheKey = createTopicsCacheKey(
      normalizedClassName,
      mainSubject,
      normalizedChapter
    );

    pendingKey = `${cacheKey}:pending`;

    // 1. Redis cache.
    try {
      const cachedResult = parseCachedValue(await redis.get(cacheKey));

      if (isValidTopicsResponse(cachedResult)) {
        return res
          .status(200)
          .json(
            new ApiResponse(
              200,
              { data: normalizeTopicsContent(cachedResult) },
              "Important Topics Ready (Redis)"
            )
          );
      }
    } catch (error) {
      console.error("[Important Topics] Redis cache read failed:", error.message);
    }

    // 2. MongoDB cache.
    const dbCache = await ImpTopicsModel.findOne({
      className: normalizedClassName,
      subject: mainSubject,
      chapter: normalizedChapter,
    }).lean();

    if (isValidTopicsResponse(dbCache?.content)) {
      const dbResult = normalizeTopicsContent(dbCache.content);

      try {
        await redis.set(cacheKey, JSON.stringify(dbResult), {
          ex: CACHE_TTL_SECONDS,
        });
      } catch (error) {
        console.error("[Important Topics] Redis cache restore failed:", error.message);
      }

      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { data: dbResult },
            "Important Topics Ready (Database)"
          )
        );
    }

    // 3. Job-specific generation lock.
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
            "Important Topics generation is already in progress"
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

    // Stop listening as soon as the client goes away.
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

    // Comment lines keep proxies from closing an idle stream.
    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
    }, HEARTBEAT_MS);

    writeSSE(res, "start", {
      jobId,
      message: "Generating important topics",
      className: normalizedClassName,
      subject: mainSubject,
      chapter: normalizedChapter,
    });

    // 6. Trigger the Inngest function (raw subject: the book name is needed
    //    for Hindi / Sanskrit / English prompts).
    await inngest.send({
      name: "lmp/generate.importantTopics",
      data: {
        className: normalizedClassName,
        subject: subject.trim(),
        chapter: normalizedChapter,
        jobId,
      },
    });

    // The background function owns the lock from this point onward.
    lockAcquired = false;

    // 7. Forward realtime events to the client.
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
    console.error("[Important Topics Realtime] Request failed:", error);

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      writeSSE(res, "error", {
        success: false,
        message:
          error instanceof ApiError
            ? error.message
            : "Failed to generate important topics",
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
            error.message || "Failed to generate important topics"
          )
        );
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);

    if (subscription) {
      try {
        subscription.close();
      } catch (error) {
        console.error("[Important Topics] Subscription cleanup failed:", error.message);
      }
    }

    await releaseOwnedLock();

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
};




export {
  LastMinutePanelSummary,
  LastMinutePanelImportantTopics,
};
