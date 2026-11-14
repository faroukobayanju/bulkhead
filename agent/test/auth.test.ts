import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { KeyPair, utils } from "near-api-js";
import { verifyNep413, makeNonce, nep413Hash, usedNonceCount, type AuthMsg } from "../src/auth";
import * as shared from "../../shared/nep413";
import { LOGIN_MESSAGE, LOGIN_RECIPIENT } from "../../shared/nep413";

const kp = KeyPair.fromRandom("ed25519");
const pub = kp.getPublicKey().toString();
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const keyOk = async () => true;
const sign = (message: string, nonce: Uint8Array, recipient = LOGIN_RECIPIENT, key = kp) =>
  b64(key.sign(nep413Hash({ message, nonce, recipient })).signature);
// A valid login for `nonce`; `over` replaces fields, including with malformed values.
const msgFor = (nonce: Uint8Array, over: Record<string, unknown> = {}) =>
  ({ accountId: "a.near", publicKey: pub, signature: sign(LOGIN_MESSAGE, nonce), message: LOGIN_MESSAGE, nonce: b64(nonce), recipient: LOGIN_RECIPIENT, ...over }) as AuthMsg;
const login = (now: number, over: Record<string, unknown> = {}) => msgFor(makeNonce(now), over);
const spy = () => {
  const calls: [string, string][] = [];
  return { calls, lookup: async (a: string, p: string) => (calls.push([a, p]), true) };
};

describe("verifyNep413", () => {
  test("valid signature passes", async () => {
    const now = Date.now();
    expect(await verifyNep413(login(now), now, keyOk)).toEqual({ ok: true });
  });

  test("expired after 5 minutes, valid at exactly 5 minutes", async () => {
    const now = Date.now();
    expect(await verifyNep413(login(now - 300_001), now, keyOk)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyNep413(login(now - 300_000), now, keyOk)).toEqual({ ok: true });
  });

  test("a nonce more than 60 s ahead of now is expired", async () => {
    const now = Date.now();
    expect(await verifyNep413(login(now + 60_001), now, keyOk)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyNep413(login(now + 60_000), now, keyOk)).toEqual({ ok: true });
    expect(await verifyNep413(login(Number.MAX_SAFE_INTEGER), now, keyOk)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyNep413(login(0), now, keyOk)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyNep413(login(now), NaN, keyOk)).toEqual({ ok: false, reason: "expired" }); // a broken clock fails closed
  });

  test("replay rejected", async () => {
    const now = Date.now();
    const m = login(now);
    await verifyNep413(m, now, keyOk);
    expect(await verifyNep413(m, now, keyOk)).toEqual({ ok: false, reason: "replay" });
  });

  test("key not on account rejected", async () => {
    const now = Date.now();
    expect(await verifyNep413(login(now), now, async () => false)).toEqual({ ok: false, reason: "key_not_on_account" });
  });

  test("wrong recipient rejected", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    const m = msgFor(nonce, { recipient: "evil.app", signature: sign(LOGIN_MESSAGE, nonce, "evil.app") });
    expect(await verifyNep413(m, now, keyOk)).toEqual({ ok: false, reason: "bad_recipient" });
  });

  test("a signature for another message does not log anyone in", async () => {
    const now = Date.now();
    for (const message of ["send-all-my-funds", "bulkhead-login ", "BULKHEAD-LOGIN", ""]) {
      const nonce = makeNonce(now);
      const m = msgFor(nonce, { message, signature: sign(message, nonce) });
      expect(await verifyNep413(m, now, keyOk)).toEqual({ ok: false, reason: "bad_sig" });
    }
  });

  test("signature by another key, over another nonce, or with a flipped bit is bad_sig", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    const other = KeyPair.fromRandom("ed25519");
    const flipped = Buffer.from(sign(LOGIN_MESSAGE, nonce), "base64");
    flipped[10] ^= 1;
    for (const signature of [sign(LOGIN_MESSAGE, nonce, LOGIN_RECIPIENT, other), sign(LOGIN_MESSAGE, makeNonce(now)), b64(flipped)])
      expect(await verifyNep413(msgFor(nonce, { signature }), now, keyOk)).toEqual({ ok: false, reason: "bad_sig" });
    // same signature, different public key
    const m = msgFor(nonce, { publicKey: other.getPublicKey().toString() });
    expect(await verifyNep413(m, now, keyOk)).toEqual({ ok: false, reason: "bad_sig" });
  });

  test("a secp256k1 key is refused even with a valid secp256k1 signature", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    const sk = KeyPair.fromRandom("secp256k1");
    const hash = nep413Hash({ message: LOGIN_MESSAGE, nonce, recipient: LOGIN_RECIPIENT });
    const sig = sk.sign(hash).signature.slice(0, 64);
    expect(sk.getPublicKey().verify(hash, sig)).toBe(true); // the signature really is valid for that key
    const m = msgFor(nonce, { publicKey: sk.getPublicKey().toString(), signature: b64(sig) });
    expect(await verifyNep413(m, now, keyOk)).toEqual({ ok: false, reason: "bad_sig" });
  });
});

