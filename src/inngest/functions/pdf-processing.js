import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import fsPromises from "fs/promises";
import vision from "@google-cloud/vision";
import path from "path";
import { fileURLToPath } from "url";

import { inngest } from "../../libs/inngest.js";
import { redis } from "../../libs/redis.js";
import { PdfModel } from "../../models/Pdf.model.js";
import { User } from "../../models/user.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new vision.ImageAnnotatorClient({
  keyFilename: path.join(__dirname, "../../../ocr-key.json"),
});

// Extract text from digitally generated PDFs
const extractTextFromPDF = async (pdfPath) => {
  const data = new Uint8Array(fs.readFileSync(pdfPath));

  const pdfDoc = await pdfjsLib.getDocument({ data }).promise;

  let text = "";

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();

    text += "\n" + content.items.map((item) => item.str).join(" ");
  }

  return text.trim();
};

// Detect scanned PDFs
const isScannedPDF = (text) => !text || text.length < 150;

// Existing OCR fallback
const extractTextWithOCR = async (pdfPath) => {
  const buffer = fs.readFileSync(pdfPath);

  const [result] = await client.documentTextDetection({
    image: { content: buffer },
  });

  return result.fullTextAnnotation?.text?.trim() || "";
};

export const pdfProcessingFn = inngest.createFunction(
  {
    id: "pdf-processing",
    name: "Process PDF Upload",
    retries: 0,
    triggers: [
      {
        event: "lmp/generate.pdfProcessing",
      },
    ],
  },

  async ({ event, step }) => {
    const {
      jobId,
      filePath,
      originalName,
      userId,
    } = event.data;

    if (!jobId || !filePath || !userId) {
      throw new Error("Invalid PDF processing event data.");
    }

    const cacheKey = `lmp:pdf:${userId}:${jobId}`;
    const pendingKey = `lmp:pdf:pending:${userId}:${jobId}`;

    let pdfId = null;

    try {
      // 1. Create or retrieve the PDF record
      const pdfDoc = await step.run(
        "Create PDF Processing Record",
        async () => {
          return PdfModel.findOneAndUpdate(
            { userId, jobId },
            {
              $setOnInsert: {
                filename: originalName,
                extractedText: "",
                userId,
                jobId,
                processingStatus: "processing",
                processingError: null,
              },
            },
            {
              upsert: true,
              new: true,
              runValidators: true,
            }
          );
        }
      );

      pdfId = pdfDoc._id.toString();

      // 2. Skip extraction if already completed
      if (pdfDoc.processingStatus === "completed") {
        await step.run("Restore Completed PDF Cache", async () => {
          await redis.set(
            cacheKey,
            { pdfId },
            { ex: 60 * 60 * 24 }
          );

          await redis.del(pendingKey);
        });

        return {
          success: true,
          pdfId,
          status: "completed",
          source: "database",
        };
      }

      // 3. Reset previously failed processing
      if (pdfDoc.processingStatus === "failed") {
        await step.run("Reset PDF Processing Status", async () => {
          await PdfModel.updateOne(
            { _id: pdfDoc._id, processingStatus: "failed" },
            {
              $set: {
                processingStatus: "processing",
                processingError: null,
              },
            }
          );
        });
      }

      // 4. Extract PDF text
      const extractedText = await step.run(
        "Extract PDF Text",
        async () => {
          let text = await extractTextFromPDF(filePath);

          if (isScannedPDF(text)) {
            text = await extractTextWithOCR(filePath);
          }

          if (!text || text.length < 50) {
            throw new Error(
              "PDF is unreadable or contains insufficient text."
            );
          }

          return text;
        }
      );

      // 5. Mark PDF completed
      const completedPdf = await step.run(
        "Save Extracted Text and Complete PDF",
        async () => {
          return PdfModel.findOneAndUpdate(
            {
              _id: pdfId,
              processingStatus: "processing",
            },
            {
              $set: {
                extractedText,
                processingStatus: "completed",
                processingError: null,
              },
            },
            {
              new: true,
            }
          );
        }
      );

      // 6. Increment count only on successful transition
      if (completedPdf) {
        await step.run("Update User PDF Upload Count", async () => {
          await User.findByIdAndUpdate(userId, {
            $inc: {
              pdfUploadsThisMonth: 1,
            },
          });
        });
      }

      // 7. Save Redis cache
      await step.run("Save PDF Redis Cache", async () => {
        await redis.set(
          cacheKey,
          { pdfId },
          { ex: 60 * 60 * 24 }
        );
      });

      // 8. Clear pending lock
      await step.run("Clear PDF Pending Lock", async () => {
        await redis.del(pendingKey);
      });

      return {
        success: true,
        pdfId,
        status: "completed",
      };
    } catch (error) {
      console.error("PDF processing failed:", error);

      // Mark processing record as failed
      if (pdfId) {
        await PdfModel.updateOne(
          {
            _id: pdfId,
            processingStatus: "processing",
          },
          {
            $set: {
              processingStatus: "failed",
              processingError: error.message || "PDF processing failed",
            },
          }
        ).catch((dbError) => {
          console.error("Failed to update PDF status:", dbError);
        });
      }

      await redis.del(pendingKey).catch(console.error);

      throw error;
    } finally {
      await fsPromises.unlink(filePath).catch((error) => {
        if (error.code !== "ENOENT") {
          console.error("PDF temporary file cleanup failed:", error);
        }
      });
    }
  }
);