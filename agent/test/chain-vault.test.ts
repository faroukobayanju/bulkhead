import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { transactions, utils } from "near-api-js";
import { encodeFunctionData, keccak256, parseAbi, serializeTransaction, type Hex } from "viem";
import { privateKeyToAccount, sign as evmSign } from "viem/accounts";
import { BroadcastFailedError } from "../src/pipeline";
import { makeBase, NoGasFundsError } from "../src/chain/base";
import { assembleSigned as assembleBtc, makeBtc, txidOfLegacy } from "../src/chain/btc";
import { memoryCounter } from "../src/counter";
import { ContractRefusedError, makeChainDeps, makeVault, ReleaseTimeoutError, RpcError, SignFailedError, type VaultOpts } from "../src/chain/vault";
import { PUB, sighash, sign, TEST_DERIVED, TEST_TIER_ADDR, unsignedTx } from "./chain-fixtures";

const VAULT = "vault.bulkhead-test.testnet";
const AGENT = "agent.bulkhead-test.testnet";
const MPC = "v1.signer-prod.testnet";
const RECIPIENT = "tb1qerzrlxcfu24davlur5sqmgzzgsal6wusda40er";
const EVM_RECIPIENT = "0x52908400098527886E0F7030069857D2E4169EE7";
const ATTEMPT = "01JB0000000000000000000001";
const kp = utils.KeyPair.fromRandom("ed25519");
const signer = { publicKey: kp.getPublicKey().toString(), sign: async (m: Uint8Array) => kp.sign(m).signature };
const b58 = (b: Buffer) => utils.serialize.base_encode(b);
const BLOCK_HASH = b58(Buffer.alloc(32, 7));

// ---- a fake NEAR RPC ----
const rpcErr = (cause: string) => ({ error: { name: "HANDLER_ERROR", cause: { name: cause } } });
const ev = (event: string, data: unknown) => "EVENT_JSON:" + JSON.stringify({ standard: "bulkhead", version: "1.0.0", event, data });
const txResult = (logs: string[], over: Record<string, unknown> = {}) => ({ final_execution_status: "FINAL", status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: VAULT, logs } }], ...over });
const failure = (msg: string) => txResult([], { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: msg } } } } } });

type Tier = Record<string, unknown>;
const btcTier = (o: Tier = {}): Tier => ({ id: 1, chain: "Bitcoin", derivation_path: "bulkhead-tier-1", address: TEST_TIER_ADDR, status: "Open", max_release: "2000000", cooldown_s: 60, rounds_left: 5, cooldown_until_ns: 0, evm: null, ...o });
const evmAcct = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const baseTier = (o: Tier = {}): Tier => ({ id: 2, chain: "Base", derivation_path: "bulkhead-tier-2", address: evmAcct.address, status: "Open", max_release: "30000000", cooldown_s: 60, rounds_left: 4, cooldown_until_ns: 0, evm: { chain_id: 84532, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }, ...o });

type Near = {
  tier: Tier;
  pending: Record<string, string | null>;
  tx: (n: number) => unknown; // the nth `tx` poll: a result, or { error } built with rpcErr
  key: () => unknown;
  block: () => unknown;
  broadcastAsync: () => unknown;
};
function near(o: Partial<Near> = {}) {
  const n: Near = {
    tier: btcTier(),
    pending: {},
    tx: () => rpcErr("UNKNOWN_TRANSACTION"),
    key: () => ({ nonce: 41, block_hash: BLOCK_HASH, block_height: 1000, permission: "FullAccess" }),
    block: () => ({ header: { height: 1000 } }),
    broadcastAsync: () => "ok",
    ...o,
  };
  const calls: { method: string; params: any }[] = [];
  const sentTxs: transactions.SignedTransaction[] = [];
  let polls = 0;
  const f = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(init.body as string);
    calls.push({ method: req.method, params: req.params });
    const reply = (x: unknown) => new Response(JSON.stringify(x !== null && typeof x === "object" && typeof (x as any).error === "object" ? { jsonrpc: "2.0", id: req.id, ...(x as object) } : { jsonrpc: "2.0", id: req.id, result: x }));
    const p = req.params;
    if (req.method === "query" && p.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString());
      const out = p.method_name === "get_tier" ? n.tier : p.method_name === "get_pending_tx" ? (n.pending[args.id] ?? null) : p.method_name === "derived_public_key" ? TEST_DERIVED : undefined;
      if (out === undefined) return reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_METHOD" } } });
      return reply({ result: [...Buffer.from(JSON.stringify(out))], logs: [], block_height: 1 });
    }
    if (req.method === "query" && p.request_type === "view_access_key") return reply(n.key());
    if (req.method === "broadcast_tx_async") {
      sentTxs.push(transactions.SignedTransaction.decode(Buffer.from(p[0], "base64")));
      return reply(n.broadcastAsync());
    }
    if (req.method === "tx") return reply(n.tx(polls++));
    if (req.method === "block") return reply(n.block());
    return reply({ error: { name: "HANDLER_ERROR", cause: { name: "NO_SUCH_METHOD" } } });
  }) as unknown as typeof fetch;
  return { n, f, calls, sentTxs, count: (m: string) => calls.filter(c => c.method === m).length };
}

// the contract call a sent tx carries
const call = (t: transactions.SignedTransaction) => {
  const fc = t.transaction.actions[0]!.functionCall!;
  return { method: fc.methodName, gas: fc.gas, deposit: fc.deposit, args: JSON.parse(Buffer.from(fc.args).toString()), receiver: t.transaction.receiverId, signer: t.transaction.signerId, nonce: Number(t.transaction.nonce) };
};

// ---- what the contract would emit for a BTC release ----
const { hex: BTC_UNSIGNED } = unsignedTx();
const BTC_SIGHASH = bytesToHex(sighash(PUB, 341_067));
function btcSigned(attempt = ATTEMPT, over: { sighash?: string; sig?: { bigR: string; s: string } } = {}) {
  const s = over.sig ?? sign(hexToBytes(BTC_SIGHASH));
  return [
    ev("release_requested", { tier: 1, attempt_id: attempt, payload: over.sighash ?? BTC_SIGHASH }),
    ev("release_signed", { tier: 1, attempt_id: attempt, unsigned_tx_hex: BTC_UNSIGNED, signature: { big_r: { affine_point: s.bigR }, s: { scalar: s.s }, recovery_id: 0 } }),
  ];
}
const BTC_SIGNED = assembleBtc(BTC_UNSIGNED, sign(hexToBytes(BTC_SIGHASH)), bytesToHex(PUB), BTC_SIGHASH);
const BTC_TXID = txidOfLegacy(BTC_UNSIGNED);

