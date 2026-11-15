import { createHash, randomUUID } from "node:crypto";
import { inngest } from "../libs/inngest.js";
import { redis } from "../libs/redis.js";
import { ApiError } from "../utils/APIError.js";
import { importantQuestionsRealtime } from "../libs/importantQuestionsRealtime.js";

const PENDING_TTL_SECONDS = 300;
const HEARTBEAT_MS = 15000;
const MAX_QUESTION_CHARS = 4000;
const CACHE_PREFIX = "lmp:topper:v2";

const clean = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

function parseCachedValue(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const isValidResult = (data) =>
  Boolean(data) &&
  typeof data === "object" &&
  typeof data.answer === "string" &&
  data.answer.trim().length > 0;

function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return;

  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export const topperStyleAnswer = async (req, res) => {
  let subscription;
  let heartbeat;
  let pendingKey;
  let runId;
  let lockAcquired = false;
  let sseStarted = false;

  const releaseOwnedLock = async () => {
    if (!lockAcquired || !pendingKey || !runId) return;

    try {
      const currentLock = await redis.get(pendingKey);
      if (currentLock === runId) await redis.del(pendingKey);
    } catch (error) {
      console.error("[Topper] Lock release failed:", error.message);
    }

    lockAcquired = false;
  };

  try {
    const question = clean(req.body?.user_question, MAX_QUESTION_CHARS);
    const selectedClass = clean(req.body?.selectedClass, 40);
    const selectedSubject = clean(req.body?.selectedSubject);
    const selectedChapter = clean(req.body?.selectedChapter);
    const regenerate =
      req.body?.regenerate === true || req.body?.regenerate === "true";

    if (!question || !selectedClass || !selectedSubject || !selectedChapter) {
      throw new ApiError(400, "Missing required fields");
    }

    // Same class + subject + chapter + (normalized) question -> same cache entry.
    const normalizedQuestion = question.toLowerCase().replace(/\s+/g, " ").trim();

    const contentHash = createHash("sha256")
      .update(
        [selectedClass, selectedSubject, selectedChapter, normalizedQuestion].join("|")
      )
      .digest("hex");

    const cacheKey = `${CACHE_PREFIX}:${contentHash}`;
    pendingKey = `${CACHE_PREFIX}:pending:${contentHash}`;

    // 1. Redis cache (skipped on regenerate. The old answer stays in Redis
    //    until the new one is ready, so a failed regeneration loses nothing).
    if (!regenerate) {
      try {
        const cached = parseCachedValue(await redis.get(cacheKey));

        if (isValidResult(cached)) {
          return res.status(200).json({
            success: true,
            message: "Answer ready",
            data: { answer: cached.answer },
          });
        }
      } catch (error) {
        console.error("[Topper] Redis cache read failed:", error.message);
      }
    }

    // 2. Job-specific lock.
    runId = randomUUID();

    const lockResult = await redis.set(pendingKey, runId, {
      nx: true,
      ex: PENDING_TTL_SECONDS,
    });

    if (!lockResult) {
      return res.status(202).json({
        success: true,
        message: regenerate
          ? "Regeneration already in progress"
          : "Answer generation already in progress",
      });
    }

    lockAcquired = true;

    // 3. Subscribe BEFORE starting the background job.
    const channel = importantQuestionsRealtime({ jobId: runId });

    subscription = await inngest.realtime.subscribe({
      channel,
      topics: ["status", "question", "complete", "error"],
    });

    // 4. Start the SSE response.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    sseStarted = true;

    // Keeps proxies from closing the connection while the model works.
    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
    }, HEARTBEAT_MS);

    // Client left: stop listening (the job still finishes and fills the cache).
    res.on("close", () => {
      try {
        subscription?.close();
      } catch {
        /* already closed */
      }
    });

    writeSSE(res, "start", {
      jobId: runId,
      message: regenerate ? "Regenerating your answer" : "Writing your answer",
    });

    // 5. Start the background job.
    await inngest.send({
      name: "lmp/generate.topperAnswer",
      data: {
        jobId: runId,
        contentHash,
        question,
        selectedClass,
        selectedSubject,
        selectedChapter,
      },
    });

    // The background function owns the lock from here.
    lockAcquired = false;

    // 6. Forward realtime events to the client.
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

        case "question": // answer text chunks
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
    console.error("[Topper] Request failed:", error);

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      writeSSE(res, "error", {
        success: false,
        message:
          error instanceof ApiError ? error.message : "Failed to answer the question",
      });
    } else if (!res.headersSent) {
      const statusCode = error instanceof ApiError ? error.statusCode || 400 : 500;

      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to answer the question",
      });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);

    if (subscription) {
      try {
        subscription.close();
      } catch (error) {
        console.error("[Topper] Subscription cleanup failed:", error.message);
      }
    }

    await releaseOwnedLock();

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
};