// src/routes/chat.ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import {
  encodeFunctionData,
  parseUnits,
  type Address,
  type Abi,
} from "viem";

import { openai } from "../lib/openai";
import { env } from "../lib/env";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

// ABI JSONs (from explorer)
import UranoTokenAbiJson from "../abi/UranoToken.json";
import StakingAbiJson from "../abi/Staking.json";
import UShareMarketAbiJson from "../abi/uShareMarket.json";
import UShareFactoryAbiJson from "../abi/uShareFactory.json";
import VestingAbiJson from "../abi/Vesting.json";
import GovernanceAbiJson from "../abi/Governance.json";

/* ----------------------------- ABI Loader ----------------------------- */

function extractAbi(json: unknown): Abi {
  const j = json as any;
  return (j?.abi ?? j) as Abi;
}

// Keep these in case you want to add approve() steps later.
// (Not all are used right now; they’re loaded to ensure ABI drift cannot happen.)
const uranoTokenAbi = extractAbi(UranoTokenAbiJson);
const stakingAbi = extractAbi(StakingAbiJson);
const uShareMarketAbi = extractAbi(UShareMarketAbiJson);
const uShareFactoryAbi = extractAbi(UShareFactoryAbiJson);
const vestingAbi = extractAbi(VestingAbiJson);
const governanceAbi = extractAbi(GovernanceAbiJson);

// Avoid TS “declared but never used” for the ones we’ll use later.
void uranoTokenAbi;
void uShareFactoryAbi;

/* ----------------------------- Schemas ----------------------------- */

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address")
  .transform((s) => s as Address);

const Bytes32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid bytes32")
  .transform((s) => s as `0x${string}`);

const UintStringSchema = z
  .string()
  .regex(/^\d+$/, "Expected an integer string");

const VestingDataSchema = z.object({
  beneficiary: AddressSchema,
  totalAmount: UintStringSchema, // MUST be uint256 string (wei)
  cliffInSeconds: UintStringSchema,
  vestingInSeconds: UintStringSchema,
  tgePercentage: UintStringSchema,
});

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

  // Optional context for smarter tx planning
  context: z
    .object({
      account: AddressSchema.optional(),

      // Merkle vesting claim tx generation
      vesting: z
        .object({
          data: VestingDataSchema,
          merkleProof: z.array(Bytes32Schema).max(64),
        })
        .optional(),
    })
    .optional(),
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
  "CLAIM_VESTING",
  "QUESTION",
  "UNSUPPORTED",
]);

const PlannedSchema = z.object({
  actionType: ActionTypeSchema,
  interpretation: z.string().min(1).max(300),
  userMessage: z.string().min(1).max(1200),

  amount: z.string().optional(), // human amount (e.g. "100.5") for stake/buy
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

  // preferred (multi-step capable)
  txs: TxPreview[];

  // backwards compatibility
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
  if (t.length <= 12 && /^(hi|hey|hello|gm|yo|salut|bonjour|salam|slm)\b/.test(t)) return true;
  if (/^(thanks|thank you|thx|ty)\b/.test(t)) return true;

  return false;
}

function helpMessage(): Planned {
  return {
    actionType: "QUESTION",
    interpretation: "Help / greeting",
    userMessage:
      "Hi. I can help you stake/unstake (amount or all), buy/sell uShare, vote on proposals, or claim vesting tokens. What would you like to do?",
    warnings: [],
  };
}

/* ----------------------------- Planner (OpenAI -> JSON) ----------------------------- */

async function planFromMessages(body: ChatBody): Promise<Planned> {
  const last = lastUserMessage(body);
  if (isSmallTalkOrHelp(last)) return helpMessage();

  const systemPrompt = `
You are uAssistant for the Urano DApp.

You MUST ONLY output JSON (no markdown, no prose outside JSON).

Return JSON with this exact shape:
{
  "actionType": "STAKE|UNSTAKE|STAKE_ALL|UNSTAKE_ALL|BUY_USHARE|SELL_USHARE|VOTE|CLAIM_VESTING|QUESTION|UNSUPPORTED",
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
  "I can't do that yet. I can help you stake/unstake, buy/sell uShare, vote, or claim vesting tokens."

Action extraction rules:
- STAKE / UNSTAKE: extract human amount into "amount". If missing, keep actionType and add warning.
- STAKE_ALL / UNSTAKE_ALL: no amount.
- BUY_USHARE: needs "assetName" and "amount". If missing, keep BUY_USHARE and add warnings.
- SELL_USHARE: needs "assetName". If missing, keep SELL_USHARE and add warnings.
- VOTE: needs proposalId and vote. If missing, keep VOTE and add warnings.
- CLAIM_VESTING: no params in JSON. (Backend needs Merkle proof + vesting data in request context to build tx.)

Keep interpretation concise. Keep userMessage under 1–3 short sentences.
`.trim();

  const model = env.OPENAI_MODEL ?? "gpt-4.1-mini";

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
      return helpMessage();
    }

    const parsed = PlannedSchema.safeParse(json);
    if (!parsed.success) return helpMessage();

    return parsed.data;
  } catch {
    return helpMessage();
  }
}

