// src/lib/env.ts
import "dotenv/config";
import { z } from "zod";

const Address = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address");

const Bytes32 = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid bytes32");

const BoolFromEnv = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return v;
}, z.boolean());

const EnvSchema = z.object({
  // runtime
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  HOST: z.string().optional(),
  PORT: z.coerce.number().int().positive().optional(),

  // CORS
  CORS_ORIGIN: z.string().optional(), // e.g. "http://localhost:5173"

  // OpenAI
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),

  // Prompt (support both keys; we normalize below)
  SYSTEM_PROMPT: z.string().optional(),
  ASSISTANT_SYSTEM_PROMPT: z.string().optional(),

  // Chain / RPC (Arbitrum Sepolia default)
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive().optional().default(421614),

  /**
   * Optional server key (ONLY if you later decide the backend should sign txs).
   * Prefer leaving it empty and doing signing in the client wallet instead.
   */
  BACKEND_PRIVATE_KEY: z.string().optional(),

  // roles
  ADMIN_ADDRESS: Address.optional(),
  OWNER: Address.optional(),

  // tokens / contracts
  CIRCLE_USDC: Address.optional(),
  MOCK_USDC: Address.optional(),
  USDC: Address.optional(),

  URANO_TOKEN: Address.optional(),
  URANO_STAKING: Address.optional(),
  URANO_GOVERNANCE: Address.optional(),

  USHARE_FACTORY: Address.optional(),
  USHARE_MARKET: Address.optional(),
  USHARE_FACTORY_MOCK: Address.optional(),
  USHARE_MARKET_MOCK: Address.optional(),

  // vesting
  VESTING_ADDRESS: Address.optional(),
  MERKLE_ROOT: Bytes32.optional(),
  TGE_TIMESTAMP: z.coerce.number().int().nonnegative().optional(),

  // uShare defaults (optional, but handy)
  SNAPSHOT_BLOCK: z.coerce.number().int().nonnegative().optional(),

  USHARE_NAME: z.string().optional(),
  USHARE_SYMBOL: z.string().optional(),
  USHARE_AMOUNT: z.string().optional(), // bigints => keep as string
  USHARE_PRICE_IN_USDC: z.string().optional(),
  MIN_URANO_AMOUNT_FOR_PRE_SALE: z.string().optional(),
  SALE_DURATION: z.coerce.number().int().nonnegative().optional(),
  HAS_CASHFLOW: BoolFromEnv.optional(),

  USHARE_ID: Bytes32.optional(),
  USHARE_TOKEN: Address.optional(),

  // extra config used by planner/tx builder
  URANO_DECIMALS: z.coerce.number().int().positive().max(255).optional(),
  USHARE_DECIMALS: z.coerce.number().int().positive().max(255).optional(),
  DOCS_URL: z.string().optional(),
  SUPPORT_EMAIL: z.string().optional(),

  // uShare registry config
  USHARE_OFFERINGS_JSON: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = (() => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${msg}`);
  }

  const data = parsed.data;

  // Normalize prompt: if SYSTEM_PROMPT is missing, fall back to ASSISTANT_SYSTEM_PROMPT.
  if (!data.SYSTEM_PROMPT && data.ASSISTANT_SYSTEM_PROMPT) {
    return { ...data, SYSTEM_PROMPT: data.ASSISTANT_SYSTEM_PROMPT };
  }

  return data;
})();
