import vision from "@google-cloud/vision";
import path from "path";
import { fileURLToPath } from "url";

import { inngest } from "../../libs/inngest.js";
import { redis } from "../../libs/redis.js";
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";

import { generateSummarizerOutput } from "../../services/summarizer.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new vision.ImageAnnotatorClient({
  keyFilename: path.join(__dirname, "../../../ocr-key.json"),
});

const CACHE_TTL_SECONDS = 60 * 60 * 24;

export const summarizerFn = inngest.createFunction(
  {
    id: "summarizer-job",
    name: "Generate Topic Summary",
    // Must stay 0: a retry would re-publish chunks that were already streamed.
    retries: 0,
    triggers: [{ event: "lmp/generate.summarizer" }],
  },
  async ({ event, step }) => {
    const {
      jobId,
      contentHash,
      topic = "",
      level = "Medium",
      difficulty = "Medium",
      imageBase64 = "",
    } = event.data;

    if (!jobId || !contentHash) {
      throw new Error("Missing jobId or contentHash in summarizer event");
    }

    if (!topic.trim() && !imageBase64) {
      throw new Error("A topic or an image is required.");
    }

    const cacheKey = `lmp:summarizer:v2:${contentHash}`;
    const pendingKey = `lmp:summarizer:v2:pending:${contentHash}`;
    const channel = importantQuestionsRealtime({ jobId });

    // Only delete the lock if this job still owns it.
    const releaseOwnedLock = async () => {
      try {
        const currentLock = await redis.get(pendingKey);
        if (currentLock === jobId) await redis.del(pendingKey);
      } catch (redisError) {
        console.error("[Summarizer Inngest] Lock release failed:", redisError);
      }
    };

    try {
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: imageBase64 ? "Reading your image" : "Writing your summary",
        jobId,
      });

      // 1. OCR + labels (only when an image was sent). If Vision fails the
      //    model still gets the image itself.
      let extractedText = "";
      let labels = [];

      if (imageBase64) {
        const result = await step.run("Vision Analysis", async () => {
          try {
            const content = Buffer.from(imageBase64, "base64");

            const [textResult, labelResult] = await Promise.all([
              client.textDetection({ image: { content } }),
              client.labelDetection({ image: { content } }),
            ]);

            return {
              extractedText: textResult[0]?.fullTextAnnotation?.text || "",
              labels: (labelResult[0]?.labelAnnotations || [])
                .map((label) => label.description)
                .filter(Boolean)
                .slice(0, 5),
            };
          } catch (error) {
            console.error("[Summarizer Inngest] Vision failed:", error?.message);
            return { extractedText: "", labels: [] };
          }
        });

        extractedText = result.extractedText;
        labels = result.labels;
      }

      const mode = !imageBase64
        ? "no_image"
        : extractedText.trim()
          ? "text"
          : labels.length > 0
            ? "label_only"
            : "fallback";

      await step.realtime.publish("status-writing", channel.status, {
        event: "status",
        message: "Writing your summary",
        jobId,
      });

      // 2. Generate. Chunks are streamed live; the result is validated and
      //    rewritten (with a reset event) if it breaks a rule.
      const result = await generateSummarizerOutput({
        eventData: {
          topic,
          level,
          difficulty,
          mode,
          extractedText,
          labels,
          imageBase64,
        },
        step,

        onChunk: async ({ index, text }) => {
          await inngest.realtime.publish(channel.question, {
            section: "summary",
            index,
            item: { text },
            jobId,
          });
        },

        onReset: async () => {
          await inngest.realtime.publish(channel.status, {
            event: "reset",
            message: "Improving the summary",
            jobId,
          });
        },
      });

      if (!result || typeof result.summary !== "string" || !result.summary.trim()) {
        throw new Error("Summarizer service returned an invalid result");
      }

      // 3. Cache the validated result.
      await step.run("Save Redis", async () => {
        await redis.set(cacheKey, { summary: result.summary }, { ex: CACHE_TTL_SECONDS });
      });

      // 4. Final, validated text replaces whatever was streamed.
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: { summary: result.summary },
        message: "Summary ready",
        source: "generated",
        jobId,
      });

      return { success: true, jobId };
    } catch (error) {
      console.error(`[Summarizer Inngest] Job failed: ${jobId}`, error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to generate the summary",
          jobId,
        });
      } catch (publishError) {
        console.error("[Summarizer Inngest] Failed to publish error:", publishError);
      }

      throw error;
    } finally {
      await releaseOwnedLock();
    }
  }
);