// ---- what it would emit for a Base release ----
const evmTx = {
  type: "eip1559" as const, chainId: 84532, nonce: 7, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n, gas: 100_000n,
  to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex, value: 0n,
  data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [EVM_RECIPIENT, 30_000_000n] }),
};
async function evmSignedLogs(attempt = ATTEMPT) {
  const unsigned = serializeTransaction(evmTx);
  const s = await evmSign({ hash: keccak256(unsigned), privateKey: ("0x" + "11".repeat(32)) as Hex });
  return [ev("release_signed", { tier: 2, attempt_id: attempt, unsigned_tx_hex: unsigned.slice(2), signature: { big_r: { affine_point: "02" + s.r.slice(2) }, s: { scalar: s.s.slice(2) }, recovery_id: s.yParity } })];
}

const EVM_LOGS = await evmSignedLogs();

// ---- adapters ----
function btcStub(o: Partial<{ utxos: any[]; fee: number; broadcast: (hex: string) => Promise<string> }> = {}) {
  const log: string[] = [];
  const b = {
    getUtxos: async () => o.utxos ?? [{ txid: "cc".repeat(32), vout: 0, value_sat: 341_067 }],
    feeRate: async () => o.fee ?? 2,
    broadcast: async (hex: string) => (log.push(hex), o.broadcast ? o.broadcast(hex) : BTC_TXID),
  };
  return { b: b as unknown as ReturnType<typeof makeBtc>, log };
}
function baseNode(o: { balance?: bigint; eth?: bigint; sendErr?: string; chainId?: string } = {}) {
  const calls: string[] = [];
  const Z = "0x" + "00".repeat(32);
  const f = (async (_u: string, init: RequestInit) => {
    const r = JSON.parse(init.body as string);
    calls.push(r.method);
    const res: Record<string, () => unknown> = {
      eth_chainId: () => o.chainId ?? "0x14a34",
      eth_call: () => "0x" + (o.balance ?? 50_000_000n).toString(16).padStart(64, "0"),
      eth_getTransactionCount: () => "0x7",
      eth_getBalance: () => "0x" + (o.eth ?? 10n ** 16n).toString(16),
      eth_getBlockByNumber: () => ({ number: "0x1", baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", transactions: [], hash: Z, parentHash: Z, nonce: "0x0000000000000000", miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", stateRoot: Z, receiptsRoot: Z, transactionsRoot: Z, logsBloom: "0x" + "00".repeat(256), sha3Uncles: Z, uncles: [], mixHash: Z }),
      eth_maxPriorityFeePerGas: () => "0x5f5e100",
      eth_sendRawTransaction: () => { if (o.sendErr) throw new Error(o.sendErr); return "0x" + "ab".repeat(32); },
    };
    try {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: res[r.method]!() }));
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (e as Error).message } }));
    }
  }) as unknown as typeof fetch;
  return { base: makeBase({ fetch: f, rpcUrl: "https://base.test" }), calls, f };
}

function rig(nearOpts: Partial<Near> = {}, vo: Partial<VaultOpts> = {}, btcOpts: Parameters<typeof btcStub>[0] = {}, baseOpts: Parameters<typeof baseNode>[0] = {}) {
  const nn = near(nearOpts);
  const btc = btcStub(btcOpts);
  const bn = baseNode(baseOpts);
  const stored: any[] = [];
  const warns: string[] = [];
  let t = 0;
  const vault = makeVault({
    fetch: nn.f, rpcUrl: "https://rpc.test", vaultAccount: VAULT, signerAccount: MPC, agentAccount: AGENT, signer, btc: btc.b, base: bn.base, hrp: "tb",
    storeSignedTx: async r => void stored.push(r), warn: (w: string) => void warns.push(w),
    clock: () => t, sleep: async ms => void (t += ms), ...vo,
  });
  return { vault, ...nn, btc, bn, stored, warns, time: () => t };
}

const settle = async <T>(p: Promise<T>) => p.then(v => ({ v }), (e: Error) => ({ e }));

