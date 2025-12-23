"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
require("dotenv/config");
const zod_1 = require("zod");
const Address = zod_1.z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address");
const Bytes32 = zod_1.z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid bytes32");
const BoolFromEnv = zod_1.z.preprocess((v) => {
    if (typeof v !== "string")
        return v;
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1")
        return true;
    if (s === "false" || s === "0")
        return false;
    return v;
}, zod_1.z.boolean());
const EnvSchema = zod_1.z.object({
    // runtime
    NODE_ENV: zod_1.z.enum(["development", "test", "production"]).optional(),
    HOST: zod_1.z.string().optional(),
    PORT: zod_1.z.coerce.number().int().positive().optional(),
    // CORS
    CORS_ORIGIN: zod_1.z.string().optional(), // e.g. "http://localhost:5173"
    // OpenAI
    OPENAI_API_KEY: zod_1.z.string().min(1, "OPENAI_API_KEY is required"),
    OPENAI_MODEL: zod_1.z.string().optional(),
    SYSTEM_PROMPT: zod_1.z.string().optional(),
    // Chain / RPC
    RPC_URL: zod_1.z.string().url(),
    CHAIN_ID: zod_1.z.coerce.number().int().positive().optional().default(84532),
    /**
     * Optional server key (ONLY if you later decide the backend should sign txs).
     * Prefer leaving it empty and doing signing in the client wallet instead.
     */
    BACKEND_PRIVATE_KEY: zod_1.z.string().optional(),
    // roles
    ADMIN_ADDRESS: Address.optional(),
    OWNER: Address.optional(),
    // tokens / contracts (Base Sepolia)
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
    TGE_TIMESTAMP: zod_1.z.coerce.number().int().nonnegative().optional(),
    // uShare defaults (optional, but handy)
    SNAPSHOT_BLOCK: zod_1.z.coerce.number().int().nonnegative().optional(),
    USHARE_NAME: zod_1.z.string().optional(),
    USHARE_SYMBOL: zod_1.z.string().optional(),
    USHARE_AMOUNT: zod_1.z.string().optional(), // bigints => keep as string
    USHARE_PRICE_IN_USDC: zod_1.z.string().optional(),
    MIN_URANO_AMOUNT_FOR_PRE_SALE: zod_1.z.string().optional(),
    SALE_DURATION: zod_1.z.coerce.number().int().nonnegative().optional(),
    HAS_CASHFLOW: BoolFromEnv.optional(),
    USHARE_ID: Bytes32.optional(),
    USHARE_TOKEN: Address.optional(),
});
exports.env = (() => {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
        const msg = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("\n");
        throw new Error(`Invalid environment variables:\n${msg}`);
    }
    return parsed.data;
})();
//# sourceMappingURL=env.js.map