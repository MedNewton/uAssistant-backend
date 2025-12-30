import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";

import { openai } from "../lib/openai";
import { env } from "../lib/env";

// Import the streaming body type so TS picks the correct overload
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";

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

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const chatRoutes: FastifyPluginAsync = async (app) => {
  // Non-stream
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
      messages: [{ role: "system", content: systemPrompt }, ...body.messages],
    });

    const text = completion.choices[0]?.message?.content ?? "";

    return reply.send({
      message: text,
      usage: completion.usage ?? null,
    });
  });

  // Stream (SSE)
  app.post("/stream", async (req, reply) => {
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

    // ✅ Add CORS headers to the actual SSE response (because we hijack reply.raw)
const origin = req.headers.origin;

const allowList = (env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (typeof origin === "string" && allowList.includes(origin)) {
  reply.raw.setHeader("Access-Control-Allow-Origin", origin);
  reply.raw.setHeader("Vary", "Origin");
  reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
}


    // Take over the raw response so Fastify doesn't auto-close it
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    if (typeof reply.raw.flushHeaders === "function") reply.raw.flushHeaders();
    reply.hijack();

    const id = crypto.randomUUID();
    reply.raw.write(sseEvent("ready", { ok: true, id }));

    const keepAlive = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`);
      } catch {
        // ignore
      }
    }, 15000);

    const abort = new AbortController();

    const cleanup = (): void => {
      clearInterval(keepAlive);
      try {
        reply.raw.end();
      } catch {
        // ignore
      }
    };

    const onClose = (): void => {
      abort.abort();
      cleanup();
    };

    reply.raw.on("close", onClose);
    reply.raw.on("error", onClose);

    try {
      // IMPORTANT:
      // 1) Build a streaming-typed body (stream: true literal)
      // 2) Pass { signal } as the SECOND ARG, not inside the body
      const reqBody: ChatCompletionCreateParamsStreaming = {
        model,
        temperature: 0.4,
        stream: true,
        messages: [{ role: "system", content: systemPrompt }, ...body.messages],
      };

      const stream = await openai.chat.completions.create(reqBody, {
        signal: abort.signal,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) reply.raw.write(sseEvent("delta", { delta }));
      }

      reply.raw.write(sseEvent("done", { ok: true }));
      cleanup();
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        const message = err instanceof Error ? err.message : "Unknown error";
        reply.raw.write(sseEvent("error", { error: "STREAM_FAILED", message }));
      }
      cleanup();
    } finally {
      reply.raw.off("close", onClose);
      reply.raw.off("error", onClose);
    }
  });
};
