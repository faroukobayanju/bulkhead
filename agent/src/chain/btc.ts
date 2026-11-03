// Bitcoin side of a payout: the tier address, UTXO choice, signature injection (spike S1) and the mempool.space client.
// The contract builds the one-input one-output tx and has the MPC sign its BIP-143 digest; this file only finishes it.
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import { base58, bech32 } from "@scure/base";
import type { Hrp } from "../address";

export type Utxo = { txid: string; vout: number; value_sat: number };
export type Sig = { bigR: string; s: string }; // hex: big_r.affine_point (33 bytes) and s.scalar (32 bytes) from `release_signed`

export const MAX_FEE_RATE = 200; // the contract's cap (btc.rs MAX_FEE_RATE_SAT_VB)
const DUST = 546;
const OUT_VSIZE = 122; // 88 + the longest output script (P2WSH / P2TR); a P2WPKH payee needs 110

export class BroadcastError extends Error {
  constructor(public status: number, public body: string) {
    super(`btc broadcast failed: ${status} ${body.slice(0, 200)}`);
    this.name = "BroadcastError";
  }
}

const N = secp256k1.CURVE.n;
const dsha = (b: Uint8Array) => sha256(sha256(b));
const rev = (b: Uint8Array) => Uint8Array.from(b).reverse();

// ---- tier address ----

/** Compressed SEC1 key from v1.signer's `secp256k1:<base58 of x||y>`. */
export function tierPubkey(derived: string): Uint8Array {
  const [scheme, body] = derived.split(":");
  if (scheme !== "secp256k1" || !body) throw new Error("expected a secp256k1:... key");
  const raw = base58.decode(body);
  if (raw.length !== 64) throw new Error(`expected 64 key bytes, got ${raw.length}`);
  return secp256k1.ProjectivePoint.fromHex(concatBytes(Uint8Array.of(4), raw)).toRawBytes(true); // throws when off the curve
}

export function tierAddress(derived: string, hrp: Hrp): string {
  return bech32.encode(hrp, [0, ...bech32.toWords(ripemd160(sha256(tierPubkey(derived))))]);
}

// ---- UTXO choice (E14) ----

/** The largest confirmed UTXO that is at most `maxRelease` and big enough to pay the fee and leave a non-dust output.
 *  The contract also wants fee * 10 <= value, so that is the floor. Dust sent to the tier later is ignored. */
export function pickUtxo(utxos: Utxo[], maxRelease: bigint, feeRate: number): Utxo | null {
  const fee = OUT_VSIZE * feeRate;
  const floor = Math.max(DUST + fee, fee * 10);
  let best: Utxo | null = null;
  for (const u of utxos) {
    if (BigInt(u.value_sat) > maxRelease || u.value_sat < floor) continue;
    if (!best || u.value_sat > best.value_sat || (u.value_sat === best.value_sat && u.txid < best.txid)) best = u;
  }
  return best;
}

// ---- signature injection ----

function der(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint) => {
    let b = hexToBytes(v.toString(16).padStart(64, "0"));
    while (b.length > 1 && b[0] === 0) b = b.slice(1);
    return b[0]! & 0x80 ? concatBytes(Uint8Array.of(0), b) : b;
  };
  const [rb, sb] = [int(r), int(s)];
  const body = concatBytes(Uint8Array.of(2, rb.length), rb, Uint8Array.of(2, sb.length), sb);
  return concatBytes(Uint8Array.of(0x30, body.length), body);
}

/** Legacy-layout unsigned one-input tx -> segwit tx with witness [DER(r,s)||01, pubkey]. Throws unless the signature verifies
 *  against `pubkey` (33-byte hex) over `sighash` (the 32-byte digest, no further hashing): recovery would return some key for any
 *  bad signature, and a tx that cannot verify must never reach the mempool. */
