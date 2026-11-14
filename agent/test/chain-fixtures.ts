// Shared by the chain tests: the S1 payout rebuilt (input b7a37d34...:0, 340,847 sats to the faucet's return address), a BIP-143
// digest written out independently of src/, and a test key that stands in for the MPC's tier key.
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import { base58, bech32 } from "@scure/base";
import { tierAddress } from "../src/chain/btc";

const dsha = (b: Uint8Array) => sha256(sha256(b));
// ---- the S1 payout, rebuilt: input b7a37d34...:0, one output of 340,847 sats to the faucet's return address ----
export const PAYEE = "tb1qerzrlxcfu24davlur5sqmgzzgsal6wusda40er";
export const FUND_TXID = "b7a37d34906d713f2436c3992495118f06a59f26f6acdcb3c5d3224959048bd1";
const le = (n: number, bytes: number) => hexToBytes(n.toString(16).padStart(bytes * 2, "0")).reverse();
const spk = (addr: string) => concatBytes(Uint8Array.of(0, 20), bech32.fromWords(bech32.decode(addr as `${string}1${string}`).words.slice(1)));
export function unsignedTx(): { hex: string; legacy: Uint8Array } {
  const out = spk(PAYEE);
  const legacy = concatBytes(le(2, 4), Uint8Array.of(1), hexToBytes(FUND_TXID).reverse(), le(0, 4), Uint8Array.of(0), hexToBytes("fdffffff"), Uint8Array.of(1), le(340_847, 8), Uint8Array.of(out.length), out, le(0, 4));
  return { hex: bytesToHex(legacy), legacy };
}
// BIP-143 for a P2WPKH input, written out here so the code under test is not its own oracle.
export function sighash(pubkey: Uint8Array, value: number): Uint8Array {
  const out = spk(PAYEE);
  const outpoint = concatBytes(hexToBytes(FUND_TXID).reverse(), le(0, 4));
  const outputs = concatBytes(le(340_847, 8), Uint8Array.of(out.length), out);
  const scriptCode = concatBytes(hexToBytes("1976a914"), ripemd160(sha256(pubkey)), hexToBytes("88ac"));
  return dsha(concatBytes(le(2, 4), dsha(outpoint), dsha(hexToBytes("fdffffff")), outpoint, scriptCode, le(value, 8), hexToBytes("fdffffff"), dsha(outputs), le(0, 4), le(1, 4)));
}
export const PRIV = hexToBytes("11".repeat(32));
export const PUB = secp256k1.getPublicKey(PRIV, true);
export function sign(msg: Uint8Array) {
  const s = secp256k1.sign(msg, PRIV, { prehash: false, lowS: true });
  return { bigR: "02" + s.r.toString(16).padStart(64, "0"), s: s.s.toString(16).padStart(64, "0") };
}


/** The key v1.signer would return for PRIV, and the tier address it gives. */
export const TEST_DERIVED = "secp256k1:" + base58.encode(secp256k1.getPublicKey(PRIV, false).slice(1));
export const TEST_TIER_ADDR = tierAddress(TEST_DERIVED, "tb");