describe("release, Bitcoin", () => {
  test("builds the payload from chain state, sends exactly 300 TGas, and returns both ids", async () => {
    const r = rig({ tx: () => txResult(btcSigned()) });
    const out = await r.vault.release(1, ATTEMPT, RECIPIENT);
    expect(out.chainTxid).toBe(BTC_TXID);
    expect(r.sentTxs).toHaveLength(1);
    const c = call(r.sentTxs[0]!);
    expect(c.method).toBe("release_funds");
    expect(c.gas).toBe(300_000_000_000_000n); // exactly 300 TGas (E14b), never max gas
    expect(c.deposit).toBe(0n);
    expect(c.receiver).toBe(VAULT);
    expect(c.signer).toBe(AGENT);
    expect(c.nonce).toBe(42);
    expect(c.args).toEqual({ tier_id: 1, attempt_id: ATTEMPT, recipient: RECIPIENT, payload: { Bitcoin: { utxos: [{ txid: "cc".repeat(32), vout: 0, value_sat: 341_067 }], fee_rate_sat_vb: 2 } } });
    // the id is the hash of the tx that was sent
    const digest = createHash("sha256").update(transactions.encodeTransaction(r.sentTxs[0]!.transaction)).digest();
    expect(out.nearTx).toBe(utils.serialize.base_encode(digest));
    const poll = r.calls.find(x => x.method === "tx")!.params;
    expect(poll).toEqual({ tx_hash: out.nearTx, sender_account_id: AGENT, wait_until: "FINAL" });
  });

  test("stores the signed tx before it broadcasts, and the broadcast carries the same bytes", async () => {
    const order: string[] = [];
    const r = rig({ tx: () => txResult(btcSigned()) }, { storeSignedTx: async x => void order.push("store:" + x.chain + ":" + x.attempt_id) }, { broadcast: async () => (order.push("broadcast"), BTC_TXID) });
    await r.vault.release(1, ATTEMPT, RECIPIENT);
    expect(order).toEqual(["store:btc:" + ATTEMPT, "broadcast"]);
    expect(r.btc.log).toEqual([BTC_SIGNED]);
  });

  test("picks the largest confirmed UTXO under the cap (E14)", async () => {
    const r = rig({ tx: () => txResult(btcSigned()) }, {}, { utxos: [{ txid: "01".repeat(32), vout: 1, value_sat: 90_000 }, { txid: "02".repeat(32), vout: 0, value_sat: 1_500_000 }, { txid: "03".repeat(32), vout: 0, value_sat: 9_000_000 }] });
    await r.vault.release(1, ATTEMPT, RECIPIENT);
    expect(call(r.sentTxs[0]!).args.payload.Bitcoin.utxos).toEqual([{ txid: "02".repeat(32), vout: 0, value_sat: 1_500_000 }]);
  });

  test("nothing payable: ERR_NO_UTXOS, or ERR_OVER_CAP when every coin is over the cap; no tx is sent", async () => {
    const none = rig({}, {}, { utxos: [] });
    const e1 = (await settle(none.vault.release(1, ATTEMPT, RECIPIENT))) as { e: ContractRefusedError };
    expect(e1.e).toBeInstanceOf(ContractRefusedError);
    expect(e1.e.code).toBe("ERR_NO_UTXOS");
    const big = rig({}, {}, { utxos: [{ txid: "01".repeat(32), vout: 0, value_sat: 9_000_000 }] });
    expect(((await settle(big.vault.release(1, ATTEMPT, RECIPIENT))) as { e: ContractRefusedError }).e.code).toBe("ERR_OVER_CAP");
    expect(none.sentTxs.length + big.sentTxs.length).toBe(0);
  });

  test("refuses when the tier address is not the one the signer derives", async () => {
    const r = rig({ tier: btcTier({ address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" }) });
    expect(((await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: Error }).e.message).toContain("does not match");
    expect(r.sentTxs).toHaveLength(0);
  });

  test("a signature that does not verify is never broadcast: BroadcastFailedError with the NEAR tx", async () => {
    const r = rig({ tx: () => txResult(btcSigned(ATTEMPT, { sighash: "00".repeat(31) + "01" })) });
    const res = (await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: BroadcastFailedError };
    expect(res.e).toBeInstanceOf(BroadcastFailedError);
    expect(res.e.nearTx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/); // base58 of a sha256: 43 or 44 characters
    expect(r.btc.log).toHaveLength(0);
    expect(r.stored).toHaveLength(0);
  });

  test("signed but the broadcast fails: BroadcastFailedError(nearTx), the hex is already stored", async () => {
    const r = rig({ tx: () => txResult(btcSigned()) }, {}, { broadcast: async () => { throw new Error("mempool down"); } });
    const res = (await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: BroadcastFailedError };
    expect(res.e).toBeInstanceOf(BroadcastFailedError);
    expect(r.stored).toEqual([{ attempt_id: ATTEMPT, chain: "btc", hex: BTC_SIGNED }]);
    expect(r.warns).toContain("broadcast_failed");
  });

  test("a failed store does not stop the broadcast", async () => {
    const r = rig({ tx: () => txResult(btcSigned()) }, { storeSignedTx: async () => { throw new Error("db down"); } });
    expect((await r.vault.release(1, ATTEMPT, RECIPIENT)).chainTxid).toBe(BTC_TXID);
    expect(r.btc.log).toHaveLength(1);
    expect(r.warns).toContain("store_failed");
  });

  test("an event for another attempt is not used", async () => {
    const r = rig({ tx: () => txResult(btcSigned("01JB0000000000000000000002")) });
    expect(((await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: Error }).e).toBeInstanceOf(SignFailedError);
  });

  test("the signer failing (no release_signed event) is SignFailedError", async () => {
    const r = rig({ tx: () => txResult([ev("release_failed", { tier: 1, attempt_id: ATTEMPT })], { status: { SuccessValue: Buffer.from("null").toString("base64") } }) });
    expect(((await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: Error }).e).toBeInstanceOf(SignFailedError);
  });
});

describe("release, Base", () => {
  test("payload from the chain: full balance up to the cap, fees under the contract's, gas limit under 120k", async () => {
    const r = rig({ tier: baseTier(), tx: () => txResult(EVM_LOGS) }, {}, {}, { balance: 50_000_000n });
    const out = await r.vault.release(2, ATTEMPT, EVM_RECIPIENT);
    const p = call(r.sentTxs[0]!).args.payload.Base;
    expect(p.usdc_amount).toBe("30000000"); // min(balance, max_release)
    expect(p.nonce).toBe(7);
    expect(BigInt(p.max_fee_per_gas)).toBeLessThanOrEqual(50_000_000_000n);
    expect(p.gas_limit).toBeLessThanOrEqual(120_000);
    expect(call(r.sentTxs[0]!).gas).toBe(300_000_000_000_000n);
    expect(out.chainTxid).toBe("0x" + "ab".repeat(32));
    expect(r.stored[0]!.chain).toBe("evm");
  });

  test("a balance under the cap is paid in full", async () => {
    const r = rig({ tier: baseTier(), tx: () => txResult(EVM_LOGS) }, {}, {}, { balance: 12_345n });
    await settle(r.vault.release(2, ATTEMPT, EVM_RECIPIENT));
    expect(call(r.sentTxs[0]!).args.payload.Base.usdc_amount).toBe("12345");
  });

  test("not enough ETH for gas: NoGasFundsError before the contract is called", async () => {
    const r = rig({ tier: baseTier() }, {}, {}, { eth: 1n });
    const res = (await settle(r.vault.release(2, ATTEMPT, EVM_RECIPIENT))) as { e: Error };
    expect(res.e).toBeInstanceOf(NoGasFundsError);
    expect(r.sentTxs).toHaveLength(0);
  });

  test("an empty tier is ERR_NO_UTXOS", async () => {
    const r = rig({ tier: baseTier() }, {}, {}, { balance: 0n });
    expect(((await settle(r.vault.release(2, ATTEMPT, EVM_RECIPIENT))) as { e: ContractRefusedError }).e.code).toBe("ERR_NO_UTXOS");
  });

  test("an EVM broadcast failure after signing is BroadcastFailedError", async () => {
    const r = rig({ tier: baseTier(), tx: () => txResult(EVM_LOGS) }, {}, {}, { sendErr: "rpc down" });
    expect(((await settle(r.vault.release(2, ATTEMPT, EVM_RECIPIENT))) as { e: Error }).e).toBeInstanceOf(BroadcastFailedError);
    expect(r.stored).toHaveLength(1);
  });
});

describe("release, contract errors", () => {
  // the codes the pipeline records as release_failed and alerts on (contract strings, lib.rs / btc.rs / evm.rs)
  for (const code of ["ERR_FEE_TOO_HIGH", "ERR_NOT_SINGLE_INPUT", "ERR_PAUSED", "ERR_NO_UTXOS", "ERR_OVER_CAP", "ERR_COOLDOWN", "ERR_TIER_NOT_OPEN", "ERR_DUP_ATTEMPT"]) {
    test(code + " becomes ContractRefusedError", async () => {
      const r = rig({ tx: () => failure("Smart contract panicked: " + code) });
      const res = (await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: ContractRefusedError };
      expect(res.e).toBeInstanceOf(ContractRefusedError);
      expect(res.e.code).toBe(code);
    });
  }
  test("a failure without a contract code is a plain error, not a refusal", async () => {
    const r = rig({ tx: () => failure("Exceeded the prepaid gas") });
    const res = (await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: Error };
    expect(res.e).not.toBeInstanceOf(ContractRefusedError);
  });
});

describe("release, waiting for FINAL", () => {
  test("polls through unknown-transaction and timeout answers until final", async () => {
    const r = rig({ tx: n => (n === 0 ? rpcErr("UNKNOWN_TRANSACTION") : n === 1 ? rpcErr("TIMEOUT_ERROR") : txResult(btcSigned())) });
    expect((await r.vault.release(1, ATTEMPT, RECIPIENT)).chainTxid).toBe(BTC_TXID);
    expect(r.count("tx")).toBe(3);
  });
  test("a transaction not yet FINAL keeps waiting", async () => {
    const r = rig({ tx: n => (n < 2 ? { final_execution_status: "EXECUTED_OPTIMISTIC", status: { SuccessValue: "" } } : txResult(btcSigned())) });
    await r.vault.release(1, ATTEMPT, RECIPIENT);
    expect(r.count("tx")).toBe(3);
  });
  test("gives up after 120 s with ReleaseTimeoutError", async () => {
    const r = rig();
    const res = (await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: Error };
    expect(res.e).toBeInstanceOf(ReleaseTimeoutError);
    expect(r.time()).toBeGreaterThanOrEqual(120_000);
    expect(r.time()).toBeLessThan(125_000);
  });
  test("network errors while polling are retried", async () => {
    let n = 0;
    const base = near({ tx: () => txResult(btcSigned()) });
    const flaky = (async (u: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).method === "tx" && n++ < 2) throw new TypeError("fetch failed");
      return base.f(u, init);
    }) as unknown as typeof fetch;
    let t = 0;
    const v = makeVault({ fetch: flaky, rpcUrl: "x", vaultAccount: VAULT, signerAccount: MPC, agentAccount: AGENT, signer, btc: btcStub().b, hrp: "tb", storeSignedTx: async () => {}, clock: () => t, sleep: async ms => void (t += ms) });
    expect((await v.release(1, ATTEMPT, RECIPIENT)).chainTxid).toBe(BTC_TXID);
  });
});

describe("rpc client", () => {
  test("every call has a timeout (10 s default) that aborts a stalled node", async () => {
    let signal: AbortSignal | undefined;
    const hang = ((_u: string, init: RequestInit) => {
      signal = init.signal!;
      return new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)));
    }) as unknown as typeof fetch;
    const v = makeVault({ fetch: hang, rpcUrl: "x", vaultAccount: VAULT, signerAccount: MPC, agentAccount: AGENT, signer, btc: btcStub().b, hrp: "tb", storeSignedTx: async () => {}, timeoutMs: 20 });
    await expect(v.viewAccessKey("a.testnet", "ed25519:x")).rejects.toThrow();
    expect(signal).toBeDefined();
    const dflt = makeVault({ fetch: hang, rpcUrl: "x", vaultAccount: VAULT, signerAccount: MPC, agentAccount: AGENT, signer, btc: btcStub().b, hrp: "tb", storeSignedTx: async () => {}, timeoutMs: 10 });
    await expect(dflt.tierOpen(1)).rejects.toThrow();
  });
});