export function assembleSigned(unsignedHex: string, sig: Sig, pubkey: string, sighash: string): string {
  const bigR = hexToBytes(sig.bigR);
  if (bigR.length !== 33) throw new Error("bad signature: big_r must be 33 bytes");
  const r = BigInt("0x" + bytesToHex(bigR.slice(1)));
  let s = BigInt("0x" + sig.s);
  if (hexToBytes(sig.s).length !== 32) throw new Error("bad signature: s must be 32 bytes");
  if (s > N >> 1n) s = N - s; // relay policy wants low-s; the other half is the same signature
  const msg = hexToBytes(sighash);
  const pk = hexToBytes(pubkey);
  const ok = msg.length === 32 && pk.length === 33 && secp256k1.verify(concatBytes(hexToBytes(r.toString(16).padStart(64, "0")), hexToBytes(s.toString(16).padStart(64, "0"))), msg, pk, { prehash: false });
  if (!ok) throw new Error("signature does not verify against the tier key");
  const tx = hexToBytes(unsignedHex);
  if (tx.length < 12) throw new Error("unsigned tx too short");
  const w = concatBytes(der(r, s), Uint8Array.of(1)); // SIGHASH_ALL
  const witness = concatBytes(Uint8Array.of(2, w.length), w, Uint8Array.of(pk.length), pk);
  return bytesToHex(concatBytes(tx.slice(0, 4), Uint8Array.of(0, 1), tx.slice(4, -4), witness, tx.slice(-4)));
}

/** txid of a legacy-layout (no witness) tx. */
export const txidOfLegacy = (hex: string) => bytesToHex(rev(dsha(hexToBytes(hex))));

/** txid of a segwit tx: the hash of its bytes without marker, flag and witnesses. */
export function txidOfSigned(hex: string): string {
  const b = hexToBytes(hex);
  if (b[4] !== 0 || b[5] !== 1) return txidOfLegacy(hex);
  let p = 6;
  const varint = () => {
    const f = b[p++]!;
    if (f < 0xfd) return f;
    if (f === 0xfd) return (p += 2, b[p - 2]! | (b[p - 1]! << 8));
    throw new Error("tx too large");
  };
  const bodyStart = p;
  const nin = varint();
  const skip = (fixed: number) => {
    p += fixed;
    const n = varint(); // evaluated first: varint moves p
    p += n;
  };
  for (let i = 0; i < nin; i++) (skip(36), (p += 4));
  const nout = varint();
  for (let i = 0; i < nout; i++) skip(8);
  const bodyEnd = p;
  for (let i = 0; i < nin; i++) for (let n = varint(); n > 0; n--) skip(0);
  if (p + 4 !== b.length) throw new Error("not a tx this agent built");
  return bytesToHex(rev(dsha(concatBytes(b.slice(0, 4), b.slice(bodyStart, bodyEnd), b.slice(-4)))));
}

// ---- mempool.space ----

export function makeBtc(o: { fetch: typeof fetch; base: string; timeoutMs?: number }) {
  const t = () => AbortSignal.timeout(o.timeoutMs ?? 10_000);
  async function get(path: string): Promise<any> {
    const res = await o.fetch(`${o.base}${path}`, { signal: t() });
    if (!res.ok) throw new Error(`mempool GET ${path} failed: ${res.status}`);
    return res.json();
  }
  return {
    /** Confirmed outputs only: an unconfirmed one can vanish between the contract's call and the broadcast. */
    async getUtxos(addr: string): Promise<Utxo[]> {
      const rows = await get(`/address/${addr}/utxo`);
      if (!Array.isArray(rows)) throw new Error("mempool utxo: bad response");
      return rows.filter(r => r?.status?.confirmed === true).map(r => ({ txid: r.txid, vout: r.vout, value_sat: r.value }));
    },
    async feeRate(): Promise<number> {
      const f = (await get("/v1/fees/recommended"))?.halfHourFee;
      if (typeof f !== "number" || !(f > 0)) throw new Error("mempool fees: bad response");
      return Math.min(MAX_FEE_RATE, Math.ceil(f));
    },
    /** Returns the txid. A tx the network already has counts as sent, so a retry after a lost answer is safe. */
    async broadcast(hex: string): Promise<string> {
      // text/plain: the default form encoding gets "TX decode failed" (spike S1)
      const res = await o.fetch(`${o.base}/tx`, { method: "POST", headers: { "content-type": "text/plain" }, body: hex, signal: t() });
      const body = (await res.text()).trim();
      if (res.ok) return body;
      if (/already (in|known)|txn-already/i.test(body)) return txidOfSigned(hex);
      throw new BroadcastError(res.status, body);
    },
  };
}
export type Btc = ReturnType<typeof makeBtc>;
