// src/routes/chat.ts
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { encodeFunctionData, parseUnits, type Address, type Abi } from "viem";

import { openai } from "../lib/openai";
import { env } from "../lib/env";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

import {
  getUShareOfferings,
  resolveUShareSelectionFromText,
  type UShareOffering,
} from "../config/uShareOfferings";

// ABI JSONs (from explorer)
import UranoTokenAbiJson from "../abi/UranoToken.json";
import StakingAbiJson from "../abi/Staking.json";
import UShareMarketAbiJson from "../abi/uShareMarket.json";
import UShareFactoryAbiJson from "../abi/uShareFactory.json";
import VestingAbiJson from "../abi/Vesting.json";
import GovernanceAbiJson from "../abi/Governance.json";

/* ----------------------------- Env helpers (no env.ts changes required) ----------------------------- */

type EnvExtras = Readonly<{
  URANO_DECIMALS?: number | string;
  USHARE_DECIMALS?: number | string;
  DOCS_URL?: string;
  SUPPORT_EMAIL?: string;
  SYSTEM_PROMPT?: string;
  OPENAI_MAX_OUTPUT_TOKENS?: number | string;
}>;

function getEnvExtras(): EnvExtras {
  const e = env as unknown as Partial<Record<keyof EnvExtras, unknown>>;

  const uranoDecimals = (e.URANO_DECIMALS ?? process.env.URANO_DECIMALS) as
    | string
    | number
    | undefined;

  const uShareDecimals = (e.USHARE_DECIMALS ?? process.env.USHARE_DECIMALS) as
    | string
    | number
    | undefined;

  const docsUrl = (e.DOCS_URL ?? process.env.DOCS_URL) as string | undefined;
  const supportEmail = (e.SUPPORT_EMAIL ?? process.env.SUPPORT_EMAIL) as string | undefined;

  const systemPrompt = (e.SYSTEM_PROMPT ?? process.env.SYSTEM_PROMPT) as string | undefined;

  const maxOutputTokens = (e.OPENAI_MAX_OUTPUT_TOKENS ?? process.env.OPENAI_MAX_OUTPUT_TOKENS) as
    | string
    | number
    | undefined;

  // exactOptionalPropertyTypes-safe: only set when real values exist.
  const out: {
    URANO_DECIMALS?: string | number;
    USHARE_DECIMALS?: string | number;
    DOCS_URL?: string;
    SUPPORT_EMAIL?: string;
    SYSTEM_PROMPT?: string;
    OPENAI_MAX_OUTPUT_TOKENS?: string | number;
  } = {};

  if (uranoDecimals !== undefined) out.URANO_DECIMALS = uranoDecimals;
  if (uShareDecimals !== undefined) out.USHARE_DECIMALS = uShareDecimals;

  if (docsUrl && docsUrl.trim() !== "") out.DOCS_URL = docsUrl;
  if (supportEmail && supportEmail.trim() !== "") out.SUPPORT_EMAIL = supportEmail;

  if (systemPrompt && systemPrompt.trim() !== "") out.SYSTEM_PROMPT = systemPrompt;

  if (maxOutputTokens !== undefined) out.OPENAI_MAX_OUTPUT_TOKENS = maxOutputTokens;

  return out;
}