describe("tierOpen", () => {
  const NS = 1e9;
  const at = (tier: Tier, nowMs = 1_000_000) => rig({ tier }, { clock: () => nowMs }).vault.tierOpen(1);
  test("open without a cooldown", async () => expect(await at(btcTier())).toEqual({ status: "open", retryAfterS: 0 }));
  test("open in a cooldown: retryAfterS rounds up", async () => {
    expect(await at(btcTier({ cooldown_until_ns: 1_000_000 * 1e6 + 59.2 * NS }))).toEqual({ status: "open", retryAfterS: 60 });
    expect(await at(btcTier({ cooldown_until_ns: 1_000_000 * 1e6 - 5 * NS }))).toEqual({ status: "open", retryAfterS: 0 });
  });
  test("releasing and drained", async () => {
    expect(await at(btcTier({ status: { Releasing: { attempt_id: "a", since_ns: 1 } } }))).toEqual({ status: "releasing", retryAfterS: 0 });
    expect(await at(btcTier({ status: { Drained: { attempt_id: "a" } } }))).toEqual({ status: "drained", retryAfterS: 0 });
  });
  test("a status it does not know throws, never open", async () => {
    await expect(at(btcTier({ status: "Paused" }))).rejects.toThrow();
  });
  test("a node that is down throws", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const v = makeVault({ fetch: down, rpcUrl: "x", vaultAccount: VAULT, signerAccount: MPC, agentAccount: AGENT, signer, btc: btcStub().b, hrp: "tb", storeSignedTx: async () => {} });
    await expect(v.tierOpen(1)).rejects.toThrow();
  });
});