// A wallet that redirects (MyNearWallet through wallet-selector) signs Some(callbackUrl). The URL is part of the signed
// bytes, so taking it from the client cannot be used to forge anything.
describe("callbackUrl", () => {
  const url = "https://app.mynearwallet.com/login?next=%2Ftier%2F1";
  const signCb = (nonce: Uint8Array, callbackUrl?: string, key = kp) =>
    b64(key.sign(nep413Hash({ message: LOGIN_MESSAGE, nonce, recipient: LOGIN_RECIPIENT, callbackUrl })).signature);
  const withUrl = (nonce: Uint8Array, callbackUrl: unknown, signature = signCb(nonce, callbackUrl as string)) =>
    msgFor(nonce, { callbackUrl, signature });
  const bad = { ok: false, reason: "bad_sig" } as const;
  const sized = (bytes: number) => "https://x.test/" + "a".repeat(bytes - 15);

  test("a signature over the URL passes", async () => {
    const now = Date.now();
    const { calls, lookup } = spy();
    expect(await verifyNep413(withUrl(makeNonce(now), url), now, lookup)).toEqual({ ok: true });
    expect(calls).toEqual([["a.near", pub]]);
  });

  test("the signed URL swapped for another fails, and does not burn the nonce", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    const before = usedNonceCount();
    expect(await verifyNep413(withUrl(nonce, "https://evil.example/login", signCb(nonce, url)), now, keyOk)).toEqual(bad);
    expect(usedNonceCount()).toBe(before);
    expect(await verifyNep413(withUrl(nonce, url), now, keyOk)).toEqual({ ok: true });
  });

  test("a signature made without the URL fails when one is supplied", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    expect(await verifyNep413(withUrl(nonce, url, signCb(nonce)), now, keyOk)).toEqual(bad);
  });

  test("a signature made with the URL fails when none is supplied", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    expect(await verifyNep413(msgFor(nonce, { signature: signCb(nonce, url) }), now, keyOk)).toEqual(bad);
  });

  test("an empty URL is Some(\"\"), not None", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    expect(await verifyNep413(withUrl(nonce, "", signCb(nonce)), now, keyOk)).toEqual(bad);
    expect(await verifyNep413(withUrl(nonce, ""), now, keyOk)).toEqual({ ok: true });
  });

  test.each([5, null, true, {}, [], ["https://x.test"]])("a URL that is %p is bad_sig", async callbackUrl => {
    const now = Date.now();
    const nonce = makeNonce(now);
    const { calls, lookup } = spy();
    expect(await verifyNep413(withUrl(nonce, callbackUrl, signCb(nonce)), now, lookup)).toEqual(bad);
    expect(await verifyNep413(withUrl(nonce, callbackUrl, signCb(nonce, url)), now, lookup)).toEqual(bad);
    expect(calls).toEqual([]);
  });

  test("up to 2048 bytes is accepted, more is bad_sig, counted in bytes", async () => {
    const now = Date.now();
    const { calls, lookup } = spy();
    const ok = [sized(2048), "é".repeat(1024)]; // the second is 1024 characters but 2048 bytes
    const tooBig = [sized(2049), "é".repeat(1025), "é".repeat(1024) + "a"];
    for (const u of ok) expect(await verifyNep413(withUrl(makeNonce(now), u), now, keyOk)).toEqual({ ok: true });
    for (const u of tooBig) expect(await verifyNep413(withUrl(makeNonce(now), u), now, lookup)).toEqual(bad);
    expect(calls).toEqual([]); // each was validly signed, so only the size limit refused it
  });
});

