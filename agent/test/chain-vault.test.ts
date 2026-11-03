import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { transactions, utils } from "near-api-js";
import { encodeFunctionData, keccak256, parseAbi, serializeTransaction, type Hex } from "viem";
import { privateKeyToAccount, sign as evmSign } from "viem/accounts";
import { BroadcastFailedError } from "../src/pipeline";
import { makeBase, NoGasFundsError } from "../src/chain/base";
import { assembleSigned as assembleBtc, makeBtc, txidOfLegacy } from "../src/chain/btc";
import { ContractRefusedError, makeVault, ReleaseTimeoutError, RpcError, SignFailedError, type VaultOpts } from "../src/chain/vault";
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
const txResult = (logs: string[], over: Record<string, unknown> = {}) => ({ final_execution_status: "FINAL", status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs } }], ...over });
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
function baseNode(o: { balance?: bigint; eth?: bigint; sendErr?: string } = {}) {
  const calls: string[] = [];
  const Z = "0x" + "00".repeat(32);
  const f = (async (_u: string, init: RequestInit) => {
    const r = JSON.parse(init.body as string);
    calls.push(r.method);
    const res: Record<string, () => unknown> = {
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
  return { base: makeBase({ fetch: f, rpcUrl: "https://base.test" }), calls };
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
    expect(res.e.nearTx).toHaveLength(44);
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