describe("wasSigned (E6)", () => {
  const SIGNED_ID = "01JB0000000000000000000009";
  test("a pending_tx for the attempt means signed", async () => {
    const r = rig({ pending: { [ATTEMPT]: "0200" } });
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(true);
  });
  test("the tier Releasing or Drained for this attempt means signed", async () => {
    expect(await rig({ tier: btcTier({ status: { Releasing: { attempt_id: ATTEMPT, since_ns: 1 } } }) }).vault.wasSigned(1, ATTEMPT)).toBe(true);
    expect(await rig({ tier: btcTier({ status: { Drained: { attempt_id: ATTEMPT } } }) }).vault.wasSigned(1, ATTEMPT)).toBe(true);
  });
  test("another attempt's status says nothing about this one", async () => {
    const r = rig({ tier: btcTier({ status: { Releasing: { attempt_id: "other", since_ns: 1 } } }) });
    await expect(r.vault.wasSigned(1, ATTEMPT)).rejects.toThrow("no record");
  });
  test("no record of a release tx (a restart) and nothing on-chain: unknown, so it throws", async () => {
    await expect(rig().vault.wasSigned(1, ATTEMPT)).rejects.toThrow("no record");
  });
  test("a release that failed on-chain (contract refused) and no pending_tx: false", async () => {
    const r = rig({ tx: () => failure("Smart contract panicked: ERR_COOLDOWN") });
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT));
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(false);
  });
  test("a release that failed before a tx was sent (no gas, no coins): false", async () => {
    const r = rig({}, {}, { utxos: [] });
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT));
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(false);
  });
  test("a send the node rejected: false", async () => {
    const r = rig({ broadcastAsync: () => rpcErr("INVALID_TRANSACTION") });
    const res = (await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: Error };
    expect(res.e).toBeInstanceOf(RpcError);
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(false);
  });
  test("sent, then the pending_tx appears: true even though the poll gave up", async () => {
    const r = rig();
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT)); // times out, tx unknown
    r.n.pending[ATTEMPT] = "0200";
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(true);
  });
  test("sent and still unknown, not expired: throws", async () => {
    const r = rig();
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT));
    await expect(r.vault.wasSigned(1, ATTEMPT)).rejects.toThrow("not expired");
  });
  test("sent, unknown, and the chain is past the validity window: false", async () => {
    const r = rig();
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT));
    r.n.block = () => ({ header: { height: 1000 + 86_400 + 1 } });
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(false);
    r.n.block = () => ({ header: { height: 1000 + 86_400 } }); // the last block it could still be included in
    await expect(r.vault.wasSigned(1, ATTEMPT)).rejects.toThrow();
  });
  test("sent and the tx is final and failed: false", async () => {
    const r = rig();
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT)); // gave up
    r.n.tx = () => failure("Exceeded the prepaid gas");
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(false);
  });
  test("sent and the tx is still running (not final): throws", async () => {
    const r = rig();
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT));
    r.n.tx = () => ({ final_execution_status: "EXECUTED_OPTIMISTIC", status: { SuccessValue: "" } });
    await expect(r.vault.wasSigned(1, ATTEMPT)).rejects.toThrow("not final");
    r.n.tx = () => rpcErr("TIMEOUT_ERROR");
    await expect(r.vault.wasSigned(1, ATTEMPT)).rejects.toThrow();
  });
  test("final success with a signature value but no pending_tx: true (never guess false)", async () => {
    const r = rig();
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT));
    r.n.tx = () => txResult([], { status: { SuccessValue: Buffer.from('{"big_r":{}}').toString("base64") } });
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(true);
  });
  test("final success with null (the signer failed, pending_tx cleared): false", async () => {
    const r = rig();
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT));
    r.n.tx = () => txResult([], { status: { SuccessValue: Buffer.from("null").toString("base64") } });
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(false);
  });
  test("an RPC failure while checking throws", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const v = makeVault({ fetch: down, rpcUrl: "x", vaultAccount: VAULT, signerAccount: MPC, agentAccount: AGENT, signer, btc: btcStub().b, hrp: "tb", storeSignedTx: async () => {} });
    await expect(v.wasSigned(1, SIGNED_ID)).rejects.toThrow();
  });
});

describe("viewAccessKey (E22)", () => {
  const key = (k: unknown) => rig({ key: () => k }).vault.viewAccessKey("alice.testnet", "ed25519:abc");
  test("FullAccess is true", async () => expect(await key({ nonce: 1, permission: "FullAccess" })).toBe(true));
  test("FunctionCall is false", async () => {
    expect(await key({ nonce: 1, permission: { FunctionCall: { allowance: "1", receiver_id: "x", method_names: [] } } })).toBe(false);
  });
  test("a key that is not on the account is false (both RPC shapes)", async () => {
    expect(await key(rpcErr("UNKNOWN_ACCESS_KEY"))).toBe(false);
    expect(await key(rpcErr("UNKNOWN_ACCOUNT"))).toBe(false);
    expect(await key({ error: "access key ed25519:abc does not exist while viewing", logs: [] })).toBe(false);
  });
  test("an RPC failure throws, never false", async () => {
    await expect(key(rpcErr("INTERNAL_ERROR"))).rejects.toThrow();
    await expect(key({ error: "something broke", logs: [] })).rejects.toThrow();
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const v = makeVault({ fetch: down, rpcUrl: "x", vaultAccount: VAULT, signerAccount: MPC, agentAccount: AGENT, signer, btc: btcStub().b, hrp: "tb", storeSignedTx: async () => {} });
    await expect(v.viewAccessKey("a.testnet", "ed25519:abc")).rejects.toThrow();
    const http500 = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const v2 = makeVault({ fetch: http500, rpcUrl: "x", vaultAccount: VAULT, signerAccount: MPC, agentAccount: AGENT, signer, btc: btcStub().b, hrp: "tb", storeSignedTx: async () => {} });
    await expect(v2.viewAccessKey("a.testnet", "ed25519:abc")).rejects.toThrow();
  });
  test("asks for the final state of the named account and key", async () => {
    const r = rig({ key: () => ({ nonce: 1, permission: "FullAccess" }) });
    await r.vault.viewAccessKey("alice.testnet", "ed25519:abc");
    expect(r.calls[0]!.params).toEqual({ request_type: "view_access_key", finality: "final", account_id: "alice.testnet", public_key: "ed25519:abc" });
  });
});

