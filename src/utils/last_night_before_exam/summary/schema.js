
export const summaryResponseSchema = {
  type: "object",
  additionalProperties: false,

  properties: {
    summary: {
      type: "string",
      description:
        "Complete student-friendly chapter summary following the subject-specific summary structure.",
    },
  },

  required: [
    "summary",
  ],
};
