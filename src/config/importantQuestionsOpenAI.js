import OpenAI from "openai";
import "dotenv/config";

// if (!process.env.OPENAI_API_KEY) {
//   throw new Error(
//     "Missing OPENAI_API_KEY in environment configuration"
//   );
// }

export const importantQuestionsOpenAI = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});