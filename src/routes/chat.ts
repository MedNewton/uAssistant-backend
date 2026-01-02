// src/routes/chat.ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { encodeFunctionData, parseUnits, type Address } from "viem";

import { openai } from "../lib/openai";
import { env } from "../lib/env";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

/* ----------------------------- Schemas ----------------------------- */

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

const ActionTypeSchema = z.enum([
  "STAKE",
  "UNSTAKE",
  "STAKE_ALL",
  "UNSTAKE_ALL",
  "BUY_USHARE",
  "SELL_USHARE",
  "VOTE",
  "CLAIM_UNLOCKED",
  "QUESTION",
  "UNSUPPORTED",
]);

const PlannedSchema = z.object({
  actionType: ActionTypeSchema,
  interpretation: z.string().min(1).max(300),
  userMessage: z.string().min(1).max(1200),

  amount: z.string().optional(),
  assetName: z.string().optional(),
  proposalId: z.number().int().nonnegative().optional(),
  vote: z.boolean().optional(),

  warnings: z.array(z.string().min(1).max(200)).optional(),
  docsUrl: z.string().url().optional(),
  supportEmail: z.string().email().optional(),
});

type Planned = z.infer<typeof PlannedSchema>;

type TxPreview = Readonly<{
  chainId: number;
  to: Address;
  data: `0x${string}`;
  value: string; // bigint string
}>;

type AssistantPlan = Readonly<{
  id: string;
  actionType: z.infer<typeof ActionTypeSchema>;
  interpretation: string;
  userMessage: string;
  warnings: string[];
  tx: TxPreview | null;
  docsUrl?: string;
  supportEmail?: string;
}>;

/* ----------------------------- Helpers ----------------------------- */

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function normalizeAmountString(input: string): string {
  return input.trim().replace(/,/g, "");
}

function asAddress(v: string | undefined, name: string): Address {
  const s = (v ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(s)) {
    throw new Error(`Missing/invalid ${name} address env var`);
  }
  return s as Address;
}

function lastUserMessage(body: ChatBody): string {
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const m = body.messages[i];
    if (m?.role === "user") return m.content.trim();
  }
  return body.messages[body.messages.length - 1]?.content?.trim() ?? "";
}

function isSmallTalkOrHelp(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;

  // quick small-talk buckets
  const exact = new Set([
    "hi",
    "hello",
    "hey",
    "yo",
    "gm",
    "good morning",
    "good afternoon",
    "good evening",
    "thanks",
    "thank you",
    "thx",
    "ty",
    "salut",
    "bonjour",
    "salam",
    "slm",
    "help",
    "what can you do",
    "who are you",
  ]);

  if (exact.has(t)) return true;

  // short greeting-like messages
  if (t.length <= 12 && /^(hi|hey|hello|gm|yo|salut|bonjour|salam|slm)\b/.test(t)) return true;
  if (/^(thanks|thank you|thx|ty)\b/.test(t)) return true;

  return false;
}

function helpMessage(): Planned {
  return {
    actionType: "QUESTION",
    interpretation: "Help / greeting",
    userMessage:
      "Hi. I can help you stake/unstake (amount or all), buy/sell uShare, vote on proposals, or claim unlocked tokens. What would you like to do?",
    warnings: [],
  };
}

/* ----------------------------- Minimal ABIs ----------------------------- */

