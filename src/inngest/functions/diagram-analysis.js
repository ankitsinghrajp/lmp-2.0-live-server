import vision from "@google-cloud/vision";
import path from "path";
import { fileURLToPath } from "url";

import { inngest } from "../../libs/inngest.js";
import { redis } from "../../libs/redis.js";
import { importantQuestionsRealtime } from "../../libs/importantQuestionsRealtime.js";

import { generateDiagramExplanation } from "../../services/diagram.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new vision.ImageAnnotatorClient({
  keyFilename: path.join(__dirname, "../../../ocr-key.json"),
});

const CACHE_TTL_SECONDS = 60 * 60 * 24;

export const diagramImageAnalysisFn = inngest.createFunction(
  {
    id: "diagram-image-analysis",
    name: "Generate Diagram Image Analysis",
    // Must stay 0: a retry would re-publish chunks that were already streamed.
    retries: 0,
    triggers: [{ event: "lmp/generate.diagramAnalysis" }],
  },
  async ({ event, step }) => {
    const {
      jobId,
      contentHash,
      imageBase64,
      subject = "English",
      chapter = "",
    } = event.data;

    if (!jobId || !contentHash || !imageBase64) {
      throw new Error("jobId, contentHash and imageBase64 are required.");
    }

    const cacheKey = `lmp:diagram:v2:${contentHash}`;
    const pendingKey = `lmp:diagram:v2:pending:${contentHash}`;
    const channel = importantQuestionsRealtime({ jobId });

    // Only delete the lock if this job still owns it.
    const releaseOwnedLock = async () => {
      try {
        const currentLock = await redis.get(pendingKey);
        if (currentLock === jobId) await redis.del(pendingKey);
      } catch (redisError) {
        console.error("[Diagram Inngest] Lock release failed:", redisError);
      }
    };

    try {
      await step.realtime.publish("status-start", channel.status, {
        event: "start",
        message: "Reading your diagram",
        jobId,
      });

      // 1. OCR + labels. If Vision fails the model still gets the image itself.
      const { extractedText, labels } = await step.run(
        "Vision Analysis",
        async () => {
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
            console.error("[Diagram Inngest] Vision failed:", error?.message);
            return { extractedText: "", labels: [] };
          }
        }
      );

      const mode = extractedText.trim()
        ? "text"
        : labels.length > 0
          ? "label_only"
          : "fallback";

      await step.realtime.publish("status-writing", channel.status, {
        event: "status",
        message: "Writing your exam-ready explanation",
        jobId,
      });

      // 2. Generate. Chunks are streamed live; the result is validated and
      //    rewritten (with a reset event) if it breaks a rule.
      const result = await generateDiagramExplanation({
        eventData: {
          subject,
          chapter,
          mode,
          extractedText,
          labels,
          imageBase64,
        },
        step,

        onChunk: async ({ index, text }) => {
          await inngest.realtime.publish(channel.question, {
            section: "diagram",
            index,
            item: { text },
            jobId,
          });
        },

        onReset: async () => {
          await inngest.realtime.publish(channel.status, {
            event: "reset",
            message: "Improving the explanation",
            jobId,
          });
        },
      });

      // 3. Cache the validated result.
      await step.run("Save Diagram Result to Redis", async () => {
        await redis.set(cacheKey, result, { ex: CACHE_TTL_SECONDS });
      });

      // 4. Final, validated text replaces whatever was streamed.
      await step.realtime.publish("complete-generated", channel.complete, {
        success: true,
        data: result,
        message: "Diagram analyzed successfully",
        source: "generated",
        jobId,
      });

      return { success: true, jobId };
    } catch (error) {
      console.error("[Diagram Inngest] Job failed:", error);

      try {
        await step.realtime.publish("generation-error", channel.error, {
          success: false,
          message: error?.message || "Failed to analyze the diagram",
          jobId,
        });
      } catch (publishError) {
        console.error("[Diagram Inngest] Failed to publish error:", publishError);
      }

      throw error;
    } finally {
      await releaseOwnedLock();
    }
  }
);