import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { assembleSigned, BroadcastError, inputsOf, makeBtc, pickUtxo, tierAddress, txidOfLegacy, txidOfSigned, type Utxo } from "../src/chain/btc";
import { PUB, sighash, sign, unsignedTx } from "./chain-fixtures";

// docs/spikes.md S1: the derived key of tier 1 and the address the faucet funded, which the contract then spent.
const DERIVED = "secp256k1:2uQDMhqCaRrFVW4mNWv2VchYtcagNAWPyUEWMjzdJkdcf76FcUAgpkFUWzwDtER5TmXagPH2pFFQAc9op3kjudX9";
const TIER_ADDR = "tb1qvg2du726tmgjzcz89m6zj7dcdzdcyeja7z9zx5";
const u = (value_sat: number, txid = "aa".repeat(32), vout = 0): Utxo => ({ txid, vout, value_sat });

describe("tierAddress", () => {
  test("the S1 derived key gives the funded tier 1 address", () => {
    expect(tierAddress(DERIVED, "tb")).toBe(TIER_ADDR);
  });
  test("mainnet prefix, and a key that is not on the curve is refused", () => {
    expect(tierAddress(DERIVED, "bc").startsWith("bc1q")).toBe(true);
    expect(() => tierAddress("secp256k1:" + DERIVED.slice(10, -2) + "zz", "tb")).toThrow();
    expect(() => tierAddress("ed25519:abc", "tb")).toThrow();
  });
});

describe("pickUtxo (E14)", () => {
  const cap = 2_000_000n;
  test("largest confirmed value at or under the cap", () => {
    expect(pickUtxo([u(50_000, "01".repeat(32)), u(1_999_999, "02".repeat(32)), u(2_000_000, "03".repeat(32)), u(2_000_001, "04".repeat(32))], cap, 2)?.txid).toBe("03".repeat(32));
  });
  test("none at or under the cap gives null", () => {
    expect(pickUtxo([u(2_000_001)], cap, 2)).toBeNull();
    expect(pickUtxo([], cap, 2)).toBeNull();
  });
  test("dust below the output floor plus fee is ignored", () => {
    // fee at 2 sat/vB is 244; floor is max(546 + 244, 10 * 244) = 2440
    expect(pickUtxo([u(2_439)], cap, 2)).toBeNull();
    expect(pickUtxo([u(2_440)], cap, 2)?.value_sat).toBe(2_440);
    expect(pickUtxo([u(100), u(30_000)], cap, 2)?.value_sat).toBe(30_000);
  });
  test("a tie goes to the lower txid, so the choice is stable", () => {
    expect(pickUtxo([u(5_000, "bb".repeat(32)), u(5_000, "aa".repeat(32))], cap, 1)?.txid).toBe("aa".repeat(32));
  });
});

describe("assembleSigned", () => {
  const { hex, legacy } = unsignedTx();
  const sh = bytesToHex(sighash(PUB, 341_067));
  const sig = sign(hexToBytes(sh));

  test("inserts marker, flag and the witness; the txid does not change", () => {
    const signed = assembleSigned(hex, sig, bytesToHex(PUB), sh);
    const b = hexToBytes(signed);
    expect(bytesToHex(b.slice(0, 6))).toBe("020000000001"); // version, marker, flag
    expect(bytesToHex(b.slice(6, 6 + legacy.length - 8))).toBe(bytesToHex(legacy.slice(4, -4))); // inputs and outputs untouched
    expect(bytesToHex(b.slice(-4))).toBe("00000000"); // locktime
    expect(bytesToHex(b.slice(-4 - 34, -4))).toBe("21" + bytesToHex(PUB)); // last witness item: the 33-byte key
    expect(b[6 + legacy.length - 8]).toBe(2); // two witness items
    expect(txidOfSigned(signed)).toBe(txidOfLegacy(hex));
  });

  test("the DER signature in the witness verifies against the key", () => {
    const b = hexToBytes(assembleSigned(hex, sig, bytesToHex(PUB), sh));
    const at = 6 + legacy.length - 8 + 1; // after the witness item count
    const sigLen = b[at]!;
    const d = b.slice(at + 1, at + 1 + sigLen);
    expect(d[sigLen - 1]).toBe(1); // SIGHASH_ALL
    const parsed = secp256k1.Signature.fromDER(bytesToHex(d.slice(0, -1)));
    expect(secp256k1.verify(parsed, hexToBytes(sh), PUB, { prehash: false })).toBe(true);
  });

  test("a signature over another digest throws", () => {
    expect(() => assembleSigned(hex, sign(hexToBytes("00".repeat(31) + "01")), bytesToHex(PUB), sh)).toThrow("does not verify");
  });
  test("a false input amount gives a digest the signature does not cover (BIP-143)", () => {
    expect(() => assembleSigned(hex, sig, bytesToHex(PUB), bytesToHex(sighash(PUB, 341_000)))).toThrow("does not verify");
  });
  test("a signature by another key throws", () => {
    const other = secp256k1.getPublicKey(hexToBytes("22".repeat(32)), true);
    expect(() => assembleSigned(hex, sig, bytesToHex(other), sh)).toThrow("does not verify");
  });
  test("a high-s signature is normalised, not refused", () => {
    const high = { ...sig, s: (secp256k1.CURVE.n - BigInt("0x" + sig.s)).toString(16).padStart(64, "0") };
    expect(assembleSigned(hex, high, bytesToHex(PUB), sh)).toBe(assembleSigned(hex, sig, bytesToHex(PUB), sh));
  });
  test("malformed pieces throw", () => {
    expect(() => assembleSigned(hex, { ...sig, bigR: "02" + "00".repeat(10) }, bytesToHex(PUB), sh)).toThrow();
    expect(() => assembleSigned(hex, sig, bytesToHex(PUB), "00")).toThrow();
  });
});

