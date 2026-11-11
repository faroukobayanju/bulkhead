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
import { BroadcastDeferredError, BroadcastFailedError, type TierState } from "../pipeline";
import type { Hrp } from "../address";
import type { Base } from "./base";
import { GAS_LIMIT, assembleSigned as assembleEvm } from "./base";
import { assembleSigned as assembleBtc, inputsOf, makeBtc, pickUtxo, tierAddress, tierPubkey, type Btc } from "./btc";
import { amountOfTx, makeBase, nonceOfTx } from "./base";
import { startRebroadcast, type Payout } from "./rebroadcast";
import { AGENT_METHODS, keysAreScoped, type AccessKeyInfo } from "../../../scripts/check-agent-key";

const RELEASE_GAS = 300n * 10n ** 12n; // E14b: never max gas, it reserves more than the key's allowance
const ROOTS_GAS = 30n * 10n ** 12n;
const TX_POLL_MS = 15_000; // the `tx` method itself holds a request for up to ~10 s while it waits for finality
const REJECTED = new Set(["INVALID_TRANSACTION", "REQUEST_VALIDATION_ERROR"]); // the node refused the tx itself; INTERNAL_ERROR and TIMEOUT_ERROR prove nothing
const TX_VALIDITY = 86_400; // blocks after the reference block that a transaction can still be included

export type Signer = { publicKey: string; sign(msg: Uint8Array): Promise<Uint8Array> }; // ed25519, "ed25519:<base58>"; the TEE key later
export type TierId = 1 | 2 | 3;