describe("check order", () => {
  test("recipient, message, nonce and expiry, signature, lookupKey, replay", async () => {
    const now = Date.now();
    const stale = makeNonce(now - 400_000);
    const v = (m: AuthMsg, lookup = keyOk) => verifyNep413(m, now, lookup);
    expect(await v(msgFor(stale, { recipient: "evil.app", message: "x", nonce: "!", signature: "!" }))).toEqual({ ok: false, reason: "bad_recipient" });
    expect(await v(msgFor(stale, { message: "x", nonce: "!", signature: "!" }))).toEqual({ ok: false, reason: "bad_sig" });
    expect(await v(msgFor(stale, { signature: "!", publicKey: "!" }))).toEqual({ ok: false, reason: "expired" });
    expect(await v(login(now, { signature: "!" }), async () => false)).toEqual({ ok: false, reason: "bad_sig" });
    const m = login(now);
    expect(await v(m)).toEqual({ ok: true });
    expect(await v(m, async () => false)).toEqual({ ok: false, reason: "key_not_on_account" });
    expect(await v(m)).toEqual({ ok: false, reason: "replay" });
  });
});

describe("malformed input never throws", () => {
  const now = Date.now();
  const nonce = makeNonce(now);
  const sig = Buffer.from(sign(LOGIN_MESSAGE, nonce), "base64");
  const bytes = (...parts: Uint8Array[]) => b64(Buffer.concat(parts));
  const key = (b: Uint8Array) => `ed25519:${utils.serialize.base_encode(b)}`;
  const cases: [string, Record<string, unknown>, string][] = [
    ["nonce with non-base64 characters", { nonce: "!!!!" + "A".repeat(40) }, "bad_sig"],
    ["empty nonce", { nonce: "" }, "bad_sig"],
    ["31-byte nonce", { nonce: bytes(nonce.slice(0, 31)) }, "bad_sig"],
    ["33-byte nonce", { nonce: bytes(nonce, Uint8Array.of(1)) }, "bad_sig"],
    ["nonce without padding", { nonce: b64(nonce).replace(/=+$/, "") }, "bad_sig"],
    ["nonce that is a number", { nonce: 5 }, "bad_sig"],
    ["nonce that is null", { nonce: null }, "bad_sig"],
    ["signature with non-base64 characters", { signature: "!".repeat(88) }, "bad_sig"],
    ["empty signature", { signature: "" }, "bad_sig"],
    ["63-byte signature", { signature: bytes(sig.subarray(0, 63)) }, "bad_sig"],
    ["65-byte signature", { signature: bytes(sig, Uint8Array.of(1)) }, "bad_sig"],
    ["signature that is a number", { signature: 5 }, "bad_sig"],
    ["signature that is null", { signature: null }, "bad_sig"],
    ["public key that is garbage", { publicKey: "not a key" }, "bad_sig"],
    ["empty public key", { publicKey: "" }, "bad_sig"],
    ["public key with no data", { publicKey: "ed25519:" }, "bad_sig"],
    ["public key that is too short", { publicKey: "ed25519:abc" }, "bad_sig"],
    ["public key with extra parts", { publicKey: `${pub}:abc` }, "bad_sig"],
    ["public key on an unknown curve", { publicKey: pub.replace("ed25519:", "rsa:") }, "bad_sig"],
    // The next two only show that odd keys do not throw. They end in bad_sig because the signature belongs to another
    // key, not because such keys are refused: small-order keys are not rejected, the key must already be on the account.
    ["all-zero public key, with another key's signature", { publicKey: key(new Uint8Array(32)) }, "bad_sig"],
    ["non-curve-point public key, with another key's signature", { publicKey: key(new Uint8Array(32).fill(0xff)) }, "bad_sig"],
    ["public key that is a number", { publicKey: 5 }, "bad_sig"],
    ["public key that is null", { publicKey: null }, "bad_sig"],
    ["account id that is a number", { accountId: 5 }, "bad_sig"],
    ["two-digit number as account id", { accountId: 55 }, "bad_sig"],
    ["missing account id", { accountId: undefined }, "bad_sig"],
    ["empty account id", { accountId: "" }, "bad_sig"],
    ["one-character account id", { accountId: "a" }, "bad_sig"],
    ["uppercase account id", { accountId: "A.NEAR" }, "bad_sig"],
    ["account id with a space", { accountId: "a b" }, "bad_sig"],
    ["account id with a trailing newline", { accountId: "a.near\n" }, "bad_sig"],
    ["65-character account id", { accountId: "a".repeat(65) }, "bad_sig"],
    ["100,000-character account id", { accountId: "a".repeat(100_000) }, "bad_sig"],
    ["message that is a number", { message: 5 }, "bad_sig"],
    ["recipient that is a number", { recipient: 5 }, "bad_recipient"],
    ["missing recipient", { recipient: undefined }, "bad_recipient"],
  ];
  for (const [name, over, reason] of cases)
    test(name, async () => {
      const { calls, lookup } = spy();
      const before = usedNonceCount();
      expect(await verifyNep413(msgFor(nonce, over), now, lookup)).toEqual({ ok: false, reason: reason as "bad_sig" });
      expect(calls).toEqual([]);
      expect(usedNonceCount()).toBe(before);
    });

  test.each(["ab", "a".repeat(64), "a.b-c_d0", "0x" + "ab".repeat(20)])("account id %p is accepted", async accountId => {
    const { calls, lookup } = spy();
    const n = makeNonce(now);
    expect(await verifyNep413(msgFor(n, { accountId }), now, lookup)).toEqual({ ok: true });
    expect(calls).toEqual([[accountId, pub]]);
  });

  test.each([null, undefined, "login", 42, [], {}])("message that is %p", async m => {
    const r = await verifyNep413(m as unknown as AuthMsg, now, keyOk);
    expect(r.ok).toBe(false);
  });
});

