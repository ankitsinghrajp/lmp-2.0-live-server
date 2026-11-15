
import { randomUUID } from "node:crypto";
import { inngest } from "../libs/inngest.js";
import { importantQuestionsRealtime } from "../libs/importantQuestionsRealtime.js";
import { ApiError } from "../utils/APIError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { parseSubject } from "../utils/helper.js";
import { redis } from "../libs/redis.js";
import { ImpQuestionModel } from "../models/ImportantQuestionsPage/impquestions.model.js";

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 2;
const PENDING_TTL_SECONDS = 420;
const RESPONSE_VERSION = "v2";

function parseCachedValue(value) {
  if (!value) return null;

  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isValidQuestionResponse(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.questions) &&
    data.questions.every(
      (question) =>
        question &&
        typeof question.questionText === "string" &&
        Array.isArray(question.options) &&
        Array.isArray(question.formulas) &&
        Array.isArray(question.tables) &&
        Array.isArray(question.diagrams) &&
        Array.isArray(question.graphs) &&
        Array.isArray(question.subQuestions)
    )
  );
}

function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return;

  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createCacheKey(className, subject, chapter, index) {
  const topics =
    Array.isArray(index) && index.length > 0
      ? JSON.stringify(index)
      : "all-topics";

  return [
    "lmp",
    "impQ",
    RESPONSE_VERSION,
    className,
    subject,
    chapter,
    topics,
  ].join(":");
}

function hasSpecificTopics(index) {
  return Array.isArray(index) && index.length > 0;
}

export const importantQuestionGeneratorStream = async (req, res) => {
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
      console.error(
        "[Important Questions] Lock release failed:",
        error.message
      );
    }

    lockAcquired = false;
  };

  try {
    const { className, subject, chapter, index } = req.body || {};

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

    // Use the same versioned cache-key format as the Inngest function.
    const cacheKey = createCacheKey(
      normalizedClassName,
      mainSubject,
      normalizedChapter,
      index
    );

    pendingKey = `${cacheKey}:pending`;

    // 1. Check Redis cache.
    try {
      const cachedResult = parseCachedValue(
        await redis.get(cacheKey)
      );

      if (isValidQuestionResponse(cachedResult)) {
        return res.status(200).json(
          new ApiResponse(
            200,
            { data: cachedResult },
            "Important Questions Ready (Redis)"
          )
        );
      }
    } catch (error) {
      console.error(
        "[Important Questions] Redis cache read failed:",
        error.message
      );
    }

    // 2. Check MongoDB cache.
    // Topic-specific requests bypass MongoDB cache because the
    // existing database query does not distinguish selected topics.
    if (!hasSpecificTopics(index)) {
      const dbCache = await ImpQuestionModel.findOne({
        className: normalizedClassName,
        subject: mainSubject,
        chapter: normalizedChapter,
      });

      if (isValidQuestionResponse(dbCache?.content)) {
        const dbResult = JSON.parse(
          JSON.stringify(dbCache.content)
        );

        try {
          await redis.set(
            cacheKey,
            JSON.stringify(dbResult),
            { ex: CACHE_TTL_SECONDS }
          );
        } catch (error) {
          console.error(
            "[Important Questions] Redis cache restore failed:",
            error.message
          );
        }

        return res.status(200).json(
          new ApiResponse(
            200,
            { data: dbResult },
            "Important Questions Ready (Database)"
          )
        );
      }
    }

    // 3. Acquire a job-specific generation lock.
    jobId = randomUUID();

    const lockResult = await redis.set(
      pendingKey,
      jobId,
      {
        nx: true,
        ex: PENDING_TTL_SECONDS,
      }
    );

    if (!lockResult) {
      return res.status(202).json(
        new ApiResponse(
          202,
          null,
          "Important questions generation is already in progress"
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
    res.setHeader(
      "Content-Type",
      "text/event-stream; charset=utf-8"
    );
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.flushHeaders?.();
    sseStarted = true;

    writeSSE(res, "start", {
      jobId,
      message: "Generating important questions",
      className: normalizedClassName,
      subject: mainSubject,
      chapter: normalizedChapter,
    });

    // 6. Trigger the Inngest function.
    await inngest.send({
      name: "lmp/generate.importantQuestions",
      data: {
        className: normalizedClassName,
        subject: mainSubject,
        chapter: normalizedChapter,
        index,
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
            payload.event === "start" ? "start" : "status",
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
    console.error(
      "[Important Questions Realtime] Request failed:",
      error
    );

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      writeSSE(res, "error", {
        success: false,
        message:
          error instanceof ApiError
            ? error.message
            : "Failed to generate important questions",
      });
    } else if (!res.headersSent) {
      const statusCode =
        error instanceof ApiError
          ? error.statusCode || 400
          : 500;

      return res.status(statusCode).json(
        new ApiResponse(
          statusCode,
          null,
          error.message || "Failed to generate important questions"
        )
      );
    }
  } finally {
    if (subscription) {
      try {
        subscription.close();
      } catch (error) {
        console.error(
          "[Important Questions] Subscription cleanup failed:",
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
