// NEP-413 helpers shared by the agent and the web app. Runs in browsers: no node: imports, no Buffer.
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes } from "@noble/hashes/utils";

export const LOGIN_MESSAGE = "bulkhead-login";
export const LOGIN_RECIPIENT = "bulkhead";

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
// callbackUrl is Option<string>: undefined is None (one 0 byte), a string is Some (a 1 byte, then a borsh string).
export function nep413Hash(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  const callback = p.callbackUrl === undefined ? Uint8Array.of(0) : concatBytes(Uint8Array.of(1), borshString(p.callbackUrl));
  return sha256(concatBytes(u32le(TAG), borshString(p.message), p.nonce, borshString(p.recipient), callback));
}