describe("lookupKey", () => {
  test("gets the account id and the canonical ed25519 key string", async () => {
    const now = Date.now();
    const { calls, lookup } = spy();
    expect(await verifyNep413(login(now, { publicKey: pub.replace("ed25519:", "") }), now, lookup)).toEqual({ ok: true });
    expect(calls).toEqual([["a.near", pub]]);
  });

  test("is not called when an earlier check failed", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    const { calls, lookup } = spy();
    const other = KeyPair.fromRandom("ed25519");
    for (const m of [
      msgFor(nonce, { recipient: "evil.app" }),
      msgFor(nonce, { message: "x" }),
      login(now - 400_000),
      msgFor(nonce, { signature: sign(LOGIN_MESSAGE, nonce, LOGIN_RECIPIENT, other) }),
    ])
      await verifyNep413(m, now, lookup);
    expect(calls).toEqual([]);
  });

  test("answering false, or a bad signature, does not burn the nonce", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    const before = usedNonceCount();
    const forged = msgFor(nonce, { signature: sign(LOGIN_MESSAGE, nonce, LOGIN_RECIPIENT, KeyPair.fromRandom("ed25519")) });
    expect(await verifyNep413(forged, now, keyOk)).toEqual({ ok: false, reason: "bad_sig" });
    expect(await verifyNep413(msgFor(nonce), now, async () => false)).toEqual({ ok: false, reason: "key_not_on_account" });
    expect(usedNonceCount()).toBe(before);
    expect(await verifyNep413(msgFor(nonce), now, keyOk)).toEqual({ ok: true });
  });

  test("a rejecting lookup rejects verifyNep413 and does not burn the nonce", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    const before = usedNonceCount();
    const down = async () => {
      throw new Error("rpc down");
    };
    await expect(verifyNep413(msgFor(nonce), now, down)).rejects.toThrow("rpc down");
    expect(usedNonceCount()).toBe(before);
    expect(await verifyNep413(msgFor(nonce), now, keyOk)).toEqual({ ok: true });
  });
});

