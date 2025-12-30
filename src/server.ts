import Fastify from "fastify";
import type { FastifyLoggerOptions } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { LoggerOptions } from "pino";
import crypto from "node:crypto";

import { env } from "./lib/env";
import { chatRoutes } from "./routes/chat";

const isDev = env.NODE_ENV !== "production";

// Important: pass logger OPTIONS (not a pino() instance)
const logger: FastifyLoggerOptions & LoggerOptions = isDev
  ? {
      level: "info",
      transport: {
        target: "pino-pretty",
        options: {
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
    }
  : { level: "info" };

// API key used to protect /chat
// Set this in Railway Variables as: UASSISTANT_API_KEY=your_secret_value
const CHAT_API_KEY = (process.env.UASSISTANT_API_KEY ?? "").trim();

function timingSafeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

async function main(): Promise<void> {
  const app = Fastify({ logger });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow non-browser tools (curl/postman) that send no Origin
      if (!origin) return cb(null, true);

      const allowList = (env.CORS_ORIGIN ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      cb(null, allowList.includes(origin));
    },
    credentials: true,
  });

  // Rate limit (global) — /health is allow-listed
  await app.register(rateLimit, {
    global: true,
    max: 30,
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/health",
  });

  // Auth gate only for /chat*
  // Supports:
  //  - Authorization: Bearer <key>
  //  - x-api-key: <key>
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/chat")) return;

    // ✅ allow CORS preflight through (no API key on OPTIONS)
    if (req.method === "OPTIONS") return;

    // If you forgot to set a key in Railway, do NOT lock yourself out in dev.
    if (!CHAT_API_KEY) {
      if (!isDev) {
        req.log.error("UASSISTANT_API_KEY is missing in production.");
        return reply.code(500).send({ error: "SERVER_MISCONFIGURED" });
      }
      return;
    }

    const xApiKey = req.headers["x-api-key"];
    const auth = req.headers["authorization"];

    const fromHeader =
      typeof xApiKey === "string"
        ? xApiKey
        : typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
          ? auth.slice(7).trim()
          : "";

    if (!fromHeader || !timingSafeEquals(fromHeader, CHAT_API_KEY)) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(chatRoutes, { prefix: "/chat" });

  const host = env.HOST ?? "0.0.0.0";
  const port = env.PORT ?? 8080;

  await app.listen({ host, port });
  app.log.info(`Server listening on http://${host}:${port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
