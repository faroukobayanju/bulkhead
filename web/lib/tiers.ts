// Tier state and pots, as pure functions. Shared by the server loader and the 30 s refresh in the browser.
import type { TierId } from "./links";

// get_tier as the vault returns it (contracts/vault/src/lib.rs).
export type ContractTier = {
  id: number;
  chain: "Bitcoin" | "Base";
  derivation_path: string;
  address: string;
  status: "Open" | { Releasing: { attempt_id: string; since_ns: number } } | { Drained: { attempt_id: string } };
  max_release: string;
  cooldown_s: number;
  rounds_left: number;
  cooldown_until_ns: number;
  evm: { chain_id: number; usdc: string } | null;
};

export type Status = "open" | "cooling" | "releasing" | "drained" | "paused" | "not_launched" | "unknown";
export type TierState = { status: Status; nextRoundAt?: number; attemptId?: string };

export const TIER_INFO: Record<TierId, { name: string; defense: string; asset: "BTC" | "USDC" }> = {
  1: { name: "Naive", defense: "System prompt only", asset: "BTC" },
  2: { name: "Hardened", defense: "Hardened prompt and refusal policy, no firewall", asset: "USDC" },
  3: { name: "Firewall", defense: "Hardened prompt plus the Bulkhead firewall", asset: "BTC" },
};

export const STATUS_TEXT: Record<Status, string> = {
  open: "Open",
  cooling: "Between rounds",
  releasing: "Payout in progress",
  drained: "Drained",
  paused: "Paused",
  not_launched: "Not launched",
  unknown: "Status unavailable",
};

// `t` is null when the contract has no such tier, undefined when it could not be read.
export function tierStatus(t: ContractTier | null | undefined, o: { paused: boolean; enabled: boolean; nowMs: number }): TierState {
  if (!o.enabled || t === null) return { status: "not_launched" };
  if (t === undefined) return { status: "unknown" };
  if (o.paused) return { status: "paused" };
  if (typeof t.status === "object" && "Drained" in t.status) return { status: "drained", attemptId: t.status.Drained.attempt_id };
  if (typeof t.status === "object" && "Releasing" in t.status) return { status: "releasing", attemptId: t.status.Releasing.attempt_id };
  const until = t.cooldown_until_ns / 1e6;
  return until > o.nowMs ? { status: "cooling", nextRoundAt: until } : { status: "open" };
}

// Seconds in words, in the largest whole unit: "24 hours", "90 minutes", "60 seconds".
export function span(s: number): string {
  const [n, unit] = s % 3600 === 0 ? [s / 3600, "hour"] : s % 60 === 0 && s >= 120 ? [s / 60, "minute"] : [Math.round(s), "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

// The standing owner-power line for /rules and the tier pages (docs/claims.md, "Owner powers"). The timelock comes from the
// contract's get_config; when that cannot be read the line still shows, without a length.
export const ownerPowerLine = (timelockNs: number | null | undefined) =>
  `The vault owner can pause the vault, and can withdraw a tier's funds after a public timelock${typeof timelockNs === "number" ? ` of ${span(timelockNs / 1e9)}` : " (its length is on /verify)"}. A pending withdraw is listed on /verify while it waits.`;

// ---- pots ----
export type Pot = { native: string; usd: number | null };
export type PotState = { pot: Pot | null; at: string | null; stale: boolean };

const DECIMALS = { btc: 8, evm: 6 } as const;
export function formatNative(chain: "btc" | "evm", units: bigint): string {
  const d = DECIMALS[chain];
  const s = units.toString().padStart(d + 1, "0");
  const frac = s.slice(-d).replace(/0+$/, "");
  return `${s.slice(0, -d)}${frac ? `.${frac}` : ""} ${chain === "btc" ? "BTC" : "USDC"}`;
}

// A failed read (null) keeps the last good value and marks it stale: the pot is never shown blank or as zero by mistake.
export function mergePot(prev: PotState | undefined, next: Pot | null, at: string): PotState {
  if (next) return { pot: next, at, stale: false };
  return prev?.pot ? { ...prev, stale: true } : { pot: null, at: null, stale: true };
}

const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;
export function potText(s: PotState, wonBy?: string): string {
  if (wonBy) return `0 · won by ${wonBy.slice(0, 8)}…`;
  if (!s.pot) return "balance unavailable";
  if (s.stale) return `balance unavailable · last ${s.pot.native} at ${hhmm(s.at!)}`;
  return s.pot.usd === null ? s.pot.native : `${s.pot.native} ≈ $${Math.round(s.pot.usd).toLocaleString("en-US")}`;
}