describe("replay protection", () => {
  // Lookups that resolve in the same tick, after a few microtasks, or on separate timers: the first two interleave
  // the continuations after `await lookupKey`, which is where an await between check and mark would let two through.
  const lookups: [string, () => Promise<boolean>][] = [
    ["same tick", async () => true],
    ["a few microtasks", async () => {
      for (let i = 0; i < 5; i++) await null;
      return true;
    }],
    ["separate timers", async () => {
      await new Promise(r => setTimeout(r, Math.random() * 10));
      return true;
    }],
  ];
  for (const [name, lookup] of lookups)
    test(`concurrent logins with the same message: exactly one succeeds (${name})`, async () => {
      const now = Date.now();
      const m = login(now);
      const rs = await Promise.all(Array.from({ length: 8 }, () => verifyNep413(m, now, lookup)));
      expect(rs.filter(r => r.ok).length).toBe(1);
      expect(rs.filter(r => !r.ok)).toEqual(Array(7).fill({ ok: false, reason: "replay" }));
    });

  test("a non-canonical base64 spelling of a used nonce is not a new nonce", async () => {
    const now = Date.now();
    const nonce = makeNonce(now);
    const s = b64(nonce); // 44 chars; the 3rd char of the last group carries 2 spare bits, zero when canonical
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const alias = s.slice(0, 42) + alphabet[alphabet.indexOf(s[42]) | 1] + "=";
    expect(alias).not.toBe(s);
    expect(Buffer.from(alias, "base64").equals(nonce)).toBe(true); // a lenient decoder sees the same 32 bytes
    const m = msgFor(nonce);
    expect(await verifyNep413(m, now, keyOk)).toEqual({ ok: true });
    expect(await verifyNep413({ ...m, nonce: alias }, now, keyOk)).toEqual({ ok: false, reason: "bad_sig" });
  });

  test("a used nonce is remembered for the whole acceptance window, then pruned", async () => {
    const T = Date.now() + 10 * 365 * 24 * 3600_000; // far ahead, so every nonce from earlier tests is already prunable
    const m = login(T);
    expect(await verifyNep413(m, T, keyOk)).toEqual({ ok: true });
    expect(usedNonceCount()).toBe(1);
    expect(await verifyNep413(m, T + 300_000, keyOk)).toEqual({ ok: false, reason: "replay" });
    expect(await verifyNep413(m, T + 300_001, keyOk)).toEqual({ ok: false, reason: "expired" });
    // the entry survives until TTL + 60 s skew have passed
    expect(await verifyNep413(login(T + 360_000), T + 360_000, keyOk)).toEqual({ ok: true });
    expect(usedNonceCount()).toBe(2);
    expect(await verifyNep413(login(T + 360_001), T + 360_001, keyOk)).toEqual({ ok: true });
    expect(usedNonceCount()).toBe(2); // m is gone, the other two stay
  });
});

