// The vault on NEAR: tier state, the release call and everything the pipeline needs to know about its outcome.
// release() reads chain state, asks the contract to sign (exactly 300 TGas, E14b), waits for FINAL, takes the signature from the
// `release_signed` event (NEP-297, standard `bulkhead`), stores the signed tx, broadcasts it and returns both ids. Once the contract
// has signed, a failure is a BroadcastFailedError: the tier is paid on-chain and the rebroadcast loop settles it.
// No env here: every setting, and the agent's signing key, comes in as an argument.
import { createHash } from "node:crypto";
import type { Counter } from "../counter";
import type { Config } from "../config";
import type { Tier } from "../llm";
import { bytesToHex } from "@noble/hashes/utils";
import { KeyPair, transactions, utils } from "near-api-js";
import { BroadcastFailedError, type TierState } from "../pipeline";
import type { Hrp } from "../address";
import type { Base } from "./base";
import { GAS_LIMIT, assembleSigned as assembleEvm } from "./base";
import { assembleSigned as assembleBtc, makeBtc, pickUtxo, tierAddress, tierPubkey, type Btc } from "./btc";
import { makeBase } from "./base";
import { startRebroadcast, type Payout } from "./rebroadcast";

const RELEASE_GAS = 300n * 10n ** 12n; // E14b: never max gas, it reserves more than the key's allowance
const ROOTS_GAS = 30n * 10n ** 12n;
const TX_POLL_MS = 15_000; // the `tx` method itself holds a request for up to ~10 s while it waits for finality
const TX_VALIDITY = 86_400; // blocks after the reference block that a transaction can still be included

export type Signer = { publicKey: string; sign(msg: Uint8Array): Promise<Uint8Array> }; // ed25519, "ed25519:<base58>"; the TEE key later
export type TierId = 1 | 2 | 3;

export class RpcError extends Error {
  constructor(public causeName: string | undefined, method: string) {
    super(`near rpc ${method}: ${causeName ?? "error"}`);
    this.name = "RpcError";
  }
}
// The contract panicked with one of its ERR_ strings (release_funds is refused before any state changes), or we found nothing
// payable (ERR_NO_UTXOS / ERR_OVER_CAP, raised locally so no gas is spent).
export class ContractRefusedError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "ContractRefusedError";
  }
}
export class SignFailedError extends Error {
  constructor() {
    super("signer_failed");
  }
}
export class ReleaseTimeoutError extends Error {
  constructor() {
    super("release_timeout");
  }
}

type Status = "Open" | { Releasing: { attempt_id: string; since_ns: number } } | { Drained: { attempt_id: string } };
export type TierInfo = {
  id: number;
  chain: "Bitcoin" | "Base";
  derivation_path: string;
  address: string;
  status: Status;
  max_release: string;
  cooldown_s: number;
  rounds_left: number;
  cooldown_until_ns: number;
  evm: { chain_id: number; usdc: string } | null;
};
const statusOf = (t: TierInfo) => (typeof t.status === "string" ? t.status : Object.keys(t.status)[0]!);
const attemptOf = (t: TierInfo) => (typeof t.status === "string" ? undefined : Object.values(t.status)[0]!.attempt_id);

// What this process knows about a release tx it sent. After a restart there is nothing, and wasSigned then only trusts the contract.
type Sent = { state: "unsent" | "rejected" | "sent"; hash?: string; sender?: string; refHeight?: number; final?: "failed" | "signed" };