describe("logAttemptRoots", () => {
  test("calls log_attempt_roots with the day and (hour, root) pairs", async () => {
    const r = rig({ tx: () => txResult([]) });
    await r.vault.logAttemptRoots(20_393, [[0, "ab".repeat(32)], [1, "cd".repeat(32)]]);
    const c = call(r.sentTxs[0]!);
    expect(c.method).toBe("log_attempt_roots");
    expect(c.args).toEqual({ day: 20_393, roots: [[0, "ab".repeat(32)], [1, "cd".repeat(32)]] });
    expect(c.gas).toBeLessThan(300_000_000_000_000n);
  });
  test("an on-chain failure throws", async () => {
    const r = rig({ tx: () => failure("Smart contract panicked: ERR_ROOTS_EXIST") });
    await expect(r.vault.logAttemptRoots(1, [])).rejects.toThrow();
  });
  test("two sends in a row use increasing nonces", async () => {
    const r = rig({ tx: () => txResult([]) });
    await r.vault.logAttemptRoots(1, []);
    await r.vault.logAttemptRoots(2, []); // the chain still says 41: the next nonce must not repeat
    expect(r.sentTxs.map(t => call(t).nonce)).toEqual([42, 43]);
  });
});

// ---- fix round 1: recovery state ----
const HASHED = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

describe("the release tx is persisted before it is sent (E6)", () => {
  test("markSent gets the hash and reference height, and runs before broadcast_tx_async", async () => {
    const order: string[] = [];
    let marked: { id: string; tx: string; refHeight: number } | undefined;
    const r = rig({ tx: () => txResult(btcSigned()) }, { markSent: async (id, x) => { order.push("mark:" + r.count("broadcast_tx_async")); marked = { id, ...x }; } });
    const out = await r.vault.release(1, ATTEMPT, RECIPIENT);
    expect(order).toEqual(["mark:0"]); // nothing had been sent yet
    expect(marked).toEqual({ id: ATTEMPT, tx: out.nearTx, refHeight: 1000 });
    expect(marked!.tx).toMatch(HASHED);
  });
  test("when it cannot be persisted nothing is sent, and wasSigned can say false", async () => {
    const r = rig({}, { markSent: async () => { throw new Error("convex down"); } });
    await expect(r.vault.release(1, ATTEMPT, RECIPIENT)).rejects.toThrow("convex down");
    expect(r.sentTxs).toHaveLength(0);
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(false);
  });
});

describe("only the vault's own bulkhead 1.0.0 events count (item 8)", () => {
  const wrap = (logs: string[], executor: string) => ({ final_execution_status: "FINAL", status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: executor, logs } }] });
  test("the same words from another contract are ignored", async () => {
    const r = rig({ tx: () => wrap(btcSigned(), "evil.testnet") });
    expect(((await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: Error }).e).toBeInstanceOf(SignFailedError);
  });
  test("another version, another standard, or no executor is ignored", async () => {
    const v2 = btcSigned().map(l => l.replace('"version":"1.0.0"', '"version":"2.0.0"'));
    const nep = btcSigned().map(l => l.replace('"standard":"bulkhead"', '"standard":"other"'));
    for (const logs of [v2, nep]) {
      const r = rig({ tx: () => wrap(logs, VAULT) });
      expect(((await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: Error }).e).toBeInstanceOf(SignFailedError);
    }
    const none = rig({ tx: () => ({ ...wrap(btcSigned(), VAULT), receipts_outcome: [{ outcome: { logs: btcSigned() } }] }) });
    expect(((await settle(none.vault.release(1, ATTEMPT, RECIPIENT))) as { e: Error }).e).toBeInstanceOf(SignFailedError);
  });
  test("one receipt from the vault among others is enough", async () => {
    const r = rig({ tx: () => ({ ...wrap([], "x"), receipts_outcome: [{ outcome: { executor_id: MPC, logs: ["noise"] } }, { outcome: { executor_id: VAULT, logs: btcSigned() } }] }) });
    expect((await r.vault.release(1, ATTEMPT, RECIPIENT)).chainTxid).toBe(BTC_TXID);
  });
});

