// src/config/uShareOfferings.ts
import { z } from "zod";
import type { Address } from "viem";

export type UShareOffering = Readonly<{
  name: string;
  symbol: string;
  uShareId: `0x${string}`; // bytes32
  uShareToken: Address;
  decimals?: number; // only set when known
}>;

export type UShareSelection = Readonly<{
  id: `0x${string}` | null; // bytes32
  label?: string; // only set when known
  decimals?: number; // only set when known
}>;

const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address")
  .transform((s) => s as Address);

const Bytes32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid bytes32")
  .transform((s) => s as `0x${string}`);

function decimalStringToBytes32(dec: string): `0x${string}` {
  const n = BigInt(dec);
  if (n < 0n) throw new Error("uShareId decimal must be >= 0");
  const hex = n.toString(16);
  if (hex.length > 64) throw new Error("uShareId is too large for bytes32");
  return (`0x${hex.padStart(64, "0")}`) as `0x${string}`;
}

const OfferingSchema = z.object({
  name: z.string().min(1),
  symbol: z.string().min(1),

  // Accept bytes32 hex OR decimal string; normalize into bytes32 hex
  uShareId: z.union([
    Bytes32Schema,
    z
      .string()
      .regex(/^\d+$/, "uShareId must be bytes32 hex or a decimal string")
      .transform((s) => decimalStringToBytes32(s)),
  ]),

  uShareToken: AddressSchema,
  decimals: z.number().int().positive().max(255).optional(),
});

const OfferingsSchema = z.array(OfferingSchema).max(100);

/**
 * Provide offerings via env:
 *   USHARE_OFFERINGS_JSON='[{"name":"Default uShare","symbol":"USHARE","uShareId":"8848...","uShareToken":"0x...","decimals":18}]'
 */
export function getUShareOfferings(): readonly UShareOffering[] {
  const raw = (process.env.USHARE_OFFERINGS_JSON ?? "").trim();
  if (!raw) return [];

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid USHARE_OFFERINGS_JSON (must be valid JSON): ${msg}`);
  }

  const parsed = OfferingsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid USHARE_OFFERINGS_JSON schema: ${issues}`);
  }

  // exactOptionalPropertyTypes-safe mapping: never set decimals when undefined.
  return parsed.data.map((o) => {
    const base: Omit<UShareOffering, "decimals"> = {
      name: o.name,
      symbol: o.symbol,
      uShareId: o.uShareId,
      uShareToken: o.uShareToken,
    };
    return typeof o.decimals === "number" ? { ...base, decimals: o.decimals } : base;
  });
}

export function findOfferingById(
  offerings: readonly UShareOffering[],
  id: `0x${string}`
): UShareOffering | null {
  const target = id.toLowerCase();
  return offerings.find((o) => o.uShareId.toLowerCase() === target) ?? null;
}

export function extractBytes32FromText(text: string): `0x${string}` | null {
  const m = text.match(/0x[a-fA-F0-9]{64}/);
  return m ? (m[0] as `0x${string}`) : null;
}

/**
 * Resolve which uShare the user means based on the message.
 * - If they paste a bytes32, use it.
 * - Else if only one offering exists, default to it.
 * - Else match by symbol/name.
 */
export function resolveUShareSelectionFromText(
  offerings: readonly UShareOffering[],
  userText: string
): UShareSelection {
  const pasted = extractBytes32FromText(userText);
  if (pasted) {
    const found = findOfferingById(offerings, pasted);
    if (found) return selectionFromOffering(found);
    return { id: pasted };
  }

  if (offerings.length === 1) {
    return selectionFromOffering(offerings[0]!);
  }

  const t = ` ${userText.trim().toLowerCase()} `;
  for (const o of offerings) {
    const sym = o.symbol.toLowerCase();
    const nm = o.name.toLowerCase();

    if (t.includes(` ${sym} `) || t.includes(` ${nm} `) || t.includes(sym) || t.includes(nm)) {
      return selectionFromOffering(o);
    }
  }

  return { id: null };
}

function selectionFromOffering(o: UShareOffering): UShareSelection {
  const base: Omit<UShareSelection, "decimals"> = {
    id: o.uShareId,
    label: `${o.name} (${o.symbol})`,
  };

  // exactOptionalPropertyTypes-safe: only include decimals if it's a real number.
  return typeof o.decimals === "number" ? { ...base, decimals: o.decimals } : base;
}
