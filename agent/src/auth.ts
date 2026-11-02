// NEP-413 login verification. Every field of `msg` is attacker-controlled, so malformed input returns a reason, never throws.
import { utils } from "near-api-js";
import { LOGIN_MESSAGE, LOGIN_RECIPIENT, makeNonce, nep413Hash } from "../../shared/nep413";

export { makeNonce, nep413Hash };

export type AuthMsg = {
  accountId: string;
  publicKey: string;
  signature: string; // base64, 64 bytes
  message: string;
  nonce: string; // base64, 32 bytes
  recipient: string;
  callbackUrl?: string; // signed by the wallet as Some(url) when present; part of the signed bytes, so safe to take from the client
};
export type AuthResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "replay" | "bad_sig" | "key_not_on_account" | "bad_recipient" };

const TTL_MS = 300_000;
const SKEW_MS = 60_000; // how far ahead of `now` a nonce timestamp may be
const MAX_CALLBACK_BYTES = 2048;
const ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;

// ponytail: in-memory replay set, single agent instance. A restart clears it, so a captured login can replay for up to
// 5 minutes (the nonce TTL) after one; move to Postgres with the rate limiter if the CVM ever restarts often or runs >1 replica
const used = new Map<string, number>(); // canonical base64 nonce -> last `now` at which it is still remembered
export const usedNonceCount = () => used.size;

const fail = (reason: Exclude<AuthResult, { ok: true }>["reason"]): AuthResult => ({ ok: false, reason });

// Strict standard base64 of exactly `len` bytes. Re-encoding must give the input back, so one byte string has one
// spelling; otherwise an alias of a used nonce would slip past the replay set.
function decode(s: unknown, len: number): Buffer | null {
  if (typeof s !== "string" || s.length !== Math.ceil(len / 3) * 4) return null;
  const b = Buffer.from(s, "base64");
  return b.length === len && b.toString("base64") === s ? b : null;
}

function ed25519Key(s: unknown) {
  try {
    const pk = utils.PublicKey.fromString(s as string); // throws on non-strings, bad base58, wrong size, unknown curve
    return pk.toString().startsWith("ed25519:") ? pk : null;
  } catch {
    return null;
  }
}

function verifies(pk: utils.PublicKey, hash: Uint8Array, sig: Uint8Array) {
  try {
    return pk.verify(hash, sig);
  } catch {
    return false;
  }
}

// A nonce stays in the set until TTL + skew after its timestamp, so replay protection covers the whole window in which
// it could still be accepted. Only successful logins add entries, so the set is as big as the logins of the last
// six minutes. ponytail: full scan per login; use an expiry-ordered queue if that ever gets large.
function prune(now: number) {
  for (const [id, until] of used) if (until < now) used.delete(id);
}

export async function verifyNep413(
  msg: AuthMsg,
  now: number,
  lookupKey: (accountId: string, publicKey: string) => Promise<boolean>,
): Promise<AuthResult> {
  const m = (msg ?? {}) as Partial<Record<keyof AuthMsg, unknown>>;
  if (m.recipient !== LOGIN_RECIPIENT) return fail("bad_recipient");
  if (m.message !== LOGIN_MESSAGE) return fail("bad_sig");

  const nonce = decode(m.nonce, 32);
  if (!nonce) return fail("bad_sig");
  const ts = Number(nonce.readBigUInt64BE(0));
  if (!(now - ts <= TTL_MS && ts - now <= SKEW_MS)) return fail("expired"); // phrased so a NaN `now` fails closed

  const sig = decode(m.signature, 64);
  const pk = ed25519Key(m.publicKey);
  const { accountId, callbackUrl } = m;
  if (!sig || !pk || typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) return fail("bad_sig");
  if (callbackUrl !== undefined && (typeof callbackUrl !== "string" || Buffer.byteLength(callbackUrl) > MAX_CALLBACK_BYTES))
    return fail("bad_sig");
  const hash = nep413Hash({ message: LOGIN_MESSAGE, nonce, recipient: LOGIN_RECIPIENT, callbackUrl });
  if (!verifies(pk, hash, sig)) return fail("bad_sig");

  // A rejection here (RPC down) propagates: the caller must not tell the user their key is wrong, and the nonce stays unused.
  if (!(await lookupKey(accountId, pk.toString()))) return fail("key_not_on_account");

  // Check and mark with no await in between, so concurrent calls with the same message cannot both pass.
  prune(now);
  const id = m.nonce as string; // canonical: decode() checked it
  if (used.has(id)) return fail("replay");
  used.set(id, ts + TTL_MS + SKEW_MS);
  return { ok: true };
}
