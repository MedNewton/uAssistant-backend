"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const env_1 = require("./lib/env");
const chat_1 = require("./routes/chat");
const isDev = env_1.env.NODE_ENV !== "production";
// Important: pass logger OPTIONS (not pino() instance)
const logger = isDev
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
async function main() {
    const app = (0, fastify_1.default)({ logger });
    await app.register(cors_1.default, {
        origin: env_1.env.CORS_ORIGIN ?? true,
        credentials: true,
    });
    app.get("/health", async () => ({ ok: true }));
    await app.register(chat_1.chatRoutes, { prefix: "/chat" });
    const host = env_1.env.HOST ?? "0.0.0.0";
    const port = env_1.env.PORT ?? 8080;
    await app.listen({ host, port });
    app.log.info(`Server listening on http://${host}:${port}`);
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map