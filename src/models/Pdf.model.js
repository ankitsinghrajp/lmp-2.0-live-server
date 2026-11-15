import mongoose from "mongoose";

const pdfSchema = new mongoose.Schema(
  {
    filename: {
      type: String,
      required: true,
    },

    extractedText: {
      type: String,
      default: "",
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    jobId: {
      type: String,
      required: true,
    },

    processingStatus: {
      type: String,
      enum: ["processing", "completed", "failed"],
      default: "processing",
      index: true,
    },

    processingError: {
      type: String,
      default: null,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

// Automatically delete PDFs after 2 hours.
pdfSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7200 }
);

// One PDF record per user and content hash.
pdfSchema.index(
  { userId: 1, jobId: 1 },
  { unique: true }
);

export const PdfModel =
  mongoose.models.PdfModel ||
  mongoose.model("Pdf", pdfSchema);