function toPositiveInt(v: unknown, fallback: number): number {
  const n =
    typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;

  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/* ----------------------------- ABI Loader ----------------------------- */

function extractAbi(json: unknown): Abi {
  const j = json as any;
  return (j?.abi ?? j) as Abi;
}

const uranoTokenAbi = extractAbi(UranoTokenAbiJson);
const stakingAbi = extractAbi(StakingAbiJson);
const uShareMarketAbi = extractAbi(UShareMarketAbiJson);
const uShareFactoryAbi = extractAbi(UShareFactoryAbiJson);
const vestingAbi = extractAbi(VestingAbiJson);
const governanceAbi = extractAbi(GovernanceAbiJson);

// Keep these voids to avoid “declared but never used” when ABIs are imported for completeness.
void uranoTokenAbi;
void uShareFactoryAbi;

/**
 * ERC20 approve fragment (used for USDC approvals).
 */
const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const MAX_UINT256 = (1n << 256n) - 1n;

/* ----------------------------- Schemas ----------------------------- */

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address")
  .transform((s) => s as Address);

const Bytes32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid bytes32")
  .transform((s) => s as `0x${string}`);

const UintStringSchema = z.string().regex(/^\d+$/, "Expected an integer string");

const VestingDataSchema = z.object({
  beneficiary: AddressSchema,
  totalAmount: UintStringSchema,
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

  context: z
    .object({
      account: AddressSchema.optional(),
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

  amount: z.string().optional(),
  uShareId: Bytes32Schema.optional(),

  proposalId: z.number().int().nonnegative().optional(),
  vote: z.boolean().optional(),

  warnings: z.array(z.string().min(1).max(300)).optional(),
  docsUrl: z.string().url().optional(),
  supportEmail: z.string().email().optional(),
});

type Planned = z.infer<typeof PlannedSchema>;

type TxPreview = Readonly<{
  chainId: number;
  to: Address;
  data: `0x${string}`;
  value: string;
}>;

type AssistantPlan = Readonly<{
  id: string;
  actionType: z.infer<typeof ActionTypeSchema>;
  interpretation: string;
  userMessage: string;
  warnings: string[];
  txs: TxPreview[];
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
      "Hi. I can help you stake/unstake (amount or all), buy uShare (mention symbol or paste uShareId), vote on proposals, or claim vesting tokens. What would you like to do?",
    warnings: [],
  };
}

function extractFirstNumber(text: string): string | null {
  const m = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  return m[1]!.replace(",", ".");
}

function formatOfferingsForPrompt(offerings: readonly UShareOffering[]): string {
  if (offerings.length === 0) return "No uShares configured on backend.";
  return offerings.map((o) => `${o.name} (${o.symbol}): ${o.uShareId}`).join(" | ");
}

/**
 * Post-process the LLM plan so the UX is robust even if the model omits fields.
 */
function coercePlanFromUserText(
  plan: Planned,
  last: string,
  offerings: readonly UShareOffering[]
): Planned {
  let out = plan;
  const w = [...(out.warnings ?? [])];

  const needsAmount =
    out.actionType === "BUY_USHARE" || out.actionType === "STAKE" || out.actionType === "UNSTAKE";

  if (needsAmount && (!out.amount || out.amount.trim() === "")) {
    const inferred = extractFirstNumber(last);
    if (inferred) out = { ...out, amount: inferred };
    else w.push("Missing amount. Example: 'buy 100 uShares' or 'stake 250'.");
  }

  // SELL is not supported
  if (out.actionType === "SELL_USHARE") {
    out = {
      ...out,
      actionType: "UNSUPPORTED",
      interpretation: "Sell uShare is not supported by this contract",
      userMessage:
        "I can't do that yet. I can help you stake/unstake, buy uShare, vote, or claim vesting tokens.",
    };
  }

  // BUY_USHARE requires uShareId; resolve from offerings when possible
  if (out.actionType === "BUY_USHARE" && !out.uShareId) {
    const sel = resolveUShareSelectionFromText(offerings, last);

    if (sel.id) {
      out = { ...out, uShareId: sel.id };
    } else {
      const list = formatOfferingsForPrompt(offerings);
      out = {
        ...out,
        interpretation:
          out.interpretation || "User wants to buy uShares but did not specify which uShareId",
        userMessage:
          offerings.length > 0
            ? `Which uShare do you want to buy? Paste the uShareId (bytes32) or mention the symbol. Available: ${list}`
            : "Please paste the uShareId (bytes32) of the uShare you want to buy (0x + 64 hex chars).",
      };
      w.push("Missing uShareId (bytes32). Paste it like: 0x<64 hex chars>.");
    }
  }

  if (w.length > 0) out = { ...out, warnings: w };
  return out;
}

/* ----------------------------- Planner (OpenAI -> JSON) ----------------------------- */

async function planFromMessages(
  body: ChatBody,
  offerings: readonly UShareOffering[]
): Promise<Planned> {
  const last = lastUserMessage(body);
  if (isSmallTalkOrHelp(last)) return helpMessage();

  const extras = getEnvExtras();

  const offeringsHint =
    offerings.length > 0
      ? `Known uShares (name/symbol/uShareId): ${formatOfferingsForPrompt(offerings)}`
      : "No uShares are configured on backend.";

  const baseSystemPrompt = `
You are uAssistant for the Urano DApp.

You MUST ONLY output JSON (no markdown, no prose outside JSON).

Return JSON with this exact shape:
{
  "actionType": "STAKE|UNSTAKE|STAKE_ALL|UNSTAKE_ALL|BUY_USHARE|SELL_USHARE|VOTE|CLAIM_VESTING|QUESTION|UNSUPPORTED",
  "interpretation": "short interpretation",
  "userMessage": "short user-facing message (what will happen or the answer)",
  "amount": "string like 100.5 (only when needed)",
  "uShareId": "0x... (bytes32) only for BUY_USHARE when user provides it",
  "proposalId": 123 (only for VOTE),
  "vote": true/false (only for VOTE),
  "warnings": ["..."] (optional),
  "docsUrl": "https://..." (optional),
  "supportEmail": "email@..." (optional)
}

Context:
- ${offeringsHint}

Core rules:
- Greetings / small talk MUST be actionType="QUESTION".
- General informational questions MUST be actionType="QUESTION" with a helpful answer.
- Use actionType="UNSUPPORTED" ONLY when the user requests an action outside the supported set.
  For UNSUPPORTED, userMessage must be:
  "I can't do that yet. I can help you stake/unstake, buy uShare, vote, or claim vesting tokens."

Action extraction rules:
- STAKE / UNSTAKE: extract human amount into "amount". If missing, keep actionType and add warning.
- STAKE_ALL / UNSTAKE_ALL: no amount.
- BUY_USHARE: requires "amount". If the user provides a bytes32 in the message, include it as "uShareId".
  If not provided, DO NOT invent it.
- SELL_USHARE: if asked, mark UNSUPPORTED (this market ABI has no sell function).
- VOTE: needs proposalId and vote. If missing, keep VOTE and add warnings.
- CLAIM_VESTING: no params in JSON.

Keep interpretation concise. Keep userMessage under 1–3 short sentences.
`.trim();

  const systemPrompt =
    (extras.SYSTEM_PROMPT && extras.SYSTEM_PROMPT.trim() !== "")
      ? `${extras.SYSTEM_PROMPT.trim()}\n\n---\n\n${baseSystemPrompt}`
      : baseSystemPrompt;

  const model = env.OPENAI_MODEL ?? "gpt-4.1-mini";

  const maxTokens = toPositiveInt(extras.OPENAI_MAX_OUTPUT_TOKENS, 0);

  const reqBody: ChatCompletionCreateParamsNonStreaming = {
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: systemPrompt }, ...body.messages],
    ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
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

    return coercePlanFromUserText(parsed.data, last, offerings);
  } catch {
    return helpMessage();
  }
}

