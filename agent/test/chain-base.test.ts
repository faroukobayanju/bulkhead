import { describe, expect, test } from "bun:test";
import { encodeFunctionData, keccak256, parseAbi, serializeTransaction, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { assembleSigned, GAS_LIMIT, makeBase, MAX_FEE_PER_GAS, nonceOfTx, NoGasFundsError } from "../src/chain/base";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const KEY = ("0x" + "11".repeat(32)) as Hex;
const acct = privateKeyToAccount(KEY);
const TO = "0x52908400098527886E0F7030069857D2E4169EE7";

// the unsigned tx exactly as evm.rs builds it: type 2 fields, chain 84532, transfer(address,uint256)
const tx = {
  type: "eip1559" as const,
  chainId: 84532,
  nonce: 7,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
  gas: 100_000n,
  to: USDC as Hex,
  value: 0n,
  data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [TO, 30_000_000n] }),
};
const unsigned = serializeTransaction(tx);

// The signature the MPC would return: r, s of the signing hash, as big_r (33 bytes) and s.
async function mpcSig(hash: Hex, privateKey = KEY) {
  const sig = await sign({ hash, privateKey });
  return { bigR: "02" + sig.r.slice(2), s: sig.s.slice(2) };
}

describe("assembleSigned", () => {
  test("reproduces the transaction the tier key itself would sign, byte for byte", async () => {
    const sig = await mpcSig(keccak256(unsigned));
    const ours = await assembleSigned(unsigned, sig, acct.address);
    expect(ours).toBe(await acct.signTransaction(tx));
  });
  test("accepts the unsigned hex without 0x, and a tier address in any case", async () => {
    const sig = await mpcSig(keccak256(unsigned));
    expect(await assembleSigned(unsigned.slice(2), sig, acct.address.toLowerCase())).toBe(await acct.signTransaction(tx));
  });
  test("a high-s signature is normalised and still recovers", async () => {
    const sig = await mpcSig(keccak256(unsigned));
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = { ...sig, s: (N - BigInt("0x" + sig.s)).toString(16).padStart(64, "0") };
    expect(await assembleSigned(unsigned, high, acct.address)).toBe(await acct.signTransaction(tx));
  });
  test("a signature over another hash throws, and so does one by another key", async () => {
    await expect(assembleSigned(unsigned, await mpcSig(keccak256("0x1234")), acct.address)).rejects.toThrow("tier address");
    await expect(assembleSigned(unsigned, await mpcSig(keccak256(unsigned), ("0x" + "22".repeat(32)) as Hex), acct.address)).rejects.toThrow("tier address");
  });
  test("malformed big_r or s throws", async () => {
    const sig = await mpcSig(keccak256(unsigned));
    await expect(assembleSigned(unsigned, { ...sig, bigR: "02ab" }, acct.address)).rejects.toThrow();
    await expect(assembleSigned(unsigned, { ...sig, s: "ab" }, acct.address)).rejects.toThrow();
  });
});

// ---- the JSON-RPC calls, through an injected fetch ----
const Z32 = "0x" + "00".repeat(32);
const block = (baseFeePerGas: string) => ({ number: "0x1", baseFeePerGas, gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", transactions: [], hash: Z32, parentHash: Z32, nonce: "0x0000000000000000", miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", stateRoot: Z32, receiptsRoot: Z32, transactionsRoot: Z32, logsBloom: "0x" + "00".repeat(256), sha3Uncles: Z32, uncles: [], mixHash: Z32 });
function node(over: Record<string, (params: any[]) => unknown> = {}) {
  const calls: { method: string; params: any[] }[] = [];
  const h: Record<string, (p: any[]) => unknown> = {
    eth_getBalance: () => "0x2386f26fc10000", // 0.01 ETH
    eth_getTransactionCount: () => "0x7",
    eth_call: () => "0x" + (50_000_000).toString(16).padStart(64, "0"),
    eth_getBlockByNumber: () => block("0x3b9aca00"),
    eth_maxPriorityFeePerGas: () => "0x5f5e100", // 0.1 gwei
    eth_gasPrice: () => "0x3b9aca00",
    eth_feeHistory: () => ({ oldestBlock: "0x1", baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0.5], reward: [["0x5f5e100"]] }),
    ...over,
  };
  const f = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(init.body as string);
    calls.push({ method: req.method, params: req.params });
    try {
      const fn = h[req.method];
      if (!fn) return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "no " + req.method } }));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: fn(req.params) }));
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: (e as Error).message } }));
    }
  }) as unknown as typeof fetch;
  return { f, calls, base: () => makeBase({ fetch: f, rpcUrl: "https://base.test", }) };
}

