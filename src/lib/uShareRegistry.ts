// src/lib/uShareRegistry.ts
import { z } from "zod";
import type { Address } from "viem";

/**
 * uShare offerings registry.
 *
 * Purpose:
 * - Map human inputs (name/symbol) -> uShareId (bytes32)
 * - Allow env-based configuration without changing env.ts
 *
 * Expected env (optional):
 * - USHARE_OFFERINGS_JSON : JSON string of array entries, e.g.
 *   [
 *     {"name":"Milano Condo","symbol":"MILANO","uShareId":"0x...","uShareToken":"0x..."},
 *     {"name":"Default uShare","symbol":"USHARE","uShareId":"8848...","uShareToken":"0x..."}
 *   ]
 *
 * Notes:
 * - uShareId can be:
 *   - bytes32 hex: 0x + 64 hex chars
 *   - or a decimal string (your script logs it as uint256), which we convert to bytes32.
 */

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address")
  .transform((s) => s as Address);

const Bytes32HexSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid bytes32 hex")
  .transform((s) => s as `0x${string}`);

const DecimalUintStringSchema = z.string().regex(/^\d+$/, "Expected a decimal uint string");

const UShareOfferingInputSchema = z.object({
  name: z.string().min(1).max(80),
  symbol: z.string().min(1).max(20).optional(),
  uShareId: z.union([Bytes32HexSchema, DecimalUintStringSchema]),
  uShareToken: AddressSchema.optional(),
});

export type UShareOffering = Readonly<{
  name: string;
  symbol?: string;
  uShareId: `0x${string}`; // bytes32 hex
  uShareToken?: Address;
}>;

export type UShareRegistry = Readonly<{
  offerings: readonly UShareOffering[];
}>;

function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function decimalToBytes32Hex(dec: string): `0x${string}` {
  const n = BigInt(dec);
  if (n < 0n) throw new Error("uShareId decimal must be >= 0");
  const hex = n.toString(16);
  if (hex.length > 64) throw new Error("uShareId is too large for bytes32");
  return (`0x${hex.padStart(64, "0")}`) as `0x${string}`;
}

export function coerceUShareId(v: string): `0x${string}` | null {
  const s = v.trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(s)) return s as `0x${string}`;
  if (/^\d+$/.test(s)) return decimalToBytes32Hex(s);
  return null;
}

export function parseOfferingsFromEnv(): readonly UShareOffering[] {
  const raw = (process.env.USHARE_OFFERINGS_JSON ?? "").trim();
  if (!raw) return [];

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(json)) return [];

  const offerings: UShareOffering[] = [];
  for (const item of json) {
    const parsed = UShareOfferingInputSchema.safeParse(item);
    if (!parsed.success) continue;

    const uShareId =
      typeof parsed.data.uShareId === "string" && parsed.data.uShareId.startsWith("0x")
        ? (parsed.data.uShareId as `0x${string}`)
        : decimalToBytes32Hex(parsed.data.uShareId as string);

    // exactOptionalPropertyTypes-safe: omit optional keys if not present
    const out: {
      name: string;
      symbol?: string;
      uShareId: `0x${string}`;
      uShareToken?: Address;
    } = {
      name: parsed.data.name,
      uShareId,
    };

    if (parsed.data.symbol && parsed.data.symbol.trim() !== "") {
      out.symbol = parsed.data.symbol.trim();
    }
    if (parsed.data.uShareToken) {
      out.uShareToken = parsed.data.uShareToken;
    }

    offerings.push(out);
  }

  return offerings;
}

export function makeRegistryFromOfferings(offerings: readonly UShareOffering[]): UShareRegistry {
  return { offerings };
}

const Bytes32InText = /0x[a-fA-F0-9]{64}/g;
const AddressInText = /0x[a-fA-F0-9]{40}/g;
// Large decimals only (avoid matching "100")
const DecimalInText = /\b\d{10,}\b/g;

export type ResolveResult = Readonly<{
  uShareId: `0x${string}` | null;
  offering?: UShareOffering;
  reason:
    | "FOUND_BYTES32_IN_TEXT"
    | "FOUND_DECIMAL_IN_TEXT"
    | "MATCHED_BY_SYMBOL"
    | "MATCHED_BY_NAME"
    | "MATCHED_BY_TOKEN_ADDRESS"
    | "NOT_FOUND";
}>;

/**
 * Resolve uShareId from free text.
 * Priority:
 *  1) bytes32 in message
 *  2) large decimal in message (converted to bytes32)
 *  3) token address in message (match registry)
 *  4) symbol match
 *  5) name substring match
 */
export function resolveUShareIdFromText(text: string, registry: UShareRegistry): ResolveResult {
  const t = text ?? "";

  // 1) bytes32 direct
  const b32 = t.match(Bytes32InText)?.[0];
  if (b32 && /^0x[a-fA-F0-9]{64}$/.test(b32)) {
    return { uShareId: b32 as `0x${string}`, reason: "FOUND_BYTES32_IN_TEXT" };
  }

  // 2) large decimal id
  const dec = t.match(DecimalInText)?.[0];
  if (dec && /^\d+$/.test(dec)) {
    return { uShareId: decimalToBytes32Hex(dec), reason: "FOUND_DECIMAL_IN_TEXT" };
  }

  const offerings = registry.offerings ?? [];

  // 3) token address match
  const addr = t.match(AddressInText)?.[0];
  if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
    const addrLc = addr.toLowerCase();
    const found = offerings.find((o) => (o.uShareToken ?? "").toLowerCase() === addrLc);
    if (found) {
      return { uShareId: found.uShareId, offering: found, reason: "MATCHED_BY_TOKEN_ADDRESS" };
    }
  }

  const norm = normalizeText(t);

  // 4) symbol match
  {
    const found = offerings.find((o) => {
      const sym = o.symbol ? normalizeText(o.symbol) : "";
      return Boolean(sym) && (norm === sym || norm.includes(sym));
    });
    if (found) return { uShareId: found.uShareId, offering: found, reason: "MATCHED_BY_SYMBOL" };
  }

  // 5) name best-effort match
  {
    let best: UShareOffering | null = null;
    let bestScore = 0;

    const msgTokens = new Set(norm.split(" ").filter(Boolean));

    for (const o of offerings) {
      const name = normalizeText(o.name);
      if (!name) continue;

      const nameTokens = new Set(name.split(" ").filter(Boolean));
      let score = 0;

      for (const tok of nameTokens) {
        if (tok.length < 3) continue;
        if (msgTokens.has(tok)) score += 1;
      }

      if (norm.includes(name)) score += 3;

      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }

    if (best && bestScore > 0) {
      return { uShareId: best.uShareId, offering: best, reason: "MATCHED_BY_NAME" };
    }
  }

  return { uShareId: null, reason: "NOT_FOUND" };
}

/** Singleton registry (env-based). */
let _registry: UShareRegistry | null = null;

export function getUShareRegistry(): UShareRegistry {
  if (_registry) return _registry;
  const offerings = parseOfferingsFromEnv();
  _registry = makeRegistryFromOfferings(offerings);
  return _registry;
}