export type VaultOpts = {
  fetch: typeof fetch;
  rpcUrl: string;
  vaultAccount: string;
  signerAccount: string; // the MPC contract: v1.signer-prod.testnet, v1.signer on mainnet
  agentAccount: string;
  signer: Signer;
  btc: Btc;
  base?: Base;
  hrp: Hrp;
  storeSignedTx: (r: { attempt_id: string; chain: "btc" | "evm"; hex: string }) => Promise<unknown>;
  warn?: (what: string, id: string, e: unknown) => void;
  timeoutMs?: number; // per RPC call, 10 s (E22)
  finalWaitMs?: number; // how long release waits for FINAL, 120 s (E6)
  pollMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function makeVault(o: VaultOpts) {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const finalWaitMs = o.finalWaitMs ?? 120_000;
  const pollMs = o.pollMs ?? 2_000;
  const now = o.clock ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const sent = new Map<string, Sent>(); // ponytail: never pruned, one small entry per attempt; prune if a process lives for millions of attempts

  async function rpc(method: string, params: unknown, ms = timeoutMs): Promise<any> {
    const res = await o.fetch(o.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "bulkhead", method, params }),
      signal: AbortSignal.timeout(ms),
    });
    let j: any;
    try {
      j = await res.json();
    } catch {
      throw new Error(`near rpc ${method}: http ${res.status}`);
    }
    if (j?.error) throw new RpcError(j.error.cause?.name ?? j.error.name, method);
    if (!res.ok || j === null || typeof j !== "object") throw new Error(`near rpc ${method}: http ${res.status}`);
    return j.result;
  }
  // optimistic: the freshest state. A payout seen here is real enough to refuse a second one, and a stale `final` view could say "not signed" for a tx that just ran.
  async function view(account: string, method: string, args: unknown, finality: "optimistic" | "final" = "optimistic") {
    const r = await rpc("query", { request_type: "call_function", finality, account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    if (typeof r?.error === "string") throw new Error(`near view ${method}: ${r.error.slice(0, 200)}`);
    return JSON.parse(Buffer.from(r.result).toString());
  }
  const vaultView = (method: string, args: unknown) => view(o.vaultAccount, method, args);
  const getTier = (id: number): Promise<TierInfo> => vaultView("get_tier", { id });

  // One transaction at a time from the agent key, so two calls cannot pick the same nonce.
  let lock: Promise<unknown> = Promise.resolve();
  let lastNonce = 0;
  function send(method: string, args: unknown, gas: bigint, onHash?: (h: { hash: string; refHeight: number }) => void): Promise<string> {
    const run = async () => {
      const pub = utils.PublicKey.from(o.signer.publicKey);
      const key = await rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: o.agentAccount, public_key: o.signer.publicKey });
      const nonce = Math.max(Number(key.nonce), lastNonce) + 1;
      const tx = transactions.createTransaction(o.agentAccount, pub, o.vaultAccount, nonce, [transactions.functionCall(method, Buffer.from(JSON.stringify(args)), gas, 0n)], utils.serialize.base_decode(key.block_hash));
      const bytes = transactions.encodeTransaction(tx);
      const digest = createHash("sha256").update(bytes).digest();
      const signature = new transactions.Signature({ keyType: pub.keyType, data: await o.signer.sign(digest) });
      const signed = new transactions.SignedTransaction({ transaction: tx, signature });
      const hash = utils.serialize.base_encode(digest);
      onHash?.({ hash, refHeight: Number(key.block_height) });
      lastNonce = nonce;
      await rpc("broadcast_tx_async", [Buffer.from(signed.encode()).toString("base64")]);
      return hash;
    };
    const p = lock.then(run, run);
    lock = p.catch(() => {});
    return p;
  }

  // The `tx` result once final. Unknown or timed-out polls keep waiting until the deadline.
  async function waitFinal(hash: string): Promise<any> {
    const deadline = now() + finalWaitMs;
    for (;;) {
      try {
        const r = await rpc("tx", { tx_hash: hash, sender_account_id: o.agentAccount, wait_until: "FINAL" }, TX_POLL_MS);
        if (r?.final_execution_status === "FINAL") return r;
      } catch {} // network error, UNKNOWN_TRANSACTION (not yet seen) or TIMEOUT_ERROR: ask again
      if (now() >= deadline) throw new ReleaseTimeoutError();
      await sleep(pollMs);
    }
  }
  const events = (r: any): any[] =>
    (r?.receipts_outcome ?? [])
      .flatMap((x: any) => x?.outcome?.logs ?? [])
      .filter((l: unknown) => typeof l === "string" && l.startsWith("EVENT_JSON:"))
      .map((l: string) => {
        try {
          return JSON.parse(l.slice(11));
        } catch {
          return null;
        }
      })
      .filter((e: any) => e?.standard === "bulkhead");

  // Chain state -> the contract's ReleasePayload (lib.rs). Nothing is sent until this and the gas check pass.
  async function payload(t: TierInfo, base: Base | undefined) {
    const max = BigInt(t.max_release);
    if (t.chain === "Bitcoin") {
      // the tier key must be the one the address was made from, or the MPC would sign for a key that cannot spend the coin
      const derived = await view(o.signerAccount, "derived_public_key", { path: t.derivation_path, predecessor: o.vaultAccount, domain_id: 0 });
      if (tierAddress(derived, o.hrp) !== t.address) throw new Error("tier address does not match the derived key");
      const [utxos, fee] = await Promise.all([o.btc.getUtxos(t.address), o.btc.feeRate()]);
      const u = pickUtxo(utxos, max, fee);
      if (!u) throw new ContractRefusedError(utxos.length ? "ERR_OVER_CAP" : "ERR_NO_UTXOS");
      return { derived, body: { Bitcoin: { utxos: [u], fee_rate_sat_vb: fee } } };
    }
    if (!base) throw new Error("no Base client configured");
    if (!t.evm) throw new Error("Base tier has no evm config");
    const [bal, nonce, fees] = await Promise.all([base.usdcBalance(t.address, t.evm?.usdc ?? ""), base.nonce(t.address), base.fees()]);
    const amount = bal < max ? bal : max;
    if (amount === 0n) throw new ContractRefusedError("ERR_NO_UTXOS");
    await base.checkGas(t.address, GAS_LIMIT, fees.maxFeePerGas); // NoGasFundsError
    return { derived: null, body: { Base: { nonce, max_fee_per_gas: fees.maxFeePerGas.toString(), max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(), gas_limit: Number(GAS_LIMIT), usdc_amount: amount.toString() } } };
  }

  async function release(tier: TierId, attemptId: string, recipient: string): Promise<{ nearTx: string; chainTxid: string }> {
    const rec: Sent = { state: "unsent" };
    sent.set(attemptId, rec);
    const t = await getTier(tier);
    const p = await payload(t, o.base);
    const args = { tier_id: tier, attempt_id: attemptId, recipient, payload: p.body };
    let hash: string;
    try {
      hash = await send("release_funds", args, RELEASE_GAS, h => Object.assign(rec, { state: "sent", sender: o.agentAccount, ...h })); // recorded before the send: a lost answer must not look like "never sent"
    } catch (e) {
      if (e instanceof RpcError) rec.state = "rejected"; // the node answered no
      throw e;
    }
    const r = await waitFinal(hash);
    const fail = r.status?.Failure;
    if (fail) {
      rec.final = "failed";
      const m = JSON.stringify(fail).match(/Smart contract panicked: (ERR_[A-Z0-9_]+)/);
      throw m ? new ContractRefusedError(m[1]!) : new Error("release_funds failed on-chain");
    }
    const ev = events(r);
    const signed = ev.find(e => e.event === "release_signed" && e.data?.attempt_id === attemptId)?.data;
    if (!signed) {
      rec.final = "failed"; // release_failed event: the MPC did not sign, no round is spent, pending_tx is cleared
      throw new SignFailedError();
    }
    rec.final = "signed";

    // The contract has signed. Nothing below may look like "failed before signing".
    try {
      const sig = { bigR: signed.signature.big_r.affine_point as string, s: signed.signature.s.scalar as string };
      const chain = t.chain === "Bitcoin" ? "btc" : "evm";
      const hex =
        t.chain === "Bitcoin"
          ? assembleBtc(signed.unsigned_tx_hex, sig, bytesToHex(tierPubkey(p.derived!)), ev.find(e => e.event === "release_requested" && e.data?.attempt_id === attemptId).data.payload)
          : await assembleEvm(signed.unsigned_tx_hex, sig, t.address);
      // a failed store must not stop the broadcast: the money is owed either way, and the hex is also in the NEAR tx
      await o.storeSignedTx({ attempt_id: attemptId, chain, hex }).catch(e => o.warn?.("store_failed", attemptId, e));
      const chainTxid = chain === "btc" ? await o.btc.broadcast(hex) : await o.base!.broadcast(hex);
      return { nearTx: hash, chainTxid };
    } catch (e) {
      o.warn?.("broadcast_failed", attemptId, e);
      throw new BroadcastFailedError(hash);
    }
  }

  async function tierOpen(tier: number): Promise<TierState> {
    const t = await getTier(tier);
    switch (statusOf(t)) {
      case "Open":
        return { status: "open", retryAfterS: Math.max(0, Math.ceil((t.cooldown_until_ns - now() * 1e6) / 1e9)) };
      case "Releasing":
        return { status: "releasing", retryAfterS: 0 };
      case "Drained":
        return { status: "drained", retryAfterS: 0 };
      default:
        throw new Error("unknown tier status"); // never guess a state as open
    }
  }

  // E6. `false` only when no tx of this attempt can still sign: the contract has no pending_tx for it AND the release tx is known
  // final-and-failed, was rejected or never sent, or expired. In flight, or nothing known (restart), throws: the pipeline then
  // counts the attempt as signed, which only costs a held lock.
  async function wasSigned(tier: number, attemptId: string): Promise<boolean> {
    if ((await vaultView("get_pending_tx", { id: attemptId })) != null) return true;
    if (attemptOf(await getTier(tier)) === attemptId) return true;
    const s = sent.get(attemptId);
    if (!s) throw new Error("no record of this release tx: outcome unknown");
    if (s.state === "unsent" || s.state === "rejected" || s.final === "failed") return false;
    try {
      const r = await rpc("tx", { tx_hash: s.hash, sender_account_id: s.sender, wait_until: "FINAL" }, TX_POLL_MS);
      if (r?.final_execution_status !== "FINAL") throw new Error("release tx not final yet: outcome unknown");
      if (r.status?.Failure) return false;
      // success with no pending_tx can only be a signer failure, which returns null; anything else is a signature
      const v = Buffer.from(r.status?.SuccessValue ?? "", "base64").toString();
      return v !== "null";
    } catch (e) {
      if (!(e instanceof RpcError && e.causeName === "UNKNOWN_TRANSACTION")) throw e;
    }
    const head = await rpc("block", { finality: "final" });
    if (Number(head?.header?.height) > s.refHeight! + TX_VALIDITY) return false; // expired: it can never be included
    throw new Error("release tx unknown but not expired: outcome unknown");
  }

  // E22: only a FullAccess key may log in as the account. An RPC failure throws; false means the RPC said the key is not there
  // or is a FunctionCall key.
  // ponytail: kept for tests and tools; the server's login check is accesskey.ts
  async function viewAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    let r: any;
    try {
      r = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
    } catch (e) {
      if (e instanceof RpcError && (e.causeName === "UNKNOWN_ACCESS_KEY" || e.causeName === "UNKNOWN_ACCOUNT")) return false;
      throw e;
    }
    if (typeof r?.error === "string") {
      if (/does not exist/.test(r.error)) return false;
      throw new Error("near view_access_key: " + r.error.slice(0, 200));
    }
    return r?.permission === "FullAccess";
  }

  async function logAttemptRoots(day: number, roots: [number, string][]): Promise<void> {
    const hash = await send("log_attempt_roots", { day, roots }, ROOTS_GAS);
    const r = await waitFinal(hash);
    if (r.status?.Failure) throw new Error("log_attempt_roots failed on-chain");
  }

  return {
    release,
    tierOpen,
    wasSigned,
    viewAccessKey,
    logAttemptRoots,
    getTier,
    pendingTx: (id: string): Promise<string | null> => vaultView("get_pending_tx", { id }),
  };
}
export type Vault = ReturnType<typeof makeVault>;

