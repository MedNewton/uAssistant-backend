"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const env_js_1 = require("./lib/env.js");
function buildServer() {
    const app = (0, fastify_1.default)({
        logger: true,
        trustProxy: true,
    });
    app.register(cors_1.default, {
        origin: env_js_1.env.CORS_ORIGIN ?? true,
        credentials: true,
    });
    app.get("/health", async () => {
        return { ok: true };
    });
    return app;
}
async function main() {
    const app = buildServer();
    const port = env_js_1.env.PORT ?? 3001;
    const host = env_js_1.env.HOST ?? "0.0.0.0";
    await app.listen({ port, host });
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map