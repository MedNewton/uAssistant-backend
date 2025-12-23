import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env } from "./lib/env";

import { healthRoutes } from "./routes/health";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  app.register(cors, {
    origin: env.CORS_ORIGIN ?? true,
    credentials: true,
  });

  app.register(healthRoutes, { prefix: "/health" });

  return app;
}

async function main(): Promise<void> {
  const app = buildApp();

  const host = env.HOST ?? "0.0.0.0";
  const port = env.PORT ?? 8080;

  try {
    await app.listen({ host, port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