describe("reads", () => {
  test("usdcBalance calls balanceOf on the USDC contract", async () => {
    const n = node();
    expect(await n.base().usdcBalance(TO, USDC)).toBe(50_000_000n);
    const call = n.calls.find(c => c.method === "eth_call")!;
    expect(call.params[0].to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(call.params[0].data ?? call.params[0].input).toMatch(/^0x70a08231/);
  });
  test("nonce counts pending transactions", async () => {
    const n = node();
    expect(await n.base().nonce(TO)).toBe(7);
    expect(n.calls.find(c => c.method === "eth_getTransactionCount")!.params[1]).toBe("pending");
  });
  test("fees are clamped to the contract's 50 gwei cap", async () => {
    const lo = await node().base().fees();
    expect(lo.maxFeePerGas).toBeLessThan(MAX_FEE_PER_GAS);
    expect(lo.maxPriorityFeePerGas).toBe(100_000_000n);
    const hi = await node({ eth_getBlockByNumber: () => block("0x174876e800") }).base().fees(); // 100 gwei base fee
    expect(hi.maxFeePerGas).toBe(MAX_FEE_PER_GAS);
    expect(hi.maxPriorityFeePerGas).toBeLessThanOrEqual(hi.maxFeePerGas);
  });
});

describe("gas pre-check", () => {
  test("enough ETH passes", async () => {
    await node().base().checkGas(TO, GAS_LIMIT, 2_000_000_000n); // needs 0.0002 ETH
  });
  test("exactly enough passes, one wei short throws NoGasFundsError", async () => {
    const need = GAS_LIMIT * 2_000_000_000n;
    await node({ eth_getBalance: () => "0x" + need.toString(16) }).base().checkGas(TO, GAS_LIMIT, 2_000_000_000n);
    const err = await node({ eth_getBalance: () => "0x" + (need - 1n).toString(16) }).base().checkGas(TO, GAS_LIMIT, 2_000_000_000n).catch(e => e);
    expect(err).toBeInstanceOf(NoGasFundsError);
    expect(err.need).toBe(need);
  });
  test("a zero balance throws", async () => {
    const err = await node({ eth_getBalance: () => "0x0" }).base().checkGas(TO, GAS_LIMIT, MAX_FEE_PER_GAS).catch(e => e);
    expect(err).toBeInstanceOf(NoGasFundsError);
  });
});

describe("broadcast", () => {
  const raw = ("0x02" + "ab".repeat(20)) as Hex;
  test("sends the raw tx and returns the hash", async () => {
    const n = node({ eth_sendRawTransaction: () => keccak256(raw) });
    expect(await n.base().broadcast(raw)).toBe(keccak256(raw));
    expect(n.calls.find(c => c.method === "eth_sendRawTransaction")!.params[0]).toBe(raw);
  });
  test("already known counts as sent", async () => {
    const n = node({ eth_sendRawTransaction: () => { throw new Error("already known"); } });
    expect(await n.base().broadcast(raw)).toBe(keccak256(raw));
  });
  test("nonce too low counts as sent only when the chain has this tx", async () => {
    const tooLow = () => { throw new Error("nonce too low"); };
    await expect(node({ eth_sendRawTransaction: tooLow, eth_getTransactionByHash: () => null }).base().broadcast(raw)).rejects.toThrow();
    const mined = { hash: keccak256(raw), blockHash: "0x" + "11".repeat(32), blockNumber: "0x5", from: TO, gas: "0x5208", gasPrice: "0x1", input: "0x", nonce: "0x1", to: USDC, transactionIndex: "0x0", value: "0x0", type: "0x0", v: "0x1b", r: "0x1", s: "0x1" };
    expect(await node({ eth_sendRawTransaction: tooLow, eth_getTransactionByHash: () => mined }).base().broadcast(raw)).toBe(keccak256(raw));
  });
  test("any other refusal throws", async () => {
    await expect(node({ eth_sendRawTransaction: () => { throw new Error("insufficient funds for gas"); } }).base().broadcast(raw)).rejects.toThrow();
  });
});

describe("no RPC URL (or key in it) in any error (item 3)", () => {
  const SECRET_URL = "https://base-mainnet.example.com/v2/FAKE-KEY-0123456789abcdef";
  const everywhere = (e: unknown) => JSON.stringify([String((e as Error)?.message), String((e as Error)?.stack), Object.getOwnPropertyNames(e as object).map(k => String((e as any)[k]))]);
  // each of these makes viem fail in a different way: the connection dies, the node answers 500, the node returns an RPC error
  const modes: Record<string, typeof fetch> = {
    "connection error carrying the url": (async (url: string) => { throw new TypeError(`fetch failed for ${url}`); }) as unknown as typeof fetch,
    "http 500 with the url in the body": (async (url: string) => new Response(`bad gateway from ${url}`, { status: 500 })) as unknown as typeof fetch,
    "rpc error naming the url": (async (url: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `rate limited ${url}` } }))) as unknown as typeof fetch,
  };
  const calls: [string, (b: ReturnType<typeof makeBase>) => Promise<unknown>][] = [
    ["chainId", b => b.chainId()],
    ["usdcBalance", b => b.usdcBalance(TO, USDC)],
    ["nonce", b => b.nonce(TO)],
    ["fees", b => b.fees()],
    ["checkGas", b => b.checkGas(TO, GAS_LIMIT, 1n)],
    ["broadcast", b => b.broadcast("0x02" + "ab".repeat(20))],
  ];
  for (const [mode, f] of Object.entries(modes)) {
    for (const [name, run] of calls) {
      test(`${name}, ${mode}`, async () => {
        const err = await run(makeBase({ fetch: f, rpcUrl: SECRET_URL })).then(() => null, e => e);
        expect(err).toBeInstanceOf(Error);
        const all = everywhere(err);
        expect(all).not.toContain("FAKE-KEY");
        expect(all).not.toContain("base-mainnet.example.com");
      });
    }
  }
  test("NoGasFundsError is still a NoGasFundsError", async () => {
    const f = (async (_u: string, init: RequestInit) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(init.body as string).id, result: "0x1" }))) as unknown as typeof fetch;
    await expect(makeBase({ fetch: f, rpcUrl: SECRET_URL }).checkGas(TO, GAS_LIMIT, 1_000n)).rejects.toBeInstanceOf(NoGasFundsError);
  });
  test("chainId returns the number", async () => {
    expect(await node({ eth_chainId: () => "0x14a34" }).base().chainId()).toBe(84532);
  });
});

describe("nonceOfTx", () => {
  test("reads the nonce of an unsigned or signed tx", async () => {
    expect(nonceOfTx(unsigned)).toBe(7);
    const sig = await mpcSig(keccak256(unsigned));
    expect(nonceOfTx(await assembleSigned(unsigned, sig, acct.address))).toBe(7);
  });
});
