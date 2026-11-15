import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { inngest } from "../libs/inngest.js";
import { redis } from "../libs/redis.js";
import { ApiError } from "../utils/APIError.js";
import { importantQuestionsRealtime } from "../libs/importantQuestionsRealtime.js";

const PENDING_TTL_SECONDS = 300;
const HEARTBEAT_MS = 15000;
const MAX_TOPIC_CHARS = 2000;

// Event payloads have a size limit, so the image is shrunk before it is sent.
const MAX_IMAGE_SIDE = 1600;

const LEVELS = ["Short", "Medium", "Long"];
const DIFFICULTIES = ["Easy", "Medium", "Hard"];

const pick = (value, allowed, fallback) => {
  const match = allowed.find(
    (item) => item.toLowerCase() === String(value ?? "").trim().toLowerCase()
  );
  return match ?? fallback;
};

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
  typeof data.summary === "string" &&
  data.summary.trim().length > 0;

function writeSSE(res, event, data) {
  if (res.writableEnded || res.destroyed) return;

  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function preprocessImage(buffer) {
  try {
    const output = await sharp(buffer)
      .rotate() // respect phone camera orientation
      .resize({
        width: MAX_IMAGE_SIDE,
        height: MAX_IMAGE_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" }) // transparent PNGs become white
      .jpeg({ quality: 88 })
      .toBuffer();

    return output.toString("base64");
  } catch {
    throw new ApiError(
      400,
      "Could not read this file. Please upload a clear JPG, PNG or WebP image."
    );
  }
}

export const summarizer = async (req, res) => {
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
      console.error("[Summarizer] Lock release failed:", error.message);
    }

    lockAcquired = false;
  };

  try {
    const topic =
      typeof req.body?.topic === "string"
        ? req.body.topic.trim().slice(0, MAX_TOPIC_CHARS)
        : "";
    const level = pick(req.body?.level, LEVELS, "Medium");
    const difficulty = pick(req.body?.difficulty, DIFFICULTIES, "Medium");

    const file = req.files?.image?.[0];

    if (!topic && !file?.buffer) {
      throw new ApiError(400, "Either a topic or an image is required!");
    }

    // Same topic + settings + image -> same cache entry.
    const imageHash = file?.buffer
      ? createHash("sha256").update(file.buffer).digest("hex")
      : "";

    const contentHash = createHash("sha256")
      .update(JSON.stringify({ topic, level, difficulty, imageHash }))
      .digest("hex");

    const cacheKey = `lmp:summarizer:v2:${contentHash}`;
    pendingKey = `lmp:summarizer:v2:pending:${contentHash}`;

    // 1. Redis cache.
    try {
      const cached = parseCachedValue(await redis.get(cacheKey));

      if (isValidResult(cached)) {
        return res.status(200).json({
          success: true,
          message: "Summary ready",
          data: { summary: cached.summary },
        });
      }
    } catch (error) {
      console.error("[Summarizer] Redis cache read failed:", error.message);
    }

    // 2. Shrink the image (also rejects unreadable files before locking).
    const imageBase64 = file?.buffer ? await preprocessImage(file.buffer) : "";

    // 3. Job-specific lock.
    runId = randomUUID();

    const lockResult = await redis.set(pendingKey, runId, {
      nx: true,
      ex: PENDING_TTL_SECONDS,
    });

    if (!lockResult) {
      return res.status(202).json({
        success: true,
        message: "This summary is already being written",
      });
    }

    lockAcquired = true;

    // 4. Subscribe BEFORE starting the background job.
    const channel = importantQuestionsRealtime({ jobId: runId });

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

    // Keeps proxies from closing the connection during OCR.
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
      message: file?.buffer ? "Reading your image" : "Writing your summary",
    });

    // 6. Start the background job.
    await inngest.send({
      name: "lmp/generate.summarizer",
      data: {
        jobId: runId,
        contentHash,
        topic,
        level,
        difficulty,
        imageBase64,
      },
    });

    // The background function owns the lock from here.
    lockAcquired = false;

    // 7. Forward realtime events to the client.
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

        case "question": // summary text chunks
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
    console.error("[Summarizer] Request failed:", error);

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      writeSSE(res, "error", {
        success: false,
        message:
          error instanceof ApiError ? error.message : "Failed to generate the summary",
      });
    } else if (!res.headersSent) {
      const statusCode = error instanceof ApiError ? error.statusCode || 400 : 500;

      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to generate the summary",
      });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);

    if (subscription) {
      try {
        subscription.close();
      } catch (error) {
        console.error("[Summarizer] Subscription cleanup failed:", error.message);
      }
    }

    await releaseOwnedLock();

    if (sseStarted && !res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
};