describe("mempool client", () => {
  const BASE = "https://mempool.test/testnet4/api";
  function fake(handler: (url: string, init?: RequestInit) => Response) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => (calls.push({ url, init }), handler(url, init))) as unknown as typeof fetch;
    return { f, calls };
  }
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });

  test("getUtxos keeps confirmed outputs only", async () => {
    const { f, calls } = fake(() => json([{ txid: "a".repeat(64), vout: 1, value: 5000, status: { confirmed: true } }, { txid: "b".repeat(64), vout: 0, value: 9000, status: { confirmed: false } }]));
    expect(await makeBtc({ fetch: f, base: BASE }).getUtxos(TIER_ADDR)).toEqual([{ txid: "a".repeat(64), vout: 1, value_sat: 5000 }]);
    expect(calls[0]!.url).toBe(`${BASE}/address/${TIER_ADDR}/utxo`);
  });
  test("feeRate is halfHourFee, rounded up and capped at 200", async () => {
    const rate = (x: unknown) => makeBtc({ fetch: fake(() => json(x)).f, base: BASE }).feeRate();
    expect(await rate({ fastestFee: 9, halfHourFee: 2.1, hourFee: 1 })).toBe(3);
    expect(await rate({ halfHourFee: 900 })).toBe(200);
    await expect(rate({})).rejects.toThrow();
  });
  test("broadcast posts the hex as text/plain and returns the txid", async () => {
    const { f, calls } = fake(() => new Response("ab".repeat(32) + "\n"));
    expect(await makeBtc({ fetch: f, base: BASE }).broadcast("0200")).toBe("ab".repeat(32));
    const init = calls[0]!.init!;
    expect(calls[0]!.url).toBe(`${BASE}/tx`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("text/plain");
    expect(init.body).toBe("0200");
  });
  test("a refusal throws BroadcastError with the node's reason", async () => {
    const b = makeBtc({ fetch: fake(() => new Response("min relay fee not met", { status: 400 })).f, base: BASE });
    await expect(b.broadcast("0200")).rejects.toBeInstanceOf(BroadcastError);
  });
  test("a tx the network already has counts as sent", async () => {
    const { hex } = unsignedTx();
    const sh = bytesToHex(sighash(PUB, 341_067));
    const signed = assembleSigned(hex, sign(hexToBytes(sh)), bytesToHex(PUB), sh);
    for (const msg of ["txn-already-in-mempool", "Transaction already in block chain"]) {
      const b = makeBtc({ fetch: fake(() => new Response(msg, { status: 400 })).f, base: BASE });
      expect(await b.broadcast(signed)).toBe(txidOfLegacy(hex));
    }
  });
});

describe("the S1 transaction (item 13)", () => {
  test("the rebuilt unsigned layout has the txid of the transaction that confirmed on testnet4", () => {
    expect(txidOfLegacy(unsignedTx().hex)).toBe("a8ecea7c06b387f86349322cf025233c3f170e69a2a31f27e274e70ae89e8b1a");
  });
});

describe("inputsOf", () => {
  test("names the coin an unsigned or signed tx spends, in the txid:vout the UTXO list uses", () => {
    const { hex } = unsignedTx();
    const sh = bytesToHex(sighash(PUB, 341_067));
    const signed = assembleSigned(hex, sign(hexToBytes(sh)), bytesToHex(PUB), sh);
    expect(inputsOf(hex)).toEqual(["b7a37d34906d713f2436c3992495118f06a59f26f6acdcb3c5d3224959048bd1:0"]);
    expect(inputsOf(signed)).toEqual(inputsOf(hex));
  });
});

describe("pickUtxo with coins already spent by a stored tx", () => {
  test("an excluded coin is skipped even when it is the largest", () => {
    const coins = [u(900_000, "cc".repeat(32)), u(500_000, "dd".repeat(32))];
    expect(pickUtxo(coins, 2_000_000n, 2, new Set(["cc".repeat(32) + ":0"]))?.txid).toBe("dd".repeat(32));
    expect(pickUtxo(coins, 2_000_000n, 2, new Set(coins.map(c => `${c.txid}:0`)))).toBeNull();
  });
});

describe("broadcasting a tx that already confirmed (item 6)", () => {
  const BASE = "https://mempool.test/testnet4/api";
  const { hex } = unsignedTx();
  const sh = bytesToHex(sighash(PUB, 341_067));
  const signed = assembleSigned(hex, sign(hexToBytes(sh)), bytesToHex(PUB), sh);
  const TXID = txidOfLegacy(hex);
  const spent = "sendrawtransaction RPC error: {\"code\":-25,\"message\":\"bad-txns-inputs-missingorspent\"}";
  function net(status: () => Response) {
    const urls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return url.endsWith("/tx") ? new Response(spent, { status: 400 }) : status();
    }) as unknown as typeof fetch;
    return { b: makeBtc({ fetch: f, base: BASE }), urls };
  }
  test("the tx is confirmed: it counts as sent, with the txid computed from the hex", async () => {
    const n = net(() => new Response(JSON.stringify({ confirmed: true, block_height: 158586 })));
    expect(await n.b.broadcast(signed)).toBe(TXID);
    expect(n.urls).toEqual([`POST ${BASE}/tx`, `GET ${BASE}/tx/${TXID}/status`]);
  });
  test("the tx is unknown (404), or known but unconfirmed, or the lookup fails: still a failure", async () => {
    for (const st of [() => new Response("Transaction not found", { status: 404 }), () => new Response(JSON.stringify({ confirmed: false })), () => { throw new Error("down"); }]) {
      await expect(net(st).b.broadcast(signed)).rejects.toBeInstanceOf(BroadcastError);
    }
  });
});