// The ChainDeps of server.ts, built from the agent's config (src/main.ts loads this by name). The signing key is the testnet
// AGENT_PRIVATE_KEY; in the TEE the Shade Agent API supplies a `signer` instead (Task 10).
type ChainDb = {
  putSignedTx(r: { attempt_id: string; chain: "btc" | "evm"; hex: string }): Promise<boolean>;
  getSignedTx(id: string): Promise<{ chain: "btc" | "evm"; hex: string } | null>;
  updateAttempt(id: string, p: { outcome: Payout["outcome"] | "drained" | "release_failed" | "broadcast_failed_terminal"; chain_txid?: string }): Promise<void>;
  listAttempts(since: string, cursor: string | null, limit?: number): Promise<{ rows: Record<string, unknown>[]; next: string; done: boolean }>;
  counter: Counter;
};
const PAYOUT_LOOKBACK_MS = 14 * 24 * 3600_000; // ponytail: a payout stuck for more than 14 days drops off the work list; add an outcome index query if that matters

export function makeChainDeps(cfg: Config, x: { db: ChainDb; onSettled: (t: Tier) => void; fetch?: typeof fetch; signer?: Signer; clock?: () => number }) {
  const f = x.fetch ?? fetch;
  const kp = cfg.agentPrivateKey ? KeyPair.fromString(cfg.agentPrivateKey as never) : null;
  const signer = x.signer ?? (kp ? { publicKey: kp.getPublicKey().toString(), sign: async (m: Uint8Array) => kp.sign(m).signature } : null);
  if (!signer) throw new Error("no agent signing key");
  const btc = makeBtc({ fetch: f, base: cfg.mempoolBase });
  const base = cfg.baseRpc ? makeBase({ fetch: f, rpcUrl: cfg.baseRpc }) : undefined;
  const vault = makeVault({
    fetch: f, rpcUrl: cfg.nearRpc, vaultAccount: cfg.vaultAccount, agentAccount: cfg.agentAccount, hrp: cfg.btcHrp, signer, btc, base,
    signerAccount: cfg.network === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet",
    storeSignedTx: r => x.db.putSignedTx(r), clock: x.clock,
  });
  const clock = x.clock ?? Date.now;
  return {
    release: (tier: Tier, attemptId: string, recipient: string) => vault.release(tier, attemptId, recipient),
    tierOpen: (tier: Tier) => vault.tierOpen(tier),
    wasSigned: (tier: Tier, attemptId: string) => vault.wasSigned(tier, attemptId),
    storeSignedTx: async (attemptId: string, chain: "btc" | "evm", hex: string) => void (await x.db.putSignedTx({ attempt_id: attemptId, chain, hex })),
    logAttemptRoots: vault.logAttemptRoots,
    /** Starts the rebroadcast loop in this process; returns the stop function. */
    startRebroadcast: (o: { alert: (kind: string, details: Record<string, unknown>) => void | Promise<void>; intervalMs?: number; warn?: (what: string, id: string, e: unknown) => void }) =>
      startRebroadcast({
        ...o,
        clock,
        onSettled: x.onSettled,
        pendingTx: vault.pendingTx,
        signedTx: id => x.db.getSignedTx(id),
        update: (id, patch) => x.db.updateAttempt(id, patch as never),
        failures: x.db.counter,
        broadcast: (chain, hex) => (chain === "btc" ? btc.broadcast(hex) : base!.broadcast(hex)),
        payouts: async () => {
          const since = new Date(clock() - PAYOUT_LOOKBACK_MS).toISOString();
          const out: Payout[] = [];
          for (let cursor: string | null = null; ; ) {
            const pg = await x.db.listAttempts(since, cursor);
            for (const r of pg.rows) if (r.outcome === "releasing" || r.outcome === "signed_pending_broadcast") out.push({ id: r.id as string, tier: r.tier as 1 | 2 | 3, outcome: r.outcome, ts: r.ts as string, near_tx: (r.near_tx as string | null) ?? null });
            if (pg.done) return out;
            cursor = pg.next;
          }
        },
      }),
  };
}
