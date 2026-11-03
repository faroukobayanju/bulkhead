import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { makeAttest, NOT_VERIFIED } from "../src/attest";

const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const MODELS = { 1: MODEL, 2: MODEL, 3: "other/model" };
const NONCE = "ab".repeat(32);
const gw = privateKeyToAccount(`0x${"11".repeat(32)}`);
const tee = privateKeyToAccount(`0x${"22".repeat(32)}`);
const rogue = privateKeyToAccount(`0x${"33".repeat(32)}`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// a TDX v4 quote with the report data where the format puts it: 48-byte header + 520 bytes of body, then 64 bytes
const quote = (address: string, nonce: string) => Buffer.concat([Buffer.alloc(568), Buffer.from(address.slice(2), "hex"), Buffer.alloc(12), Buffer.from(nonce, "hex"), Buffer.alloc(100)]).toString("hex");
const entry = (over: object = {}) => ({ model_name: MODEL, signing_address: tee.address, signing_algo: "ecdsa", request_nonce: NONCE, intel_quote: quote(tee.address, NONCE), nvidia_payload: JSON.stringify({ nonce: NONCE, evidence: [] }), ...over });
const report = (o: { gateway?: object; entries?: unknown[] } = {}) => ({
  gateway_attestation: { signing_address: gw.address, signing_algo: "ecdsa", request_nonce: NONCE, intel_quote: quote(gw.address, NONCE), ...o.gateway },
  model_attestations: o.entries ?? [entry()],
});
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function setup(body: unknown | (() => unknown) = report(), o: { nras?: unknown; now?: { t: number } } = {}) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes("nras.attestation.nvidia.com")) return json(o.nras ?? [["JWT", jwt({ "x-nvidia-overall-att-result": true })], {}]);
    if (String(url).includes("/signature/")) return json(typeof body === "function" ? (body as () => unknown)() : body);
    return json(typeof body === "function" ? (body as () => unknown)() : body);
  }) as unknown as typeof fetch;
  const now = o.now ?? { t: 0 };
  const a = makeAttest({ fetch: f, models: MODELS, nonce: () => NONCE, clock: () => now.t, apiKey: "k" });
  return { a, calls, now };
}

describe("get", () => {
  test("a good report passes, sends the nonce and lists what is not verified", async () => {
    const s = setup();
    const r = await s.a.get(1);
    expect(r.modelId).toBe(MODEL);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.checks).toEqual({ gateway_nonce: true, model_entries: 1, quote_report_data_bound: true, nvidia_nras: "verified" });
    expect(r.notVerified).toBe(NOT_VERIFIED);
    expect(s.calls[0]).toContain(`/attestation/report?model=${encodeURIComponent(MODEL)}&nonce=${NONCE}&signing_algo=ecdsa`);
  });
  test("the gateway report is checked first and its nonce must match", async () => {
    const s = setup(report({ gateway: { request_nonce: "cd".repeat(32) }, entries: [entry({ signing_address: undefined })] }));
    await expect(s.a.get(1)).rejects.toThrow("nonce_mismatch");
  });
  test("a model entry with no signing_address (router-only) fails", async () => {
    const s = setup(report({ entries: [entry(), { model_name: MODEL, provider: "tinfoil", trust: "router_attested", request_nonce: NONCE }] }));
    await expect(s.a.get(1)).rejects.toThrow("model_entry_without_signing_address");
  });
  test("every entry is checked, not just the first", async () => {
    const s = setup(report({ entries: [entry(), entry({ request_nonce: "cd".repeat(32) })] }));
    await expect(s.a.get(1)).rejects.toThrow("nonce_mismatch");
  });
  test("wrong model, wrong signing algo", async () => {
    await expect(setup(report({ entries: [entry({ model_name: "x/y" })] })).a.get(1)).rejects.toThrow("model_entry_wrong_model");
    await expect(setup(report({ entries: [entry({ signing_algo: "ed25519" })] })).a.get(1)).rejects.toThrow("model_entry_wrong_signing_algo");
  });
  test("an echoed nonce is not enough: the quote's report data must bind address and nonce", async () => {
    await expect(setup(report({ entries: [entry({ intel_quote: quote(tee.address, "cd".repeat(32)) })] })).a.get(1)).rejects.toThrow("model_report_data_mismatch");
    await expect(setup(report({ entries: [entry({ intel_quote: quote(rogue.address, NONCE) })] })).a.get(1)).rejects.toThrow("model_report_data_mismatch");
    await expect(setup(report({ entries: [entry({ intel_quote: "00" })] })).a.get(1)).rejects.toThrow("model_report_data_mismatch");
    await expect(setup(report({ gateway: { intel_quote: quote(rogue.address, NONCE) } })).a.get(1)).rejects.toThrow("gateway_report_data_mismatch");
  });
  test("no models, no gateway, junk bodies", async () => {
    await expect(setup(report({ entries: [] })).a.get(1)).rejects.toThrow("no_model_attestation");
    await expect(setup({ model_attestations: [entry()] }).a.get(1)).rejects.toThrow("nonce_mismatch");
    await expect(setup([]).a.get(1)).rejects.toThrow("attestation_malformed");
  });
  test("NVIDIA: payload nonce, NRAS verdict and missing evidence", async () => {
    await expect(setup(report({ entries: [entry({ nvidia_payload: JSON.stringify({ nonce: "cd".repeat(32) }) })] })).a.get(1)).rejects.toThrow("nvidia_nonce_mismatch");
    await expect(setup(report({ entries: [entry({ nvidia_payload: undefined })] })).a.get(1)).rejects.toThrow("nvidia_payload_malformed");
    await expect(setup(report(), { nras: [["JWT", jwt({ "x-nvidia-overall-att-result": false })]] }).a.get(1)).rejects.toThrow("nvidia_attestation_failed");
    await expect(setup(report(), { nras: { error: "x" } }).a.get(1)).rejects.toThrow("nvidia_attestation_failed");
  });
  test("http error and network error throw", async () => {
    const bad = makeAttest({ fetch: (async () => new Response("no", { status: 500 })) as never, models: MODELS });
    await expect(bad.get(1)).rejects.toThrow("attestation_http_500");
    const down = makeAttest({ fetch: (async () => { throw new Error("down"); }) as never, models: MODELS });
    await expect(down.get(1)).rejects.toThrow("attestation_request_failed");
  });
  test("caches 10 minutes per model, and a failure is not cached", async () => {
    const s = setup();
    await s.a.get(1);
    await s.a.get(2); // same model
    expect(s.calls.filter(u => u.includes("/attestation/report")).length).toBe(1);
    s.now.t = 600_000;
    await s.a.get(1);
    expect(s.calls.filter(u => u.includes("/attestation/report")).length).toBe(1);
    s.now.t = 600_001;
    await s.a.get(1);
    expect(s.calls.filter(u => u.includes("/attestation/report")).length).toBe(2);
    let n = 0;
    const flaky = setup(() => (n++ === 0 ? { nope: 1 } : report()));
    await expect(flaky.a.get(1)).rejects.toThrow();
    expect((await flaky.a.get(1)).modelId).toBe(MODEL);
  });
});