describe("coins and nonces stored signed txs already use (item 5)", () => {
  const coins = [{ txid: "cc".repeat(32), vout: 0, value_sat: 900_000 }, { txid: "dd".repeat(32), vout: 1, value_sat: 500_000 }];
  test("a coin a stored signed tx spends is not picked, even when it still looks unspent and is the largest", async () => {
    const r = rig({ tx: () => txResult(btcSigned()) }, { used: async tier => (expect(tier).toBe(1), { outpoints: new Set(["cc".repeat(32) + ":0"]), maxNonce: -1 }) }, { utxos: coins });
    await r.vault.release(1, ATTEMPT, RECIPIENT);
    expect(call(r.sentTxs[0]!).args.payload.Bitcoin.utxos).toEqual([coins[1]]);
  });
  test("every coin used: ERR_NO_UTXOS, nothing sent", async () => {
    const r = rig({}, { used: async () => ({ outpoints: new Set(coins.map(c => `${c.txid}:${c.vout}`)), maxNonce: -1 }) }, { utxos: coins });
    expect(((await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: ContractRefusedError }).e.code).toBe("ERR_NO_UTXOS");
    expect(r.sentTxs).toHaveLength(0);
  });
  test("Base: the nonce is above any stored one (the chain says 7)", async () => {
    const nonceWith = async (maxNonce: number) => {
      const r = rig({ tier: baseTier(), tx: () => txResult(EVM_LOGS) }, { used: async () => ({ outpoints: new Set(), maxNonce }) });
      await r.vault.release(2, ATTEMPT, EVM_RECIPIENT);
      return call(r.sentTxs[0]!).args.payload.Base.nonce;
    };
    expect(await nonceWith(9)).toBe(10);
    expect(await nonceWith(3)).toBe(7);
    expect(await nonceWith(-1)).toBe(7);
  });
  test("makeChainDeps feeds it from the stored signed txs of this tier's payout rows only", async () => {
    // tier 1 drained row spent the S1 coin (b7a37d34...:0); a tier 3 row spent something else
    const SPENT = "b7a37d34906d713f2436c3992495118f06a59f26f6acdcb3c5d3224959048bd1";
    const nn = near({ tx: () => txResult(btcSigned()) });
    const f = (async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://rpc.test")) return nn.f(url, init!);
      if (url.endsWith("/utxo")) return new Response(JSON.stringify([{ txid: SPENT, vout: 0, value: 341_067, status: { confirmed: true } }, { txid: "ee".repeat(32), vout: 0, value: 100_000, status: { confirmed: true } }]));
      if (url.endsWith("/fees/recommended")) return new Response(JSON.stringify({ halfHourFee: 2 }));
      if (url.endsWith("/tx")) return new Response(BTC_TXID);
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch;
    const marks: any[] = [];
    const rows = [
      { id: "A", tier: 1, outcome: "drained", ts: "t", near_tx: null, release_tx: null, release_ref_height: null },
      { id: "B", tier: 3, outcome: "drained", ts: "t", near_tx: null, release_tx: null, release_ref_height: null },
    ];
    const cfg = { network: "testnet", nearRpc: "https://rpc.test", vaultAccount: VAULT, agentAccount: AGENT, agentPrivateKey: kp.toString(), mempoolBase: "https://m.test/api", baseRpc: "", btcHrp: "tb" } as any;
    const chain = makeChainDeps(cfg, {
      fetch: f, onSettled: () => {},
      db: {
        putSignedTx: async () => true, updateAttempt: async () => {}, listPayouts: async () => rows as any, counter: memoryCounter(),
        markSent: async (id, x) => void marks.push([id, x.tx]),
        getSignedTx: async id => ({ chain: "btc", hex: id === "A" ? BTC_SIGNED : "00".repeat(60) }), // B would not even parse as a tx of ours
      },
    });
    await chain.release(1, ATTEMPT, RECIPIENT);
    expect(call(nn.sentTxs[0]!).args.payload.Bitcoin.utxos).toEqual([{ txid: "ee".repeat(32), vout: 0, value_sat: 100_000 }]);
    expect(marks).toEqual([[ATTEMPT, expect.stringMatching(HASHED)]]);
  });
});

describe("no coin worth sending (item 10)", () => {
  test("every coin under the fee floor is ERR_DUST_ONLY, not ERR_OVER_CAP", async () => {
    const r = rig({}, {}, { utxos: [{ txid: "01".repeat(32), vout: 0, value_sat: 700 }, { txid: "02".repeat(32), vout: 0, value_sat: 1_000 }] });
    expect(((await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: ContractRefusedError }).e.code).toBe("ERR_DUST_ONLY");
  });
  test("dust beside a coin over the cap is still ERR_DUST_ONLY (something fits the cap, but is too small)", async () => {
    const r = rig({}, {}, { utxos: [{ txid: "01".repeat(32), vout: 0, value_sat: 700 }, { txid: "02".repeat(32), vout: 0, value_sat: 9_000_000 }] });
    expect(((await settle(r.vault.release(1, ATTEMPT, RECIPIENT))) as { e: ContractRefusedError }).e.code).toBe("ERR_DUST_ONLY");
  });
});

describe("BASE_RPC chain (item 11)", () => {
  test("a different chain than the tier's refuses before the contract is called", async () => {
    const r = rig({ tier: baseTier() }, {}, {}, { chainId: "0x2105" }); // Base mainnet, tier is Base Sepolia
    const e = ((await settle(r.vault.release(2, ATTEMPT, EVM_RECIPIENT))) as { e: Error }).e;
    expect(e.message).toContain("8453");
    expect(r.sentTxs).toHaveLength(0);
  });
  test("no Base RPC configured: a clear error, not a crash", async () => {
    const r = rig({ tier: baseTier() }, { base: undefined });
    expect(((await settle(r.vault.release(2, ATTEMPT, EVM_RECIPIENT))) as { e: Error }).e.message).toContain("no Base RPC");
  });
  test("check(): a mismatch stops startup; no Base tier or no Base RPC passes", async () => {
    const mk = (tierReply: unknown, chainId: string, baseRpc = "https://base.test") => {
      const nn = near({ tier: baseTier() });
      const bn = baseNode({ chainId });
      const f = (async (url: string, init?: RequestInit) => {
        if (url.startsWith("https://base.test")) return bn.f(url, init!);
        const body = JSON.parse(init!.body as string);
        if (tierReply === "ERR_BAD_TIER" && body.params?.method_name === "get_tier") return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { error: "wasm execution failed: Smart contract panicked: ERR_BAD_TIER", logs: [] } }));
        return nn.f(url, init!);
      }) as unknown as typeof fetch;
      const cfg = { network: "testnet", nearRpc: "https://rpc.test", vaultAccount: VAULT, agentAccount: AGENT, agentPrivateKey: kp.toString(), mempoolBase: "https://m.test/api", baseRpc, btcHrp: "tb" } as any;
      return makeChainDeps(cfg, { fetch: f, onSettled: () => {}, db: { putSignedTx: async () => true, getSignedTx: async () => null, updateAttempt: async () => {}, markSent: async () => {}, listPayouts: async () => [], counter: memoryCounter() } });
    };
    await mk(null, "0x14a34").check();
    await expect(mk(null, "0x2105").check()).rejects.toThrow("chain 8453");
    await mk("ERR_BAD_TIER", "0x2105").check();
    await mk(null, "0x2105", "").check();
  });
});