describe("NEP-413 hash and nonce", () => {
  const sha = (payloadHex: string) => createHash("sha256").update(Buffer.from(payloadHex, "hex")).digest("hex");
  const ascending = Uint8Array.from({ length: 32 }, (_, i) => i);

  // Bytes spelled out by hand: u32 LE tag 2147484061 (2^31 + 413), then borsh message (u32 LE byte length + UTF-8),
  // nonce [u8;32], borsh recipient, and one zero byte for callbackUrl: None. Digests come from Python's hashlib,
  // and the first also matches the borsh library near-api-js uses.
  test("matches the NEP-413 byte layout", () => {
    const payload =
      "9d010080" +
      "0e000000" + "62756c6b686561642d6c6f67696e" +
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
      "08000000" + "62756c6b68656164" +
      "00";
    const digest = "03190da9ff559e9345b31b7c0b9ea1ef8561652b870fa2550ad39f97ff83974a";
    expect(sha(payload)).toBe(digest);
    expect(hex(nep413Hash({ message: "bulkhead-login", nonce: ascending, recipient: "bulkhead" }))).toBe(digest);
  });

  // The Borsh spec prefixes strings with their UTF-8 byte length (10 here, not the 7 UTF-16 units).
  // borsh-js 1.0.0 gets this wrong for non-ASCII, which cannot matter for login: message and recipient are ASCII constants.
  test("prefixes strings with their UTF-8 byte length", () => {
    const payload =
      "9d010080" +
      "0a000000" + "68c3a96c6c6f20e29c93" +
      "fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e0" +
      "10000000" + "62756c6b686561642e6578616d706c65" +
      "00";
    const digest = "ec324e81ad6738b25881ca41f35c4a6bf2f53845431fb81d644d77b5bb78da2e";
    expect(sha(payload)).toBe(digest);
    const nonce = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    expect(hex(nep413Hash({ message: "héllo ✓", nonce, recipient: "bulkhead.example" }))).toBe(digest);
  });

  // callbackUrl: Option<string>. Some is the byte 01 followed by a borsh string. Digests from Python's hashlib; the
  // borsh library gives the same bytes for both URLs.
  test("encodes a callbackUrl as Option Some", () => {
    const payload =
      "9d010080" +
      "0e000000" + "62756c6b686561642d6c6f67696e" +
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
      "08000000" + "62756c6b68656164" +
      "01" + "1f000000" + "68747470733a2f2f62756c6b686561642e6578616d706c652f746965722f32"; // "https://bulkhead.example/tier/2"
    const digest = "7de7da606690bbc70facfe1e2bb4b66018ef84ceca7470fbeb331c00c6ed9d29";
    expect(sha(payload)).toBe(digest);
    const p = { message: "bulkhead-login", nonce: ascending, recipient: "bulkhead" };
    expect(hex(nep413Hash({ ...p, callbackUrl: "https://bulkhead.example/tier/2" }))).toBe(digest);
    expect(hex(nep413Hash({ ...p, callbackUrl: "https://app.mynearwallet.com/login?next=%2Ftier%2F1" }))).toBe(
      "1e54e311ad96e297d6b68c76f82ab8902af34a731d52717e4be029bed086ffdf",
    );
  });

  test("an absent or undefined callbackUrl is still None", () => {
    const none = "03190da9ff559e9345b31b7c0b9ea1ef8561652b870fa2550ad39f97ff83974a";
    const p = { message: "bulkhead-login", nonce: ascending, recipient: "bulkhead" };
    expect(hex(nep413Hash(p))).toBe(none);
    expect(hex(nep413Hash({ ...p, callbackUrl: undefined }))).toBe(none);
    expect(hex(nep413Hash({ ...p, callbackUrl: "" }))).not.toBe(none); // Some("") is not None
  });

  test("refuses a nonce that is not 32 bytes", () => {
    expect(() => nep413Hash({ message: "m", nonce: new Uint8Array(31), recipient: "r" })).toThrow();
  });

  test("makeNonce is a 32-byte big-endian millisecond timestamp plus 24 random bytes", () => {
    const ms = 1_700_000_123_456;
    const a = makeNonce(ms);
    const b = makeNonce(ms);
    expect(a.length).toBe(32);
    expect(Number(new DataView(a.buffer, a.byteOffset).getBigUint64(0))).toBe(ms);
    expect(hex(a.slice(0, 8))).toBe(ms.toString(16).padStart(16, "0"));
    expect(hex(a.slice(8))).not.toBe(hex(b.slice(8)));
  });

  test("the shared helpers work without Buffer, as in a browser", () => {
    const { Buffer: saved } = globalThis;
    delete (globalThis as { Buffer?: unknown }).Buffer;
    let out: Uint8Array[] = [];
    try {
      const nonce = shared.makeNonce(1_700_000_000_000);
      out = [nonce, shared.nep413Hash({ message: shared.LOGIN_MESSAGE, nonce, recipient: shared.LOGIN_RECIPIENT })];
    } finally {
      globalThis.Buffer = saved;
    }
    expect(out.map(u => u.length)).toEqual([32, 32]);
  });

  test("agent/src/auth re-exports the shared helpers", () => {
    expect(makeNonce).toBe(shared.makeNonce);
    expect(nep413Hash).toBe(shared.nep413Hash);
    expect([LOGIN_MESSAGE, LOGIN_RECIPIENT]).toEqual(["bulkhead-login", "bulkhead"]);
  });
});
