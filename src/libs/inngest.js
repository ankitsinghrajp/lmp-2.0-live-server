
import { Inngest } from "inngest";

// export const inngest = new Inngest({
//   id: "lmp-app",
//   eventKey: process.env.INNGEST_EVENT_KEY,
//   signingKey: process.env.INNGEST_SIGNING_KEY
// });


export const inngest = new Inngest({
  id: "lmp-app",
  isDev:true
});