const stakingAbi = [
  {
    type: "function",
    name: "stake",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "unstake",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "stakeAll",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "unstakeAll",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

const governanceAbi = [
  {
    type: "function",
    name: "vote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "support", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const uShareMarketAbi = [
  {
    type: "function",
    name: "buyUshare",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sellUshare",
    stateMutability: "nonpayable",
    inputs: [{ name: "name", type: "string" }],
    outputs: [],
  },
] as const;

const vestingAbi = [
  {
    type: "function",
    name: "claimUnlocked",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

/* ----------------------------- Planner (OpenAI -> JSON) ----------------------------- */

async function planFromMessages(body: ChatBody): Promise<Planned> {
  // HARD GUARANTEE: greetings/small-talk never go through the model
  const last = lastUserMessage(body);
  if (isSmallTalkOrHelp(last)) return helpMessage();

  const systemPrompt = `
You are uAssistant for the Urano DApp.

You MUST ONLY output JSON (no markdown, no prose outside JSON).

Return JSON with this exact shape:
{
  "actionType": "STAKE|UNSTAKE|STAKE_ALL|UNSTAKE_ALL|BUY_USHARE|SELL_USHARE|VOTE|CLAIM_UNLOCKED|QUESTION|UNSUPPORTED",
  "interpretation": "short interpretation",
  "userMessage": "short user-facing message (what will happen or the answer)",
  "amount": "string like 100.5 (only when needed)",
  "assetName": "string (only for BUY_USHARE/SELL_USHARE)",
  "proposalId": 123 (only for VOTE),
  "vote": true/false (only for VOTE),
  "warnings": ["..."] (optional),
  "docsUrl": "https://..." (optional),
  "supportEmail": "email@..." (optional)
}

Core rules:
- Greetings / small talk MUST be actionType="QUESTION".
- General informational questions MUST be actionType="QUESTION" with a helpful answer.
- Use actionType="UNSUPPORTED" ONLY when the user requests an action outside the supported set.
  For UNSUPPORTED, userMessage must be:
  "I can't do that yet. I can help you stake/unstake, buy/sell uShare, vote, or claim unlocked tokens."

Action extraction rules:
- STAKE / UNSTAKE: extract human amount (not wei) into "amount". If missing, keep actionType and add warning.
- STAKE_ALL / UNSTAKE_ALL: no amount.
- BUY_USHARE: needs "assetName" and "amount". If missing, keep BUY_USHARE and add warnings.
- SELL_USHARE: needs "assetName". If missing, keep SELL_USHARE and add warnings.
- VOTE: needs proposalId and vote. If missing, keep VOTE and add warnings.
- CLAIM_UNLOCKED: no params.

Keep interpretation concise. Keep userMessage under 1–3 short sentences.
`.trim();

  const model = env.OPENAI_MODEL ?? "gpt-4o-mini";

  const reqBody: ChatCompletionCreateParamsNonStreaming = {
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: systemPrompt }, ...body.messages],
  };

  try {
    const completion = await openai.chat.completions.create(reqBody);
    const raw = completion.choices?.[0]?.message?.content ?? "{}";

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // NEVER return "Command not yet available" for parse issues
      return helpMessage();
    }

    const parsed = PlannedSchema.safeParse(json);
    if (!parsed.success) {
      // NEVER return "Command not yet available" for schema issues
      return helpMessage();
    }

    return parsed.data;
  } catch {
    // Network/API errors: still return helpful QUESTION message
    return helpMessage();
  }
}

/* ----------------------------- TX Builder ----------------------------- */

function buildTx(plan: Planned): { tx: TxPreview | null; warnings: string[] } {
  const warnings = [...(plan.warnings ?? [])];

  const chainId = Number((process.env.CHAIN_ID ?? "84532").trim()); // Base Sepolia default
  const uranoDecimals = Number((process.env.URANO_DECIMALS ?? "18").trim());

  const STAKING = asAddress(process.env.URANO_STAKING, "URANO_STAKING");
  const GOV = asAddress(process.env.URANO_GOVERNANCE, "URANO_GOVERNANCE");
  const MARKET = asAddress(process.env.USHARE_MARKET, "USHARE_MARKET");
  const VESTING = asAddress(process.env.VESTING_ADDRESS, "VESTING_ADDRESS");

  const value = 0n;

  switch (plan.actionType) {
    case "STAKE": {
      if (!plan.amount) return { tx: null, warnings: [...warnings, "Missing amount."] };
      const amt = parseUnits(normalizeAmountString(plan.amount), uranoDecimals);
      const data = encodeFunctionData({ abi: stakingAbi, functionName: "stake", args: [amt] });
      return { tx: { chainId, to: STAKING, data, value: value.toString() }, warnings };
    }
    case "UNSTAKE": {
      if (!plan.amount) return { tx: null, warnings: [...warnings, "Missing amount."] };
      const amt = parseUnits(normalizeAmountString(plan.amount), uranoDecimals);
      const data = encodeFunctionData({ abi: stakingAbi, functionName: "unstake", args: [amt] });
      return { tx: { chainId, to: STAKING, data, value: value.toString() }, warnings };
    }
    case "STAKE_ALL": {
      const data = encodeFunctionData({ abi: stakingAbi, functionName: "stakeAll" });
      return { tx: { chainId, to: STAKING, data, value: value.toString() }, warnings };
    }
    case "UNSTAKE_ALL": {
      const data = encodeFunctionData({ abi: stakingAbi, functionName: "unstakeAll" });
      return { tx: { chainId, to: STAKING, data, value: value.toString() }, warnings };
    }
    case "VOTE": {
      if (typeof plan.proposalId !== "number" || typeof plan.vote !== "boolean") {
        return { tx: null, warnings: [...warnings, "Missing proposalId or vote choice."] };
      }
      const data = encodeFunctionData({
        abi: governanceAbi,
        functionName: "vote",
        args: [BigInt(plan.proposalId), plan.vote],
      });
      return { tx: { chainId, to: GOV, data, value: value.toString() }, warnings };
    }
    case "BUY_USHARE": {
      if (!plan.assetName || !plan.amount) {
        return { tx: null, warnings: [...warnings, "Missing uShare name or amount."] };
      }
      warnings.push("Buying may require prior token approval before this tx can succeed.");
      const amt = parseUnits(normalizeAmountString(plan.amount), 18);
      const data = encodeFunctionData({
        abi: uShareMarketAbi,
        functionName: "buyUshare",
        args: [plan.assetName, amt],
      });
      return { tx: { chainId, to: MARKET, data, value: value.toString() }, warnings };
    }
    case "SELL_USHARE": {
      if (!plan.assetName) return { tx: null, warnings: [...warnings, "Missing uShare name."] };
      const data = encodeFunctionData({
        abi: uShareMarketAbi,
        functionName: "sellUshare",
        args: [plan.assetName],
      });
      return { tx: { chainId, to: MARKET, data, value: value.toString() }, warnings };
    }
    case "CLAIM_UNLOCKED": {
      const data = encodeFunctionData({ abi: vestingAbi, functionName: "claimUnlocked" });
      return { tx: { chainId, to: VESTING, data, value: value.toString() }, warnings };
    }
    case "QUESTION":
    case "UNSUPPORTED":
    default:
      return { tx: null, warnings };
  }
}

function makeOut(plan: Planned, tx: TxPreview | null, warnings: string[]): AssistantPlan {
  const id = crypto.randomUUID();
  const docsUrl = plan.docsUrl ?? (process.env.DOCS_URL || undefined);
  const supportEmail = plan.supportEmail ?? (process.env.SUPPORT_EMAIL || undefined);

  const base: Omit<AssistantPlan, "docsUrl" | "supportEmail"> = {
    id,
    actionType: plan.actionType,
    interpretation: plan.interpretation,
    userMessage: plan.userMessage,
    warnings,
    tx,
  };

  return {
    ...base,
    ...(docsUrl ? { docsUrl } : {}),
    ...(supportEmail ? { supportEmail } : {}),
  };
}

/* ----------------------------- Routes ----------------------------- */

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.post("/", async (req, reply) => {
    const parsed = ChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", issues: parsed.error.issues });
    }

    const plan = await planFromMessages(parsed.data);

    let tx: TxPreview | null = null;
    let warnings = [...(plan.warnings ?? [])];

    try {
      const built = buildTx(plan);
      tx = built.tx;
      warnings = built.warnings;
    } catch (e: unknown) {
      warnings = [...warnings, e instanceof Error ? e.message : "TX_BUILD_FAILED"];
      tx = null;
    }

    const out = makeOut(plan, tx, warnings);
    return reply.send(out);
  });

  // Stream (SSE): emits ready -> plan -> done
  app.post("/stream", async (req, reply) => {
    const parsed = ChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", issues: parsed.error.issues });
    }

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

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    if (typeof reply.raw.flushHeaders === "function") reply.raw.flushHeaders();
    reply.hijack();

    const reqId = crypto.randomUUID();

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
      reply.raw.write(sseEvent("ready", { ok: true, id: reqId }));

      const plan = await planFromMessages(parsed.data);

      let tx: TxPreview | null = null;
      let warnings = [...(plan.warnings ?? [])];

      try {
        const built = buildTx(plan);
        tx = built.tx;
        warnings = built.warnings;
      } catch (e: unknown) {
        warnings = [...warnings, e instanceof Error ? e.message : "TX_BUILD_FAILED"];
        tx = null;
      }

      const out = makeOut(plan, tx, warnings);

      // Single source of truth for UI:
      reply.raw.write(sseEvent("plan", out));

      reply.raw.write(sseEvent("done", { ok: true }));
      cleanup();
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        const message = err instanceof Error ? err.message : "Unknown error";
        try {
          reply.raw.write(sseEvent("error", { error: "STREAM_FAILED", message }));
        } catch {
          // ignore
        }
      }
      cleanup();
    } finally {
      reply.raw.off("close", onClose);
      reply.raw.off("error", onClose);
    }
  });
};