describe("verifyCompletion", () => {
  const req = sha("request bytes");
  const resp = sha("response bytes");
  const signed = async (account: typeof tee, text: string, kind = "provider_tee", over: object = {}) => ({ text, signature: await account.signMessage({ message: text }), signing_address: account.address, signing_algo: "ecdsa", signature_kind: kind, ...over });
  async function ready(sig: unknown) {
    const att = setup(report());
    await att.a.get(1);
    const sigFetch = makeAttest({
      fetch: (async (url: string) => (String(url).includes("/signature/") ? json(sig) : (att.calls.push(url), json(report())))) as never,
      models: MODELS,
      nonce: () => NONCE,
      nras: false,
    });
    await sigFetch.get(1);
    return sigFetch;
  }
  const check = async (sig: unknown, e = { requestHash: req, responseHash: resp }) => (await ready(sig)).verifyCompletion("chat-1", MODEL, e);

  test("a provider_tee signature over model:request:response by the attested signer verifies", async () => {
    expect(await check(await signed(tee, `${MODEL}:${req}:${resp}`))).toEqual({ verified: true });
  });
  test("a gateway signature verifies against the gateway address", async () => {
    expect(await check(await signed(gw, `${req}:${resp}`, "gateway"))).toEqual({ verified: true });
  });
  test("a signature by someone else, even a valid one, is not verified", async () => {
    expect((await check(await signed(rogue, `${MODEL}:${req}:${resp}`))).reason).toBe("signer_not_attested");
  });
  test("a bad signature, or one that recovers a different address", async () => {
    const s = await signed(tee, `${MODEL}:${req}:${resp}`);
    expect((await check({ ...s, signature: (await signed(rogue, s.text)).signature })).reason).toBe("signature_does_not_match_signer");
    expect((await check({ ...s, signature: "0x1234" })).reason).toBe("signature_malformed");
  });
  test("text must bind this request and response", async () => {
    const s = await signed(tee, `${MODEL}:${req}:${sha("other")}`);
    expect((await check(s)).reason).toBe("text_does_not_match_request_and_response");
    expect((await check(await signed(tee, `${req}:${resp}`))).reason).toBe("text_does_not_match_request_and_response"); // kind says provider_tee
  });
  test("missing fields, unknown kind and wrong algo are unverified, never a throw", async () => {
    expect((await check({})).reason).toBe("signature_missing");
    expect((await check(await signed(tee, `${MODEL}:${req}:${resp}`, "router"))).reason).toBe("unknown_signature_kind");
    expect((await check(await signed(tee, `${MODEL}:${req}:${resp}`, "provider_tee", { signing_algo: "ed25519" }))).reason).toBe("signing_algo_not_ecdsa");
  });
  test("no prior attestation for the model, and an http error", async () => {
    const a = makeAttest({ fetch: (async () => json({})) as never, models: MODELS });
    expect((await a.verifyCompletion("c", MODEL, { requestHash: req, responseHash: resp })).reason).toBe("no_attestation_for_model");
    const s = setup();
    await s.a.get(1);
    const down = makeAttest({ fetch: (async (u: string) => (String(u).includes("/signature/") ? new Response("x", { status: 404 }) : json(report()))) as never, models: MODELS, nonce: () => NONCE, nras: false });
    await down.get(1);
    expect((await down.verifyCompletion("c", MODEL, { requestHash: req, responseHash: resp })).reason).toBe("attestation_http_404");
  });
});
