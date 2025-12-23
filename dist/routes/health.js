"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRoutes = void 0;
const healthRoutes = async (app) => {
    app.get("/", async () => {
        return {
            ok: true,
            service: "urano-uassistant-backend",
            ts: Date.now(),
        };
    });
};
exports.healthRoutes = healthRoutes;
//# sourceMappingURL=health.js.map