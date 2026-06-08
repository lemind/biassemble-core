import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "biassemble-core",
  name: "Biassemble Core",
  eventKey: process.env.INNGEST_EVENT_KEY,
});
