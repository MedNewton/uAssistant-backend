import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env } from "./lib/env.js";

function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: true,
    trustProxy: true,
  });

  app.register(cors, {
    origin: env.CORS_ORIGIN ?? true,
    credentials: true,
  });

  app.get("/health", async () => {
    return { ok: true };
  });

  return app;
}

async function main(): Promise<void> {
  const app = buildServer();
  const port = env.PORT ?? 3001;
  const host = env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
