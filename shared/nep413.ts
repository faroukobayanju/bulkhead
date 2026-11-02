// NEP-413 helpers shared by the agent and the web app. Runs in browsers: no node: imports, no Buffer.
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes } from "@noble/hashes/utils";

export const LOGIN_MESSAGE = "drainme-login";
export const LOGIN_RECIPIENT = "drainme.app";

const TAG = 2147484061; // 2^31 + 413
const utf8 = new TextEncoder();

const u32le = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const borshString = (s: string) => {
  const b = utf8.encode(s);
  return concatBytes(u32le(b.length), b);
};

// First 8 bytes: big-endian millisecond timestamp. Last 24: random.
export function makeNonce(ms: number): Uint8Array {
  const nonce = new Uint8Array(32);
  new DataView(nonce.buffer).setBigUint64(0, BigInt(Math.floor(ms)));
  crypto.getRandomValues(nonce.subarray(8));
  return nonce;
}

// sha256(u32le tag ++ borsh{ message, nonce, recipient, callbackUrl }), the bytes a NEP-413 wallet signs.
// ponytail: callbackUrl is always None; add an optional field if a wallet flow ever signs one.
export function nep413Hash(p: { message: string; nonce: Uint8Array; recipient: string }): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  return sha256(concatBytes(u32le(TAG), borshString(p.message), p.nonce, borshString(p.recipient), Uint8Array.of(0)));
}
