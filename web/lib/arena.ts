// Server only. Reads the vault contract and the pots: get_tier, get_config, pending_owner_actions, is_codehash_approved over NEAR
// RPC; balances from mempool.space (Bitcoin) and a Base RPC (USDC). Every read can fail on its own and comes back as null.
import fixture from "../fixtures/arena.json";
import { CHAIN_OF, mempoolApi, type Network, type TierId } from "./links";
import { checkMode } from "./mode";
import { formatNative, tierStatus, type ContractTier, type Pot, type TierState } from "./tiers";

export type Pending = { kind: "codehash"; codehash: string; readyAt: number } | { kind: "withdraw"; tierId: number; to: string; readyAt: number };
export type Config = { timelock_ns: number; mainnet: boolean; stub_attestation: boolean; locked: boolean; paused: boolean };
export type ArenaTier = {
  id: TierId;
  chain: "btc" | "evm";
  address: string | null;
  state: TierState;
  roundsLeft: number | null;
  maxRelease: string | null;
  cooldownS: number | null;
  pot: Pot | null;
};
export type Arena = { network: Network; at: string; config: Config | null; tiers: ArenaTier[]; pending: Pending[] | null; mock: boolean };

export const network = (): Network => (process.env.NEXT_PUBLIC_NETWORK === "mainnet" ? "mainnet" : "testnet");
export const isMock = () => checkMode();
const enabled = (t: TierId) => process.env[`TIER_ENABLED_${t}`] !== "0";
const IDS: TierId[] = [1, 2, 3];
const T = 8000;

const rpcUrl = (n: Network) => process.env.NEAR_RPC || (n === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");
const baseRpc = (n: Network) => process.env.BASE_RPC || (n === "mainnet" ? "https://mainnet.base.org" : "https://sepolia.base.org");

// A view call. Throws on any failure; a contract panic (ERR_BAD_TIER) comes back as { panic }.
export async function view<R>(method: string, args: Record<string, unknown> = {}): Promise<R> {
  const vault = process.env.VAULT_ACCOUNT;
  if (!vault) throw new Error("VAULT_ACCOUNT is not set");
  const res = await fetch(rpcUrl(network()), {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(T),
    body: JSON.stringify({ jsonrpc: "2.0", id: "web", method: "query", params: { request_type: "call_function", finality: "final", account_id: vault, method_name: method, args_base64: btoa(JSON.stringify(args)) } }),
  });
  const j: any = await res.json();
  const err = j.error?.data ?? j.error?.message ?? j.result?.error;
  if (err) {
    if (/ERR_[A-Z_]+/.test(JSON.stringify(err))) return { panic: /ERR_[A-Z_]+/.exec(JSON.stringify(err))![0] } as R;
    throw new Error("rpc error");
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}

const settle = <X>(p: Promise<X>) => p.then(v => v, () => undefined);

async function btcSats(n: Network, address: string): Promise<bigint> {
  const r = await fetch(`${mempoolApi(n)}/address/${encodeURIComponent(address)}`, { cache: "no-store", signal: AbortSignal.timeout(T) });
  if (!r.ok) throw new Error("mempool");
  const j: any = await r.json();
  return BigInt(j.chain_stats.funded_txo_sum) - BigInt(j.chain_stats.spent_txo_sum);
}

async function usdcUnits(n: Network, usdc: string, holder: string): Promise<bigint> {
  const data = "0x70a08231" + holder.toLowerCase().replace(/^0x/, "").padStart(64, "0"); // balanceOf(address)
  const r = await fetch(baseRpc(n), { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(T), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: usdc, data }, "latest"] }) });
  const j: any = await r.json();
  if (typeof j.result !== "string") throw new Error("base rpc");
  return BigInt(j.result);
}

// Dollars only on mainnet: testnet coins are worth nothing, and a dollar figure next to them would mislead.
async function btcUsd(n: Network): Promise<number | null> {
  if (n !== "mainnet") return null;
  const r = await fetch("https://mempool.space/api/v1/prices", { cache: "no-store", signal: AbortSignal.timeout(T) });
  return Number((await r.json()).USD) || null;
}

const pendingOf = (raw: any[]): Pending[] =>
  raw.map(p =>
    "Codehash" in p
      ? { kind: "codehash" as const, codehash: p.Codehash.codehash, readyAt: p.Codehash.ready_at_ns / 1e6 }
      : { kind: "withdraw" as const, tierId: p.EmergencyWithdraw.tier_id, to: p.EmergencyWithdraw.to, readyAt: p.EmergencyWithdraw.ready_at_ns / 1e6 },
  );

function build(n: Network, now: number, config: Config | undefined, raw: (ContractTier | null | undefined)[], units: (bigint | undefined)[], usd: number | null, pending: Pending[] | undefined, mock: boolean): Arena {
  const tiers = IDS.map((id, i): ArenaTier => {
    const t = raw[i];
    const chain = CHAIN_OF[id];
    const u = units[i];
    const pot: Pot | null = u === undefined ? null : { native: formatNative(chain, u), usd: chain === "evm" ? (n === "mainnet" ? Number(u) / 1e6 : null) : usd === null ? null : (Number(u) / 1e8) * usd };
    return {
      id,
      chain,
      address: t?.address ?? null,
      state: config ? tierStatus(t, { paused: config.paused, enabled: enabled(id), nowMs: now }) : enabled(id) ? { status: "unknown" } : { status: "not_launched" },
      roundsLeft: t?.rounds_left ?? null,
      maxRelease: t ? formatNative(chain, BigInt(t.max_release)) : null,
      cooldownS: t?.cooldown_s ?? null,
      pot,
    };
  });
  return { network: n, at: new Date(now).toISOString(), config: config ?? null, tiers, pending: pending ?? null, mock };
}

export async function loadArena(now = Date.now()): Promise<Arena> {
  const n = network();
  if (isMock()) {
    const f = fixture as any;
    const raw = f.tiers.map((t: any) => ({ ...t, cooldown_until_ns: t.cooldown_in_s ? (now + t.cooldown_in_s * 1000) * 1e6 : t.cooldown_until_ns }));
    const pending = pendingOf(f.pending.map((p: any) => ({ Codehash: { ...p.Codehash, ready_at_ns: (now + p.Codehash.ready_at_ns_in_s * 1000) * 1e6 } })));
    return build(n, now, f.config, raw, IDS.map(id => BigInt(f.balances[id])), f.btc_usd, pending, true);
  }
  const [config, pending, usd, ...raw] = await Promise.all([
    settle(view<Config>("get_config")),
    settle(view<any[]>("pending_owner_actions").then(pendingOf)),
    settle(btcUsd(n)),
    ...IDS.map(id => settle(view<any>("get_tier", { id }).then(t => (t?.panic === "ERR_BAD_TIER" ? null : (t as ContractTier))))),
  ]);
  const units = await Promise.all(
    IDS.map((id, i) => {
      const t = raw[i] as ContractTier | null | undefined;
      if (!t) return undefined;
      return settle(CHAIN_OF[id] === "btc" ? btcSats(n, t.address) : t.evm ? usdcUnits(n, t.evm.usdc, t.address) : Promise.reject());
    }),
  );
  return build(n, now, config as Config | undefined, raw as (ContractTier | null | undefined)[], units, (usd as number | null | undefined) ?? null, pending as Pending[] | undefined, false);
}

// For /verify: is the codehash the agent reports approved in the contract? undefined when it cannot be read.
export async function codehashApproved(codehash: string): Promise<boolean | undefined> {
  if (isMock()) return (fixture as any).codehash_approved;
  return settle(view<boolean>("is_codehash_approved", { codehash }));
}
