import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { openai } from "../lib/openai";
import { env } from "../lib/env";

const ChatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      })
    )
    .min(1)
    .max(50),
});

type ChatBody = z.infer<typeof ChatBodySchema>;

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.post("/", async (req, reply) => {
    const parsed = ChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "BAD_REQUEST",
        issues: parsed.error.issues,
      });
    }

    const body: ChatBody = parsed.data;

    const systemPrompt =
      env.SYSTEM_PROMPT ??
      "You are Urano UAssistant. Be concise, helpful, and technical when needed.";

    const model = env.OPENAI_MODEL ?? "gpt-4o-mini";

    const completion = await openai.chat.completions.create({
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
