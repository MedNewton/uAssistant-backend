import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async () => {
    return {
      ok: true,
      service: "urano-uassistant-backend",
      ts: Date.now(),
    };
  });
};
