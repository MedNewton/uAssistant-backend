import Fastify from "fastify";
import type { FastifyLoggerOptions } from "fastify";
import cors from "@fastify/cors";
import type { LoggerOptions } from "pino";

import { env } from "./lib/env";
import { chatRoutes } from "./routes/chat";

const isDev = env.NODE_ENV !== "production";

// Important: pass logger OPTIONS (not pino() instance)
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
  : {
      level: "info",
    };

async function main(): Promise<void> {
  const app = Fastify({ logger });

  await app.register(cors, {
    origin: env.CORS_ORIGIN ?? true,
    credentials: true,
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