/* ----------------------------- TX Builder ----------------------------- */

function buildTxs(
  plan: Planned,
  body: ChatBody,
  offerings: readonly UShareOffering[]
): { txs: TxPreview[]; warnings: string[] } {
  const warnings = [...(plan.warnings ?? [])];
  const extras = getEnvExtras();

  const chainId = Number(env.CHAIN_ID);
  const uranoDecimals = toPositiveInt(extras.URANO_DECIMALS, 18);
  const defaultUShareDecimals = toPositiveInt(extras.USHARE_DECIMALS, 18);

  const STAKING = asAddress(env.URANO_STAKING, "URANO_STAKING");
  const GOV = asAddress(env.URANO_GOVERNANCE, "URANO_GOVERNANCE");
  const MARKET = asAddress(env.USHARE_MARKET, "USHARE_MARKET");
  const VESTING = asAddress(env.VESTING_ADDRESS, "VESTING_ADDRESS");
  const USDC = asAddress(env.USDC, "USDC");

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
      if (!plan.amount) {
        return { txs: [], warnings: [...warnings, "Missing amount."] };
      }

      const uShareId = plan.uShareId;
      if (!uShareId) {
        return {
          txs: [],
          warnings: [...warnings, "Missing uShareId (bytes32)."],
        };
      }

      const found = offerings.find((o) => o.uShareId.toLowerCase() === uShareId.toLowerCase());
      const decimals = typeof found?.decimals === "number" ? found.decimals : defaultUShareDecimals;

      const amt = parseUnits(normalizeAmountString(plan.amount), decimals);

      // Tx1: Approve USDC spending for market
      const approveData = encodeFunctionData({
        abi: erc20ApproveAbi,
        functionName: "approve",
        args: [MARKET, MAX_UINT256],
      });

      // Tx2: Buy
      const buyData = encodeFunctionData({
        abi: uShareMarketAbi,
        functionName: "buyuShare",
        args: [uShareId, amt],
      });

      warnings.push(
        "This action returns 2 transactions: (1) USDC approval to the market, then (2) buy. If you already approved USDC for this market, you can skip tx #1."
      );

      if (found) warnings.push(`Selected uShare: ${found.name} (${found.symbol}).`);

      return {
        txs: [
          { chainId, to: USDC, data: approveData, value: value.toString() },
          { chainId, to: MARKET, data: buyData, value: value.toString() },
        ],
        warnings,
      };
    }

    case "CLAIM_VESTING": {
      const account = body.context?.account;
      const vest = body.context?.vesting;

      if (!account) {
        return {
          txs: [],
          warnings: [...warnings, "To claim vesting, I need your connected account (context.account)."],
        };
      }

      if (!vest) {
        return {
          txs: [],
          warnings: [...warnings, "To claim vesting, I need your vesting record + Merkle proof (context.vesting)."],
        };
      }

      if (account.toLowerCase() !== vest.data.beneficiary.toLowerCase()) {
        return {
          txs: [],
          warnings: [...warnings, "Vesting claim blocked: connected account does not match the vesting beneficiary."],
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
  const extras = getEnvExtras();

  const docsUrl = plan.docsUrl ?? extras.DOCS_URL;
  const supportEmail = plan.supportEmail ?? extras.SUPPORT_EMAIL;

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

    let offerings: readonly UShareOffering[] = [];
    try {
      offerings = getUShareOfferings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid USHARE_OFFERINGS_JSON";
      return reply.code(500).send({ error: "CONFIG_ERROR", message: msg });
    }

    const plan = await planFromMessages(parsed.data, offerings);

    let txs: TxPreview[] = [];
    let warnings = [...(plan.warnings ?? [])];

    try {
      const built = buildTxs(plan, parsed.data, offerings);
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

    let offerings: readonly UShareOffering[] = [];
    try {
      offerings = getUShareOfferings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid USHARE_OFFERINGS_JSON";
      return reply.code(500).send({ error: "CONFIG_ERROR", message: msg });
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

      const plan = await planFromMessages(parsed.data, offerings);

      let txs: TxPreview[] = [];
      let warnings = [...(plan.warnings ?? [])];

      try {
        const built = buildTxs(plan, parsed.data, offerings);
        txs = built.txs;
        warnings = built.warnings;
      } catch (e: unknown) {
        warnings = [...warnings, e instanceof Error ? e.message : "TX_BUILD_FAILED"];
        txs = [];
      }

      const out = makeOut(plan, txs, warnings);

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
