import { ApiError } from "../utils/APIError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { redis } from "../libs/redis.js";
import { inngest } from "../libs/inngest.js";

import crypto from "crypto";
import fs from "fs/promises";

export const uploadPdfAndProcess = asyncHandler(async (req, res) => {
  const filePath = req.file?.path;

  if (!filePath) {
    throw new ApiError(400, "PDF is required");
  }

  if (!req.user?._id) {
    await fs.unlink(filePath).catch(() => {});
    throw new ApiError(401, "Authentication required");
  }

  const userId = req.user._id.toString();

  let pendingKey = null;
  let lockAcquired = false;
  let queuedSuccessfully = false;

  try {
    // 1. Read uploaded PDF
    const fileBuffer = await fs.readFile(filePath);

    if (!fileBuffer.length) {
      throw new ApiError(400, "Uploaded PDF is empty");
    }

    // 2. Generate content-based job ID
    const jobId = crypto
      .createHash("sha256")
      .update(fileBuffer)
      .digest("hex");

    // 3. User-specific Redis keys
    const cacheKey = `lmp:pdf:${userId}:${jobId}`;
    pendingKey = `lmp:pdf:pending:${userId}:${jobId}`;

    // 4. Check Redis cache
    try {
      const cached = await redis.get(cacheKey);

      if (cached) {
        return res.status(200).json(
          new ApiResponse(200, cached, "PDF processed")
        );
      }
    } catch (error) {
      console.error("PDF Redis cache error:", error);
    }

    // 5. Acquire processing lock
    const acquired = await redis.set(pendingKey, "1", {
      nx: true,
      ex: 120,
    });

    if (!acquired) {
      return res.status(202).json(
        new ApiResponse(
          202,
          { jobId },
          "PDF processing already in progress"
        )
      );
    }

    lockAcquired = true;

    // 6. Queue Inngest processing
    await inngest.send({
      name: "lmp/generate.pdfProcessing",
      data: {
        jobId,
        filePath,
        originalName: req.file.originalname,
        userId,
      },
    });

    queuedSuccessfully = true;

    return res.status(202).json(
      new ApiResponse(
        202,
        { jobId },
        "PDF processing queued"
      )
    );
  } catch (error) {
    if (lockAcquired && pendingKey) {
      await redis.del(pendingKey).catch((redisError) => {
        console.error("PDF lock cleanup failed:", redisError);
      });
    }

    if (error instanceof ApiError) {
      throw error;
    }

    console.error("PDF upload error:", error);

    throw new ApiError(500, "Failed to queue PDF processing");
  } finally {
    // Inngest needs the file after successful event delivery.
    // Otherwise, remove the temporary upload.
    if (!queuedSuccessfully) {
      await fs.unlink(filePath).catch((error) => {
        if (error.code !== "ENOENT") {
          console.error("PDF file cleanup failed:", error);
        }
      });
    }
  }
});