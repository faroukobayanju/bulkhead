// E5: a stored attempt row carries an ed25519 signature over its public fields. The verifier below is the logic of the docs'
// verify.ts (canonical JSON, base58 key, node:crypto ed25519) applied to the row a browser reads from Convex.
import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { KeyPair } from "near-api-js";
import { makeDb, type AttemptRow } from "../src/db";
import { api, FW, H, idN, setup } from "./convex-harness";

const canon = (v: any): string =>
  Array.isArray(v) ? `[${v.map(canon)}]`
  : v && typeof v === "object" ? `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`)}}`
  : JSON.stringify(v);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// `row` is what the public query returns. stage is progress and is not signed; everything else public is.
function verifyRow({ signature, stage: _stage, ...body }: Record<string, any>, publicKey: string): boolean {
  try {
    if (typeof signature !== "string" || typeof body.signer !== "string") return false;
    let n = 0n;
    for (const c of publicKey.replace("ed25519:", "")) n = n * 58n + BigInt(B58.indexOf(c));
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(n.toString(16).padStart(64, "0"), "hex")]), format: "der", type: "spki" });
    return verify(null, createHash("sha256").update(canon(body)).digest(), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

const kp = KeyPair.fromRandom("ed25519");
const pub = kp.getPublicKey().toString();
const row = (o: Partial<AttemptRow> = {}): AttemptRow => ({
  id: idN(1), ts: "2026-11-02T12:34:56.789Z", tier: 3, account: "alice.near", ip: "203.0.113.7", message: "hello dragon", normalized: "hello dragon",
  fw_a: FW, fw_b: { ...FW, risk: 20, reason: "SECRET-REASON-b" }, tool_called: true, outcome: "releasing", technique: "none", prompt_sha256: H("c"),
  model_id: "m", attestation_sha256: H("d"), codehash: "local", near_tx: null, chain_txid: null, payout_address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
  consent_version: "consent-v1", reply: "On it.", stage: "signing", ...o,
});

function world(signed = true) {
  const s = setup();
  const f = (async (url: string, init: RequestInit) => s.t.fetch(new URL(url).pathname, init)) as unknown as typeof fetch;
  const db = makeDb({ fetch: f, siteUrl: "http://localhost:3211", secret: "test-agent-secret-0123456789abcdef", pepper: "p".repeat(40), ...(signed && { signer: { id: "agent.testnet", sign: h => kp.sign(h).signature } }) });
  const read = async (id = idN(1)) => (await s.t.query(api.attempts.get, { id })) as Record<string, any>;
  return { ...s, db, read };
}

describe("signed attempt rows", () => {
  test("a row signed on insert verifies from what the public query returns, with no reason in it", async () => {
    const w = world();
    await w.db.insertAttempt(row({ response_verified: true }));
    const r = await w.read();
    expect(r.signer).toBe("agent.testnet");
    expect(r.response_verified).toBe(true);
    expect(JSON.stringify(r)).not.toContain("SECRET-REASON");
    expect(verifyRow(r, pub)).toBe(true);
  });

  test("changing any public field, or the key, makes it fail", async () => {
    const w = world();
    await w.db.insertAttempt(row({ outcome: "releasing", near_tx: "NEAR", chain_txid: "TXID", technique: "override" }));
    const r = await w.read();
    expect(verifyRow(r, pub)).toBe(true);
    const bumped = (v: any) => (typeof v === "string" ? v + "x" : typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : v);
    const keys = Object.keys(r).filter(k => !["stage", "signature"].includes(k));
    for (const k of keys) {
      const changed = r[k] === null ? "x" : isObjectLike(r[k]) ? { ...r[k], risk: 99 } : bumped(r[k]);
      expect(verifyRow({ ...r, [k]: changed }, pub), `field ${k}`).toBe(false);
    }
    expect(verifyRow({ ...r, fw_a: { ...r.fw_a, verdict: "block" } }, pub)).toBe(false);
    expect(verifyRow({ ...r, signature: Buffer.alloc(64).toString("base64") }, pub)).toBe(false);
    expect(verifyRow(r, KeyPair.fromRandom("ed25519").getPublicKey().toString())).toBe(false);
    expect(verifyRow({ ...r, stage: "signing" }, pub)).toBe(true); // progress is not part of the record
  });

  test("the outcome update signs the new row, and the old signature no longer fits", async () => {
    const w = world();
    await w.db.insertAttempt(row());
    const before = await w.read();
    await w.db.updateAttempt(idN(1), { outcome: "drained", reply: "You won.", near_tx: "NEARTX", chain_txid: "BTCTXID" });
    const after = await w.read();
    expect(after).toMatchObject({ outcome: "drained", stage: "done", near_tx: "NEARTX", payout: "tb1qw5…zsx" });
    expect(verifyRow(after, pub)).toBe(true);
    expect(verifyRow({ ...after, signature: before.signature }, pub)).toBe(false);
  });

  test("a rebroadcast settle (signed_pending_broadcast to drained, only a chain txid) is signed too", async () => {
    const w = world();
    await w.db.insertAttempt(row());
    await w.db.updateAttempt(idN(1), { outcome: "signed_pending_broadcast", reply: "signed", near_tx: "NEARTX" });
    expect(verifyRow(await w.read(), pub)).toBe(true);
    await w.db.updateAttempt(idN(1), { outcome: "drained", chain_txid: "BTCTXID" });
    const r = await w.read();
    expect(r).toMatchObject({ outcome: "drained", chain_txid: "BTCTXID", near_tx: "NEARTX", reply: "signed" });
    expect(verifyRow(r, pub)).toBe(true);
  });

  test("a row stored before signing existed, or by an agent with no signer, has null signature and signer and does not verify", async () => {
    const w = world(false);
    await w.db.insertAttempt(row());
    const r = await w.read();
    expect(r).toMatchObject({ signature: null, signer: null, response_verified: false });
    expect(verifyRow(r, pub)).toBe(false);
  });

  test("response_verified is false unless the pipeline proved it", async () => {
    const w = world();
    await w.db.insertAttempt(row());
    expect((await w.read()).response_verified).toBe(false);
  });
});

const isObjectLike = (x: unknown) => typeof x === "object" && x !== null;
