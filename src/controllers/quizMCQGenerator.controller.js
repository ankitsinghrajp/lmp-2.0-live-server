import { randomUUID } from "node:crypto";
import { inngest } from "../libs/inngest.js";
import { ApiError } from "../utils/APIError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { parseSubject } from "../utils/helper.js";
import { redis } from "../libs/redis.js";
import { McqModel } from "../models/ImportantMcqsTrueFalse/mcq.model.js";
import { importantQuestionsRealtime } from "../libs/importantQuestionsRealtime.js";

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 2;
const PENDING_TTL_SECONDS = 420;

function parseCachedValue(value) {
  if (!value) return null;

  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isValidQuiz(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.questions) &&
    data.questions.length > 0
  );
}

function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return;

  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export const quizGeneratorStream = async (req, res) => {
  let subscription;
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
      console.error("[Quiz] Lock release failed:", error.message);
    }

    lockAcquired = false;
  };

  try {
    const {
      className,
      subject,
      chapter,
      index = [],
      difficulty = "Medium",
    } = req.body || {};

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
        "className, subject and chapter are required"
      );
    }

    const normalizedClassName = className.trim();
    const normalizedChapter = chapter.trim();
    const { mainSubject } = parseSubject(subject);

    if (!mainSubject) {
      throw new ApiError(400, "Unable to identify the subject");
    }

    // Same keys as the Inngest function.
    const topics =
      Array.isArray(index) && index.length > 0
        ? JSON.stringify(index)
        : "All key topics";

    const cacheKey =
      `lmp:quiz:${normalizedClassName}:${mainSubject}:${normalizedChapter}:${topics}`;

    pendingKey =
      `lmp:quiz:pending:${normalizedClassName}:${mainSubject}:${normalizedChapter}:${topics}`;

    // 1. Check Redis cache.
    try {
      const cachedResult = parseCachedValue(await redis.get(cacheKey));

      if (isValidQuiz(cachedResult)) {
        return res.status(200).json(
          new ApiResponse(
            200,
            { data: cachedResult },
            "Quiz Ready (Redis)"
          )
        );
      }
    } catch (error) {
      console.error("[Quiz] Redis cache read failed:", error.message);
    }

    // 2. Check MongoDB cache.
    const dbCache = await McqModel.findOne({
      className: normalizedClassName,
      subject: mainSubject,
      chapter: normalizedChapter,
    }).lean();

    if (isValidQuiz(dbCache?.content)) {
      const dbResult = JSON.parse(JSON.stringify(dbCache.content));

      try {
        await redis.set(cacheKey, dbResult, { ex: CACHE_TTL_SECONDS });
      } catch (error) {
        console.error("[Quiz] Redis cache restore failed:", error.message);
      }

      return res.status(200).json(
        new ApiResponse(
          200,
          { data: dbResult },
          "Quiz Ready (Database)"
        )
      );
    }

    // 3. Acquire a job-specific generation lock.
    jobId = randomUUID();

    const lockResult = await redis.set(pendingKey, jobId, {
      nx: true,
      ex: PENDING_TTL_SECONDS,
    });

    if (!lockResult) {
      return res.status(202).json(
        new ApiResponse(
          202,
          null,
          "Quiz generation is already in progress"
        )
      );
    }

    lockAcquired = true;

    // 4. Subscribe before triggering the background job.
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
      message: "Generating quiz",
      className: normalizedClassName,
      subject: mainSubject,
      chapter: normalizedChapter,
    });

    // 6. Trigger the Inngest function.
    //    The raw subject is sent because the service needs the book name.
    await inngest.send({
      name: "lmp/generate.quizMcqFillupTrueFalse",
      data: {
        className: normalizedClassName,
        subject,
        chapter: normalizedChapter,
        index,
        difficulty,
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
          writeSSE(
            res,
            payload.event === "start"
              ? "start"
              : payload.event === "reset"
                ? "reset"
                : "status",
            payload
          );
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
    console.error("[Quiz Realtime] Request failed:", error);

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      writeSSE(res, "error", {
        success: false,
        message:
          error instanceof ApiError
            ? error.message
            : "Failed to generate quiz",
      });
    } else if (!res.headersSent) {
      const statusCode =
        error instanceof ApiError ? error.statusCode || 400 : 500;

      return res.status(statusCode).json(
        new ApiResponse(
          statusCode,
          null,
          error.message || "Failed to generate quiz"
        )
      );
    }
  } finally {
    if (subscription) {
      try {
        subscription.close();
      } catch (error) {
        console.error("[Quiz] Subscription cleanup failed:", error.message);
      }
    }

    await releaseOwnedLock();

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
};