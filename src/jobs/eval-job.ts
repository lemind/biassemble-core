import { inngest } from "./client";

export const evalJob = inngest.createFunction("evalJob", {
  name: "Evaluation Job",
  onRequest: async ({ event }) => {
    // Your evaluation logic here
    return { success: true };
  },
});