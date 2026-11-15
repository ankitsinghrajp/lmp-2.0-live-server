
import { realtime, staticSchema } from "inngest";

// Each generation request receives its own channel.
// The browser does not receive direct access to this channel;
// Express subscribes to it on the server.
export const importantQuestionsRealtime = realtime.channel({
  name: ({ jobId }) => `lmp:important-questions:${jobId}`,

  topics: {
    status: {
      schema: staticSchema(),
    },
    question: {
      schema: staticSchema(),
    },
    complete: {
      schema: staticSchema(),
    },
    error: {
      schema: staticSchema(),
    },
  },
});
