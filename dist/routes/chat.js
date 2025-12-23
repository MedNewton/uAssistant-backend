"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatRoutes = void 0;
const zod_1 = require("zod");
const openai_1 = require("../lib/openai");
const env_1 = require("../lib/env");
const ChatBodySchema = zod_1.z.object({
    messages: zod_1.z
        .array(zod_1.z.object({
        role: zod_1.z.enum(["user", "assistant"]),
        content: zod_1.z.string().min(1).max(8000),
    }))
        .min(1)
        .max(50),
});
const chatRoutes = async (app) => {
    app.post("/", async (req, reply) => {
        const parsed = ChatBodySchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "BAD_REQUEST",
                issues: parsed.error.issues,
            });
        }
        const body = parsed.data;
        const systemPrompt = env_1.env.SYSTEM_PROMPT ??
            "You are Urano UAssistant. Be concise, helpful, and technical when needed.";
        const model = env_1.env.OPENAI_MODEL ?? "gpt-4o-mini";
        const completion = await openai_1.openai.chat.completions.create({
            model,
            temperature: 0.4,
            messages: [
                { role: "system", content: systemPrompt },
                ...body.messages,
            ],
        });
        const text = completion.choices[0]?.message?.content ?? "";
        return reply.send({
            message: text,
            usage: completion.usage ?? null,
        });
    });
};
exports.chatRoutes = chatRoutes;
//# sourceMappingURL=chat.js.map