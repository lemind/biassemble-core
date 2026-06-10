// Vercel serverless entry point
// Uses the official Vercel Fastify pattern:
//   await app.ready()
//   app.server.emit("request", req, reply)
import { buildApp } from "../dist/server.js";

// Build the app once and cache it
let cachedApp: ReturnType<typeof buildApp> | null = null;

async function getApp() {
  if (!cachedApp) {
    cachedApp = buildApp();
    await cachedApp.ready();
  }
  return cachedApp;
}

// Vercel Function handler
export default async function handler(
  req: any,
  res: any,
) {
  const app = await getApp();
  app.server.emit("request", req, res);
}