import Fastify from "fastify";
import { registerGrounnelRoutes } from "../src/routes/grounnel.js";
import { DrizzleGrounnelHistoryStore } from "../src/persistence/grounnel-history-store.js";
const server = Fastify();
// Only the assessment route is exercised; the other services are never called by it.
registerGrounnelRoutes(server, {
  historyStore: new DrizzleGrounnelHistoryStore(),
} as any);
await server.listen({ port: 4319 });
console.log("listening on 4319");