export class RpcError extends Error {
  constructor(public causeName: string | undefined, method: string, public errName?: string) {
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
  // E6: awaited before the release call is sent, so a restart knows which tx may be in flight. If it throws, nothing is sent.
  markSent?: (attemptId: string, r: { tx: string; refHeight: number }) => Promise<unknown>;
  // Coins and the highest nonce that stored signed txs of this tier already use, so a coin or nonce is never picked twice.
  used?: (tier: number) => Promise<{ outpoints: ReadonlySet<string>; maxNonce: number; pendingAmount?: bigint }>;
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
    if (j?.error) throw new RpcError(j.error.cause?.name ?? j.error.name, method, j.error.name);
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
  function sendActions(receiver: string, actions: transactions.Action[], onHash?: (h: { hash: string; refHeight: number }) => Promise<void>): Promise<string> {
    const run = async () => {
      const pub = utils.PublicKey.from(o.signer.publicKey);
      const key = await rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: o.agentAccount, public_key: o.signer.publicKey });
      const nonce = Math.max(Number(key.nonce), lastNonce) + 1;
      const tx = transactions.createTransaction(o.agentAccount, pub, receiver, nonce, actions, utils.serialize.base_decode(key.block_hash));
      const bytes = transactions.encodeTransaction(tx);
      const digest = createHash("sha256").update(bytes).digest();
      const signature = new transactions.Signature({ keyType: pub.keyType, data: await o.signer.sign(digest) });
      const signed = new transactions.SignedTransaction({ transaction: tx, signature });
      const hash = utils.serialize.base_encode(digest);
      await onHash?.({ hash, refHeight: Number(key.block_height) });
      lastNonce = nonce;
      await rpc("broadcast_tx_async", [Buffer.from(signed.encode()).toString("base64")]);
      return hash;
    };
    const p = lock.then(run, run);
    lock = p.catch(() => {});
    return p;
  }
  const send = (method: string, args: unknown, gas: bigint, onHash?: (h: { hash: string; refHeight: number }) => Promise<void>, deposit = 0n) =>
    sendActions(o.vaultAccount, [transactions.functionCall(method, Buffer.from(JSON.stringify(args)), gas, deposit)], onHash);

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
  // Only logs the vault contract itself wrote count: another contract could print the same words.
  const events = (r: any): any[] =>
    (r?.receipts_outcome ?? [])
      .filter((x: any) => x?.outcome?.executor_id === o.vaultAccount)
      .flatMap((x: any) => x?.outcome?.logs ?? [])
      .filter((l: unknown) => typeof l === "string" && l.startsWith("EVENT_JSON:"))
      .map((l: string) => {
        try {
          return JSON.parse(l.slice(11));
        } catch {
          return null;
        }
      })
      .filter((e: any) => e?.standard === "bulkhead" && e?.version === "1.0.0");
  const derivedOf = (t: TierInfo) => view(o.signerAccount, "derived_public_key", { path: t.derivation_path, predecessor: o.vaultAccount, domain_id: 0 });

  // Chain state -> the contract's ReleasePayload (lib.rs). Nothing is sent until this and the gas check pass.
  const chainOk = new Set<number>();
  async function payload(t: TierInfo, base: Base | undefined) {
    const max = BigInt(t.max_release);
    const used = (await o.used?.(t.id)) ?? { outpoints: new Set<string>(), maxNonce: -1 };
    if (t.chain === "Bitcoin") {
      // the tier key must be the one the address was made from, or the MPC would sign for a key that cannot spend the coin
      const derived = await derivedOf(t);
      if (tierAddress(derived, o.hrp) !== t.address) throw new Error("tier address does not match the derived key");
      const [all, fee] = await Promise.all([o.btc.getUtxos(t.address), o.btc.feeRate()]);
      const utxos = all.filter(u => !used.outpoints.has(`${u.txid}:${u.vout}`)); // a coin a stored signed tx spends can look unspent until it confirms
      const u = pickUtxo(utxos, max, fee);
      if (!u) throw new ContractRefusedError(utxos.some(x => BigInt(x.value_sat) <= max) ? "ERR_DUST_ONLY" : utxos.length ? "ERR_OVER_CAP" : "ERR_NO_UTXOS");
      return { derived, body: { Bitcoin: { utxos: [u], fee_rate_sat_vb: fee } } };
    }
    if (!base) throw new Error("no Base RPC configured");
    if (!t.evm) throw new Error("Base tier has no evm config");
    if (!chainOk.has(t.evm.chain_id)) {
      const id = await base.chainId();
      if (id !== t.evm.chain_id) throw new Error(`BASE_RPC is chain ${id}, the tier is chain ${t.evm.chain_id}`);
      chainOk.add(id);
    }
    const [bal, pending, fees] = await Promise.all([base.usdcBalance(t.address, t.evm.usdc), base.nonce(t.address), base.fees()]);
    const nonce = Math.max(pending, used.maxNonce + 1); // never a nonce a stored signed tx already holds
    const free = bal - (used.pendingAmount ?? 0n); // signed and not yet mined: the balance still shows it
    const amount = free < max ? free : max;
    if (amount <= 0n) throw new ContractRefusedError("ERR_NO_UTXOS");
    await base.checkGas(t.address, GAS_LIMIT, fees.maxFeePerGas); // NoGasFundsError
    return { derived: null, body: { Base: { nonce, max_fee_per_gas: fees.maxFeePerGas.toString(), max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(), gas_limit: Number(GAS_LIMIT), usdc_amount: amount.toString() } } };
  }

  // The signed tx of an attempt from the `tx` result: release_signed (and, on Bitcoin, release_requested for the digest) checked
  // against the tier key. Throws when the signature does not verify. null: the tx carries no release_signed for this attempt.
  async function signedFrom(r: any, attemptId: string, t: TierInfo, derived: string | null): Promise<{ chain: "btc" | "evm"; hex: string } | null> {
    const ev = events(r);
    const signed = ev.find(e => e.event === "release_signed" && e.data?.attempt_id === attemptId)?.data;
    if (!signed) return null;
    const sig = { bigR: signed.signature.big_r.affine_point as string, s: signed.signature.s.scalar as string };
    if (t.chain === "Bitcoin") {
      const digest = ev.find(e => e.event === "release_requested" && e.data?.attempt_id === attemptId)?.data?.payload;
      return { chain: "btc", hex: assembleBtc(signed.unsigned_tx_hex, sig, bytesToHex(tierPubkey(derived ?? (await derivedOf(t)))), digest) };
    }
    return { chain: "evm", hex: await assembleEvm(signed.unsigned_tx_hex, sig, t.address) };
  }

  async function release(tier: TierId, attemptId: string, recipient: string): Promise<{ nearTx: string; chainTxid: string }> {
    const rec: Sent = { state: "unsent" };
    sent.set(attemptId, rec);
    const t = await getTier(tier);
    const p = await payload(t, o.base);
    const args = { tier_id: tier, attempt_id: attemptId, recipient, payload: p.body };
    let hash: string;
    try {
      hash = await send("release_funds", args, RELEASE_GAS, async h => {
        await o.markSent?.(attemptId, { tx: h.hash, refHeight: h.refHeight }); // persisted first; a failure here sends nothing
        Object.assign(rec, { state: "sent", sender: o.agentAccount, ...h }); // recorded before the send: a lost answer must not look like "never sent"
      });
    } catch (e) {
      if (e instanceof RpcError && rec.state === "sent" && (REJECTED.has(e.causeName ?? "") || REJECTED.has(e.errName ?? ""))) rec.state = "rejected"; // the node said the tx is invalid
      throw e;
    }
    const r = await waitFinal(hash);
    const fail = r.status?.Failure;
    if (fail) {
      rec.final = "failed";
      const m = JSON.stringify(fail).match(/Smart contract panicked: (ERR_[A-Z0-9_]+)/);
      throw m ? new ContractRefusedError(m[1]!) : new Error("release_funds failed on-chain");
    }
    if (!events(r).some(e => e.event === "release_signed" && e.data?.attempt_id === attemptId)) {
      rec.final = "failed"; // release_failed event: the MPC did not sign, no round is spent, pending_tx is cleared
      throw new SignFailedError();
    }
    rec.final = "signed";

    // The contract has signed. Nothing below may look like "failed before signing".
    try {
      const s = (await signedFrom(r, attemptId, t, p.derived))!;
      // a failed store must not stop the broadcast: the money is owed either way, and the hex is also in the NEAR tx (recoverSigned)
      await o.storeSignedTx({ attempt_id: attemptId, ...s }).catch(e => o.warn?.("store_failed", attemptId, e));
      if (s.chain === "btc") return { nearTx: hash, chainTxid: await o.btc.broadcast(s.hex) };
      await o.base!.broadcast(s.hex);
    } catch (e) {
      o.warn?.("broadcast_failed", attemptId, e);
      throw new BroadcastFailedError(hash);
    }
    // a Base tx in the mempool is not a payout: it may revert or be dropped. The row stays signed_pending_broadcast and the
    // rebroadcast loop settles it once the receipt says success. Expected, so not a failure to log or alert on.
    throw new BroadcastDeferredError(hash);
  }

  // The signed tx of an attempt whose release call is known by hash, read back from the final NEAR tx. For a release that timed out
  // in the pipeline: the signature is on-chain even though this process never saw it. null when the tx is not final yet or did not sign.
  async function recoverSigned(hash: string, attemptId: string, tier: number) {
    let r: any;
    try {
      r = await rpc("tx", { tx_hash: hash, sender_account_id: o.agentAccount, wait_until: "FINAL" }, TX_POLL_MS);
    } catch (e) {
      if (e instanceof RpcError && e.causeName === "UNKNOWN_TRANSACTION") return null;
      throw e;
    }
    if (r?.final_execution_status !== "FINAL" || r.status?.Failure) return null;
    const t = await getTier(tier);
    const derived = t.chain === "Bitcoin" ? await derivedOf(t) : null; // node reads stay outside the try: only a bad signature is a SignatureError
    try {
      return await signedFrom(r, attemptId, t, derived);
    } catch (e) {
      throw Object.assign(new Error((e as Error).message), { name: "SignatureError" });
    }
  }

  type Verdict = "signed" | "failed" | "null" | "notfinal" | "unknown" | "expired";
  // What became of a release tx: a signature came back, it failed, the signer failed (null), it is still running, or the node does
  // not know it (and whether it is past its 86,400-block validity, so it can never be included). Other RPC trouble throws.
  async function txVerdict(hash: string, refHeight: number): Promise<Verdict> {
    let r: any;
    try {
      r = await rpc("tx", { tx_hash: hash, sender_account_id: o.agentAccount, wait_until: "FINAL" }, TX_POLL_MS);
    } catch (e) {
      if (!(e instanceof RpcError && e.causeName === "UNKNOWN_TRANSACTION")) throw e;
      const head = await rpc("block", { finality: "final" });
      return Number(head?.header?.height) > refHeight + TX_VALIDITY ? "expired" : "unknown";
    }
    if (r?.final_execution_status !== "FINAL") return "notfinal";
    if (r.status?.Failure) return "failed";
    return Buffer.from(r.status?.SuccessValue ?? "", "base64").toString() === "null" ? "null" : "signed"; // anything but null may be a signature
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
  // counts the attempt as signed, which only costs a held lock. The tx is read before pending_tx, so a signature that lands
  // between the two reads cannot be missed.
  async function wasSigned(tier: number, attemptId: string): Promise<boolean> {
    const s = sent.get(attemptId);
    let verdict: Verdict | null = null;
    if (s?.state === "sent" && s.final !== "failed") {
      verdict = await txVerdict(s.hash!, s.refHeight!);
      if (verdict === "signed") return true;
      if (verdict === "notfinal") throw new Error("release tx not final yet: outcome unknown");
    }
    if ((await vaultView("get_pending_tx", { id: attemptId })) != null) return true;
    if (attemptOf(await getTier(tier)) === attemptId) return true;
    if (!s) throw new Error("no record of this release tx: outcome unknown");
    if (s.state === "unsent" || s.state === "rejected" || s.final === "failed") return false;
    if (verdict === "failed" || verdict === "null" || verdict === "expired") return false;
    throw new Error("release tx unknown but not expired: outcome unknown");
  }

  // release_funds with a payload the caller built, skipping every local check (cap, coins, fees). Only the attack demo uses it, to
  // show the contract's own refusals. A panic is a ContractRefusedError and no release_signed event (the MPC refused) is a
  // SignFailedError, as in release(). Returns the NEAR tx hash.
  async function releaseWith(tier: TierId, attemptId: string, recipient: string, payload: unknown): Promise<string> {
    const hash = await send("release_funds", { tier_id: tier, attempt_id: attemptId, recipient, payload }, RELEASE_GAS);
    const r = await waitFinal(hash);
    const fail = r.status?.Failure;
    if (fail) {
      const m = JSON.stringify(fail).match(/Smart contract panicked: (ERR_[A-Z0-9_]+)/);
      throw m ? new ContractRefusedError(m[1]!) : new Error("release_funds failed on-chain");
    }
    if (!events(r).some(e => e.event === "release_signed" && e.data?.attempt_id === attemptId)) throw new SignFailedError();
    return hash;
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

  // TEE registration (and renewal, deposit 0). A panic throws its ERR_ string, with the contract's reason after the colon.
  async function registerAgent(attestation: unknown, depositYocto: bigint): Promise<void> {
    const r = await waitFinal(await send("register_agent", { attestation }, RELEASE_GAS, undefined, depositYocto));
    if (r.status?.Failure) throw new ContractRefusedError(JSON.stringify(r.status.Failure).match(/Smart contract panicked: (ERR_[A-Z0-9_]+(?::[^"\\]*)?)/)?.[1] ?? "register_agent failed on-chain");
  }
  // One tx, so it is atomic: add the scoped key, delete the key that signs it (the full-access key at TEE boot).
  async function scopeKeys(scopedPublicKey: string, allowanceYocto: bigint): Promise<void> {
    const actions = [
      transactions.addKey(utils.PublicKey.from(scopedPublicKey), transactions.functionCallAccessKey(o.vaultAccount, AGENT_METHODS, allowanceYocto)),
      transactions.deleteKey(utils.PublicKey.from(o.signer.publicKey)),
    ];
    const r = await waitFinal(await sendActions(o.agentAccount, actions));
    if (r.status?.Failure) throw new Error("key rotation failed on-chain");
  }
  const accessKeys = async (): Promise<AccessKeyInfo[]> => (await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: o.agentAccount })).keys;
  // The agent account's balance in yoctoNEAR; 0 while the account does not exist yet.
  async function balance(): Promise<bigint> {
    try {
      return BigInt((await rpc("query", { request_type: "view_account", finality: "final", account_id: o.agentAccount })).amount);
    } catch (e) {
      if (e instanceof RpcError && e.causeName === "UNKNOWN_ACCOUNT") return 0n;
      throw e;
    }
  }

  // The signing key's allowance left (a FunctionCall key; 0 for any other) and the account balance.
  async function funds(): Promise<{ allowance: bigint; balance: bigint }> {
    const k = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: o.agentAccount, public_key: o.signer.publicKey });
    return { allowance: BigInt(k?.permission?.FunctionCall?.allowance ?? 0), balance: await balance() };
  }

  async function logAttemptRoots(day: number, roots: [number, string][]): Promise<void> {
    const hash = await send("log_attempt_roots", { day, roots }, ROOTS_GAS);
    const r = await waitFinal(hash);
    if (r.status?.Failure) throw new Error("log_attempt_roots failed on-chain");
  }

  return {
    release,
    releaseWith,
    tierOpen,
    wasSigned,
    viewAccessKey,
    logAttemptRoots,
    registerAgent,
    scopeKeys,
    accessKeys,
    balance,
    funds,
    getRoots: (day: number): Promise<[number, string][]> => vaultView("get_roots", { day }),
    getTier,
    recoverSigned,
    txVerdict,
    pendingTx: (id: string): Promise<string | null> => vaultView("get_pending_tx", { id }),
  };
}
export type Vault = ReturnType<typeof makeVault>;

// The ChainDeps of server.ts, built from the agent's config (src/main.ts calls this). The signing key is the testnet
// AGENT_PRIVATE_KEY; in the TEE the agent's own scoped key comes in as `signer` (src/tee.ts).
type PayoutRow = { id: string; tier: 1 | 2 | 3; outcome: string; ts: string; near_tx: string | null; release_tx: string | null; release_ref_height: number | null };
type ChainDb = {
  putSignedTx(r: { attempt_id: string; chain: "btc" | "evm"; hex: string }): Promise<boolean>;
  getSignedTx(id: string): Promise<{ chain: "btc" | "evm"; hex: string } | null>;
  updateAttempt(id: string, p: { outcome: string; chain_txid?: string; reply?: string }): Promise<void>;
  markSent(id: string, r: { tx: string; refHeight: number }): Promise<void>;
  listPayouts(drainedSince: string): Promise<PayoutRow[]>;
  counter: Counter;
};
// A Signer from an "ed25519:..." secret key string (the testnet AGENT_PRIVATE_KEY).
export function keySigner(key: string): Signer {
  const kp = KeyPair.fromString(key as never);
  return { publicKey: kp.getPublicKey().toString(), sign: async (m: Uint8Array) => kp.sign(m).signature };
}
const DRAINED_LOOKBACK_MS = 24 * 3600_000; // a drained payout's coin and nonce are excluded for a day, by which time it has confirmed

export function makeChainDeps(cfg: Config, x: { db: ChainDb; onSettled: (t: Tier, attemptId: string) => void; fetch?: typeof fetch; signer?: Signer; clock?: () => number; warn?: (what: string, id: string, e: unknown) => void }) {
  const f = x.fetch ?? fetch;
  const signer = x.signer ?? (cfg.agentPrivateKey ? keySigner(cfg.agentPrivateKey) : null);
  if (!signer) throw new Error("no agent signing key");
  const clock = x.clock ?? Date.now;
  const btc = makeBtc({ fetch: f, base: cfg.mempoolBase });
  const base = cfg.baseRpc ? makeBase({ fetch: f, rpcUrl: cfg.baseRpc }) : undefined;
  const unsigned = new Map<string, string>(); // attempt id -> the contract's pending_tx, for rows with no stored hex
  const rows = () => x.db.listPayouts(new Date(clock() - DRAINED_LOOKBACK_MS).toISOString());
  const vault = makeVault({
    fetch: f, rpcUrl: cfg.nearRpc, vaultAccount: cfg.vaultAccount, agentAccount: cfg.agentAccount, hrp: cfg.btcHrp, signer, btc, base,
    signerAccount: cfg.network === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet",
    storeSignedTx: r => x.db.putSignedTx(r),
    markSent: (id, r) => x.db.markSent(id, r),
    warn: x.warn,
    // coins and nonces of this tier's stored signed txs that are not yet old enough to have confirmed
    used: async tier => {
      const outpoints = new Set<string>();
      let maxNonce = -1;
      let pendingAmount = 0n;
      for (const r of await rows()) {
        if (r.tier !== tier) continue;
        let s = await x.db.getSignedTx(r.id);
        if (!s && (r.outcome === "signed_pending_broadcast" || r.outcome === "broadcast_failed_terminal" || r.outcome === "drained")) {
          // no stored hex (a terminal row nobody could recover, or one whose signature never verified): the contract still holds the
          // unsigned tx it asked the MPC to sign, which names the same coins and nonce. Immutable once signed, so read once.
          let u = unsigned.get(r.id) ?? null;
          if (u === null) {
            u = await vault.pendingTx(r.id);
            if (u !== null) unsigned.set(r.id, u); // only a tx that exists is cached: null may just be "not signed yet"
          }
          if (u) s = { chain: tier === 2 ? "evm" : "btc", hex: u }; // ponytail: the chain of a tier is fixed (1 and 3 Bitcoin, 2 Base); read it from get_tier if that changes
        }
        if (!s) continue;
        if (s.chain === "btc") for (const c of inputsOf(s.hex)) outpoints.add(c);
        else if (r.outcome !== "broadcast_failed_terminal") {
          // a terminal Base row may never have reached the mempool: its nonce would be a gap that nothing fills, so only the chain's own count decides
          maxNonce = Math.max(maxNonce, nonceOfTx(s.hex));
          if (r.outcome === "signed_pending_broadcast") pendingAmount += amountOfTx(s.hex);
          // ponytail: the amount of a terminal row that did land is not subtracted; the next transfer may then revert on balance and shows as a reverted receipt
        }
      }
      return { outpoints, maxNonce, pendingAmount };
    },
    clock: x.clock,
  });
  const pending = async (): Promise<Payout[]> =>
    (await rows()).filter(r => r.outcome === "releasing" || r.outcome === "signed_pending_broadcast").map(r => ({ ...r, outcome: r.outcome as Payout["outcome"] }));
  return {
    release: (tier: Tier, attemptId: string, recipient: string) => vault.release(tier, attemptId, recipient),
    tierOpen: (tier: Tier) => vault.tierOpen(tier),
    wasSigned: (tier: Tier, attemptId: string) => vault.wasSigned(tier, attemptId),
    storeSignedTx: async (attemptId: string, chain: "btc" | "evm", hex: string) => void (await x.db.putSignedTx({ attempt_id: attemptId, chain, hex })),
    logAttemptRoots: vault.logAttemptRoots,
    getRoots: vault.getRoots,
    registerAgent: vault.registerAgent,
    funds: vault.funds,
    /** Every key on the agent account may only call the vault's agent methods (scripts/check-agent-key.ts). */
    keysScoped: async () => keysAreScoped(await vault.accessKeys(), cfg.vaultAccount),
    /** The attempts a restart must treat as holding their tier: rows still `releasing` or `signed_pending_broadcast`. */
    pendingPayouts: pending,
    /** Startup check: BASE_RPC is the chain the Base tier is on. Throws on a mismatch; a vault with no Base tier passes. */
    async check() {
      if (!base) return;
      let t: TierInfo;
      try {
        t = await vault.getTier(2);
      } catch (e) {
        if (String((e as Error).message).includes("ERR_BAD_TIER")) return;
        throw e;
      }
      const id = await base.chainId();
      if (t.evm && id !== t.evm.chain_id) throw new Error(`BASE_RPC is chain ${id}, the Base tier is chain ${t.evm.chain_id}`);
    },
    /** Starts the rebroadcast loop in this process; returns the stop function (its `idle()` waits for a run in progress). */
    startRebroadcast: (o: { alert: (kind: string, details: Record<string, unknown>) => void | Promise<void>; intervalMs?: number; firstMs?: number; warn?: (what: string, id: string, e: unknown) => void }) =>
      startRebroadcast({
        ...o,
        clock,
        onSettled: x.onSettled,
        pendingTx: vault.pendingTx,
        txVerdict: vault.txVerdict,
        receipt: async hex => {
          if (!base) throw Object.assign(new Error("no Base RPC configured"), { name: "NoBaseRpc" }); // configuration, not a failed payout: warned about, never counted
          return base.receipt(hex);
        },
        recover: p => vault.recoverSigned(p.release_tx!, p.id, p.tier),
        signedTx: id => x.db.getSignedTx(id),
        storeSignedTx: (id, chain, hex) => x.db.putSignedTx({ attempt_id: id, chain, hex }),
        update: (id, patch) => x.db.updateAttempt(id, patch),
        failures: x.db.counter,
        broadcast: (chain, hex) => {
          if (chain === "btc") return btc.broadcast(hex);
          if (!base) throw new Error("no Base RPC configured");
          return base.broadcast(hex);
        },
        payouts: pending,
      }),
  };
}