describe("wasSigned: what counts as rejected (item 7)", () => {
  test("INVALID_TRANSACTION and REQUEST_VALIDATION_ERROR are rejected: false", async () => {
    const a = rig({ broadcastAsync: () => rpcErr("INVALID_TRANSACTION") });
    await settle(a.vault.release(1, ATTEMPT, RECIPIENT));
    expect(await a.vault.wasSigned(1, ATTEMPT)).toBe(false);
    const b = rig({ broadcastAsync: () => ({ error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR" } } }) });
    await settle(b.vault.release(1, ATTEMPT, RECIPIENT));
    expect(await b.vault.wasSigned(1, ATTEMPT)).toBe(false);
  });
  test("INTERNAL_ERROR and TIMEOUT_ERROR prove nothing: still unknown, so it throws", async () => {
    for (const cause of ["INTERNAL_ERROR", "TIMEOUT_ERROR"]) {
      const r = rig({ broadcastAsync: () => rpcErr(cause) });
      await settle(r.vault.release(1, ATTEMPT, RECIPIENT));
      await expect(r.vault.wasSigned(1, ATTEMPT)).rejects.toThrow();
    }
  });
  test("a network error while sending proves nothing either", async () => {
    const base = near();
    const f = (async (u: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).method === "broadcast_tx_async") throw new TypeError("fetch failed");
      return base.f(u, init);
    }) as unknown as typeof fetch;
    const r = rig({}, { fetch: f });
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT));
    await expect(r.vault.wasSigned(1, ATTEMPT)).rejects.toThrow();
  });
  test("the tx is read before pending_tx: a signature that landed in between is found", async () => {
    const r = rig();
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT)); // timed out
    r.n.tx = () => txResult([], { status: { SuccessValue: Buffer.from('{"big_r":{}}').toString("base64") } });
    r.n.pending = {}; // pending_tx still reads empty
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(true);
    const order: string[] = [];
    const r2 = rig();
    await settle(r2.vault.release(1, ATTEMPT, RECIPIENT));
    r2.calls.length = 0;
    r2.n.tx = () => failure("Exceeded the prepaid gas");
    await r2.vault.wasSigned(1, ATTEMPT);
    order.push(...r2.calls.map(c => c.method + ":" + (c.params?.method_name ?? "")));
    expect(order.indexOf("tx:")).toBeLessThan(order.indexOf("query:get_pending_tx"));
  });
  test("a callback that panicked after the signer answered still has its pending_tx: true", async () => {
    const r = rig();
    await settle(r.vault.release(1, ATTEMPT, RECIPIENT));
    r.n.tx = () => failure("Exceeded the prepaid gas");
    r.n.pending = { [ATTEMPT]: "0200" };
    expect(await r.vault.wasSigned(1, ATTEMPT)).toBe(true);
  });
});

describe("txVerdict", () => {
  const verdictFor = async (tx: () => unknown, head = 1000) => {
    const r = rig({ tx, block: () => ({ header: { height: head } }) });
    return r.vault.txVerdict("H".repeat(44), 1000);
  };
  test("signed, failed, null, not final", async () => {
    expect(await verdictFor(() => txResult([], { status: { SuccessValue: Buffer.from("{}").toString("base64") } }))).toBe("signed");
    expect(await verdictFor(() => txResult([], { status: { SuccessValue: "" } }))).toBe("signed"); // anything but null may be a signature
    expect(await verdictFor(() => failure("Smart contract panicked: ERR_COOLDOWN"))).toBe("failed");
    expect(await verdictFor(() => txResult([], { status: { SuccessValue: Buffer.from("null").toString("base64") } }))).toBe("null");
    expect(await verdictFor(() => ({ final_execution_status: "INCLUDED", status: "Started" }))).toBe("notfinal");
  });
  test("unknown until 86,400 blocks past the reference height, then expired", async () => {
    expect(await verdictFor(() => rpcErr("UNKNOWN_TRANSACTION"), 1000 + 86_400)).toBe("unknown");
    expect(await verdictFor(() => rpcErr("UNKNOWN_TRANSACTION"), 1000 + 86_401)).toBe("expired");
  });
  test("other RPC trouble throws", async () => {
    await expect(verdictFor(() => rpcErr("TIMEOUT_ERROR"))).rejects.toThrow();
    await expect(verdictFor(() => rpcErr("INTERNAL_ERROR"))).rejects.toThrow();
  });
});

describe("recoverSigned: the hex read back from the NEAR tx (item 2)", () => {
  const H = "H".repeat(44);
  test("Bitcoin: the same signed tx release would have built", async () => {
    const r = rig({ tx: () => txResult(btcSigned()) });
    expect(await r.vault.recoverSigned(H, ATTEMPT, 1)).toEqual({ chain: "btc", hex: BTC_SIGNED });
    expect(r.calls.find(c => c.method === "tx")!.params).toEqual({ tx_hash: H, sender_account_id: AGENT, wait_until: "FINAL" });
  });
  test("Base", async () => {
    const r = rig({ tier: baseTier(), tx: () => txResult(EVM_LOGS) });
    const got = (await r.vault.recoverSigned(H, ATTEMPT, 2))!;
    expect(got.chain).toBe("evm");
    expect(got.hex).toBe(await evmAcct.signTransaction(evmTx));
  });
  test("not final, unknown, failed, or no release_signed for this attempt: null", async () => {
    expect(await rig({ tx: () => ({ final_execution_status: "INCLUDED" }) }).vault.recoverSigned(H, ATTEMPT, 1)).toBeNull();
    expect(await rig({ tx: () => rpcErr("UNKNOWN_TRANSACTION") }).vault.recoverSigned(H, ATTEMPT, 1)).toBeNull();
    expect(await rig({ tx: () => failure("Smart contract panicked: ERR_COOLDOWN") }).vault.recoverSigned(H, ATTEMPT, 1)).toBeNull();
    expect(await rig({ tx: () => txResult(btcSigned("01JB0000000000000000000002")) }).vault.recoverSigned(H, ATTEMPT, 1)).toBeNull();
  });
  test("events from another contract are not trusted", async () => {
    const r = rig({ tx: () => ({ ...txResult([]), receipts_outcome: [{ outcome: { executor_id: "evil.testnet", logs: btcSigned() } }] }) });
    expect(await r.vault.recoverSigned(H, ATTEMPT, 1)).toBeNull();
  });
  test("a signature that does not verify throws, with the same verify step as release", async () => {
    const r = rig({ tx: () => txResult(btcSigned(ATTEMPT, { sighash: "00".repeat(31) + "01" })) });
    await expect(r.vault.recoverSigned(H, ATTEMPT, 1)).rejects.toThrow("does not verify");
  });
  test("an RPC failure throws", async () => {
    await expect(rig({ tx: () => rpcErr("INTERNAL_ERROR") }).vault.recoverSigned(H, ATTEMPT, 1)).rejects.toThrow();
  });
});
