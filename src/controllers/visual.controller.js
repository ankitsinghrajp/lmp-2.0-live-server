import { randomUUID } from "node:crypto";
import { inngest } from "../libs/inngest.js";
import { redis } from "../libs/redis.js";
import { ApiError } from "../utils/APIError.js";
import { importantQuestionsRealtime } from "../libs/importantQuestionsRealtime.js";
import {
  VISUAL_TYPES,
  createVisualKeys,
  isValidVisual,
  parseCachedValue,
} from "../utils/visual/cache.js";

const PENDING_TTL_SECONDS = 300;
const HEARTBEAT_MS = 15000;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_FIELD_CHARS = 100;

function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return;

  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export const visualController = async (req, res) => {
  let subscription;
  let heartbeat;
  let pendingKey;
  let jobId;
  let lockAcquired = false;
  let sseStarted = false;

  const releaseOwnedLock = async () => {
    if (!lockAcquired || !pendingKey || !jobId) return;

    try {
      const currentLock = await redis.get(pendingKey);
      if (currentLock === jobId) await redis.del(pendingKey);
    } catch (error) {
      console.error("[Visual] Lock release failed:", error.message);
    }

    lockAcquired = false;
  };

  try {
    const { type, description, subject = "", className = "" } = req.body || {};

    if (!VISUAL_TYPES.includes(type)) {
      throw new ApiError(400, "type must be diagram or graph");
    }

    if (
      typeof description !== "string" ||
      !description.trim() ||
      description.length > MAX_DESCRIPTION_CHARS
    ) {
      throw new ApiError(
        400,
        `description is required and must not exceed ${MAX_DESCRIPTION_CHARS} characters`
      );
    }

    if (typeof subject !== "string" || typeof className !== "string") {
      throw new ApiError(400, "subject and className must be strings");
    }

    const normalized = {
      type,
      description: description.trim(),
      subject: subject.trim().slice(0, MAX_FIELD_CHARS),
      className: className.trim().slice(0, MAX_FIELD_CHARS),
    };

    const keys = createVisualKeys(normalized);
    const { cacheKey } = keys;
    pendingKey = keys.pendingKey;

    // 1. Redis cache.
    try {
      const cached = parseCachedValue(await redis.get(cacheKey));

      if (isValidVisual(cached) && cached.type === type) {
        return res.status(200).json({
          success: true,
          message: "Visual ready",
          data: cached,
        });
      }
    } catch (error) {
      console.error("[Visual] Redis cache read failed:", error.message);
    }

    // 2. Job-specific lock.
    jobId = randomUUID();

    const lockResult = await redis.set(pendingKey, jobId, {
      nx: true,
      ex: PENDING_TTL_SECONDS,
    });

    if (!lockResult) {
      return res.status(202).json({
        success: true,
        message: "This diagram is already being drawn",
        retryAfterMs: 3000,
      });
    }

    lockAcquired = true;

    // 3. Subscribe BEFORE starting the background job.
    const channel = importantQuestionsRealtime({ jobId });

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

    writeSSE(res, "start", { jobId, message: "Drawing your diagram" });

    // 5. Start the background job.
    await inngest.send({
      name: "lmp/generate.questionVisual",
      data: { ...normalized, jobId, cacheKey, pendingKey },
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

        case "question": // diagram code chunks
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
    console.error("[Visual] Request failed:", error);

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      writeSSE(res, "error", {
        success: false,
        message:
          error instanceof ApiError ? error.message : "Failed to generate the diagram",
      });
    } else if (!res.headersSent) {
      const statusCode = error instanceof ApiError ? error.statusCode || 400 : 500;

      return res.status(statusCode).json({
        success: false,
        message:
          error instanceof ApiError ? error.message : "Failed to generate the diagram",
      });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);

    if (subscription) {
      try {
        subscription.close();
      } catch (error) {
        console.error("[Visual] Subscription cleanup failed:", error.message);
      }
    }

    await releaseOwnedLock();

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
};