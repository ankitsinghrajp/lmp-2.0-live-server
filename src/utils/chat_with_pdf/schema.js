export const chatWithPdfResponseSchema = {
  type: "object",
  properties: {
    answer: {
      type: "string",
    },
    isAvailableInPdf: {
      type: "boolean",
    },
  },
  required: ["answer", "isAvailableInPdf"],
  additionalProperties: false,
};