/* ----------------------------- TX Builder ----------------------------- */

function buildTxs(plan: Planned, body: ChatBody): { txs: TxPreview[]; warnings: string[] } {
  const warnings = [...(plan.warnings ?? [])];

  const chainId = Number(env.CHAIN_ID ?? 421614);

  // Keep URANO decimals configurable without requiring env schema changes.
  const uranoDecimals = Number((process.env.URANO_DECIMALS ?? "18").trim());

  const STAKING = asAddress(env.URANO_STAKING, "URANO_STAKING");
  const GOV = asAddress(env.URANO_GOVERNANCE, "URANO_GOVERNANCE");
  const MARKET = asAddress(env.USHARE_MARKET, "USHARE_MARKET");
  const VESTING = asAddress(env.VESTING_ADDRESS, "VESTING_ADDRESS");

  const value = 0n;

  switch (plan.actionType) {
    case "STAKE": {
      if (!plan.amount) return { txs: [], warnings: [...warnings, "Missing amount."] };
      const amt = parseUnits(normalizeAmountString(plan.amount), uranoDecimals);

      const data = encodeFunctionData({
        abi: stakingAbi,
        functionName: "stake",
        args: [amt],
      });

      return { txs: [{ chainId, to: STAKING, data, value: value.toString() }], warnings };
    }

    case "UNSTAKE": {
      if (!plan.amount) return { txs: [], warnings: [...warnings, "Missing amount."] };
      const amt = parseUnits(normalizeAmountString(plan.amount), uranoDecimals);

      const data = encodeFunctionData({
        abi: stakingAbi,
        functionName: "unstake",
        args: [amt],
      });

      return { txs: [{ chainId, to: STAKING, data, value: value.toString() }], warnings };
    }

    case "STAKE_ALL": {
      const data = encodeFunctionData({
        abi: stakingAbi,
        functionName: "stakeAll",
        args: [],
      });

      return { txs: [{ chainId, to: STAKING, data, value: value.toString() }], warnings };
    }

    case "UNSTAKE_ALL": {
      const data = encodeFunctionData({
        abi: stakingAbi,
        functionName: "unstakeAll",
        args: [],
      });

      return { txs: [{ chainId, to: STAKING, data, value: value.toString() }], warnings };
    }

    case "VOTE": {
      if (typeof plan.proposalId !== "number" || typeof plan.vote !== "boolean") {
        return { txs: [], warnings: [...warnings, "Missing proposalId or vote choice."] };
      }

      const data = encodeFunctionData({
        abi: governanceAbi,
        functionName: "vote",
        args: [BigInt(plan.proposalId), plan.vote],
      });

      return { txs: [{ chainId, to: GOV, data, value: value.toString() }], warnings };
    }

    case "BUY_USHARE": {
      if (!plan.assetName || !plan.amount) {
        return { txs: [], warnings: [...warnings, "Missing uShare name or amount."] };
      }

      warnings.push("Buying may require token approval before this tx can succeed.");

      // If your uShare token uses a different decimals value, adjust later.
      const amt = parseUnits(normalizeAmountString(plan.amount), 18);

      const data = encodeFunctionData({
        abi: uShareMarketAbi,
        functionName: "buyUshare",
        args: [plan.assetName, amt],
      });

      return { txs: [{ chainId, to: MARKET, data, value: value.toString() }], warnings };
    }

    case "SELL_USHARE": {
      if (!plan.assetName) return { txs: [], warnings: [...warnings, "Missing uShare name."] };

      const data = encodeFunctionData({
        abi: uShareMarketAbi,
        functionName: "sellUshare",
        args: [plan.assetName],
      });

      return { txs: [{ chainId, to: MARKET, data, value: value.toString() }], warnings };
    }

    case "CLAIM_VESTING": {
      const account = body.context?.account;
      const vest = body.context?.vesting;

      if (!account) {
        return { txs: [], warnings: [...warnings, "To claim vesting, I need your connected account (context.account)."] };
      }

      if (!vest) {
        return {
          txs: [],
          warnings: [
            ...warnings,
            "To claim vesting, I need your vesting record + Merkle proof (context.vesting).",
          ],
        };
      }

      if (account.toLowerCase() !== vest.data.beneficiary.toLowerCase()) {
        return {
          txs: [],
          warnings: [
            ...warnings,
            "Vesting claim blocked: connected account does not match the vesting beneficiary.",
          ],
        };
      }

      const dataTuple = {
        beneficiary: vest.data.beneficiary,
        totalAmount: BigInt(vest.data.totalAmount),
        cliffInSeconds: BigInt(vest.data.cliffInSeconds),
        vestingInSeconds: BigInt(vest.data.vestingInSeconds),
        tgePercentage: BigInt(vest.data.tgePercentage),
      };

      const data = encodeFunctionData({
        abi: vestingAbi,
        functionName: "claim",
        args: [dataTuple, vest.merkleProof],
      });

      return { txs: [{ chainId, to: VESTING, data, value: value.toString() }], warnings };
    }

    case "QUESTION":
    case "UNSUPPORTED":
    default:
      return { txs: [], warnings };
  }
}

function makeOut(plan: Planned, txs: TxPreview[], warnings: string[]): AssistantPlan {
  const id = crypto.randomUUID();

  // Keep these optional without requiring env schema changes:
  const fallbackDocsUrl = process.env.DOCS_URL || undefined;
  const fallbackSupportEmail = process.env.SUPPORT_EMAIL || undefined;

  const docsUrl = plan.docsUrl ?? fallbackDocsUrl;
  const supportEmail = plan.supportEmail ?? fallbackSupportEmail;

  const tx: TxPreview | null = txs.length > 0 ? txs[0]! : null;

  const base: Omit<AssistantPlan, "docsUrl" | "supportEmail"> = {
    id,
    actionType: plan.actionType,
    interpretation: plan.interpretation,
    userMessage: plan.userMessage,
    warnings,
    txs,
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

    let txs: TxPreview[] = [];
    let warnings = [...(plan.warnings ?? [])];

    try {
      const built = buildTxs(plan, parsed.data);
      txs = built.txs;
      warnings = built.warnings;
    } catch (e: unknown) {
      warnings = [...warnings, e instanceof Error ? e.message : "TX_BUILD_FAILED"];
      txs = [];
    }

    const out = makeOut(plan, txs, warnings);
    return reply.send(out);
  });

  // Stream (SSE): emits ready -> plan -> done
  app.post("/stream", async (req, reply) => {
    const parsed = ChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", issues: parsed.error.issues });
    }

    const origin = req.headers.origin;

    // Support both your new env key and your older env file key.
    const allowListStr = env.CORS_ORIGIN ?? process.env.CORS_ORIGINS ?? "";
    const allowList = allowListStr
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

      let txs: TxPreview[] = [];
      let warnings = [...(plan.warnings ?? [])];

      try {
        const built = buildTxs(plan, parsed.data);
        txs = built.txs;
        warnings = built.warnings;
      } catch (e: unknown) {
        warnings = [...warnings, e instanceof Error ? e.message : "TX_BUILD_FAILED"];
        txs = [];
      }

      const out = makeOut(plan, txs, warnings);

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
