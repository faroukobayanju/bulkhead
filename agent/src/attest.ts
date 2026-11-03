// NEAR AI attestation (E5, E17), against the gateway at cloud-api.near.ai/v1, following docs.near.ai/cloud/verification:
//   1. before a completion: gateway attestation and model attestations for a fresh 32-byte nonce, cached 10 minutes per model;
//   2. every returned model entry must pass (an entry with no signing_address, such as a router-only report, fails the whole call);
//   3. after a completion: verifyCompletion checks the response signature against the attested signing address.
// What this verifies, and what it does not, is listed in NOT_VERIFIED. The word "verified" is used only for the first list.
import { createHash, randomBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { canonicalJson } from "./firewall/verdict";
import type { Tier } from "./llm";

// Not done here, so nothing in this file or its callers may call an attestation "fully verified". Shown on /attestation.
export const NOT_VERIFIED = [
  "tdx_quote_signature_and_tcb_status (dcap-qvl)", // the quote is parsed for its report data only; its Intel signature chain is not checked
  "tdx_mrconfigid_and_rtmr3_event_log",
  "tls_certificate_binding",
  "nvidia_nras_jwt_signature", // the NRAS verdict is read over TLS from NVIDIA; the JWT signature is not checked locally
] as const;

export type AttestChecks = {
  gateway_nonce: boolean; // gateway_attestation.request_nonce equals ours and it has a signing_address
  model_entries: number; // every entry has signing_address, signing_algo ecdsa, our nonce and our model name
  quote_report_data_bound: boolean; // report data in each intel_quote = signing address (right-padded) || nonce
  nvidia_nras: "verified" | "skipped"; // payload nonce matches and NRAS reports overall result true
};
export type AttestResult = { sha256: string; modelId: string; checks: AttestChecks; notVerified: readonly string[] };
export type CompletionCheck = { verified: boolean; reason?: string };

type Cached = { at: number; result: AttestResult; models: Set<string>; gateway: string };
const TTL_MS = 600_000;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const addr = (s: string) => s.toLowerCase().replace(/^0x/, "");
export class AttestError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "AttestError";
  }
}

// TDX quote v4: 48-byte header, then the TD report body; REPORTDATA is its last 64 bytes, at body offset 520.
const REPORT_DATA_AT = 48 + 520;
function reportData(quoteHex: unknown): Buffer | null {
  if (!str(quoteHex) || !/^(0x)?([0-9a-fA-F]{2})+$/.test(quoteHex)) return null;
  const b = Buffer.from(quoteHex.replace(/^0x/, ""), "hex");
  return b.length >= REPORT_DATA_AT + 64 ? b.subarray(REPORT_DATA_AT, REPORT_DATA_AT + 64) : null;
}
// ecdsa address is 20 bytes, zero-padded on the right to 32; the nonce fills the second half.
const bound = (quote: unknown, address: string, nonceHex: string) => {
  const rd = reportData(quote);
  const want = Buffer.concat([Buffer.from(addr(address), "hex"), Buffer.alloc(32 - addr(address).length / 2), Buffer.from(nonceHex, "hex")]);
  return rd !== null && addr(address).length === 40 && rd.equals(want);
};

export function makeAttest(o: {
  fetch: typeof fetch;
  base?: string;
  apiKey?: string;
  models: Record<Tier, string>;
  nonce?: () => string; // 64 hex chars
  clock?: () => number;
  timeoutMs?: number;
  nras?: boolean; // submit each nvidia_payload to NVIDIA NRAS (default true); false marks nvidia_nras "skipped"
}) {
  const base = (o.base ?? "https://cloud-api.near.ai/v1").replace(/\/+$/, "");
  const clock = o.clock ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const fresh = o.nonce ?? (() => randomBytes(32).toString("hex"));
  const useNras = o.nras ?? true;
  const headers: Record<string, string> = o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {};
  const cache = new Map<string, Promise<Cached>>();
  const settled = new Map<string, Cached>(); // what verifyCompletion matches signatures against

  async function getJson(url: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await o.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new AttestError("attestation_request_failed");
    }
    if (!res.ok) throw new AttestError(`attestation_http_${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new AttestError("attestation_bad_json");
    }
  }

  async function nras(payload: unknown, nonce: string) {
    let p: unknown;
    try {
      p = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch {
      throw new AttestError("nvidia_payload_malformed");
    }
    if (!isObj(p)) throw new AttestError("nvidia_payload_malformed");
    if (typeof p.nonce !== "string" || p.nonce.toLowerCase() !== nonce) throw new AttestError("nvidia_nonce_mismatch");
    if (!useNras) return "skipped" as const;
    const out = await getJson("https://nras.attestation.nvidia.com/v3/attest/gpu", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
    const token = Array.isArray(out) && Array.isArray(out[0]) && out[0][0] === "JWT" ? out[0][1] : undefined;
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString());
    } catch {}
    if (!isObj(claims) || claims["x-nvidia-overall-att-result"] !== true) throw new AttestError("nvidia_attestation_failed");
    return "verified" as const;
  }

  async function fetchOne(model: string): Promise<Cached> {
    const nonce = fresh();
    if (!/^[0-9a-f]{64}$/.test(nonce)) throw new AttestError("bad_nonce");
    const url = `${base}/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}&signing_algo=ecdsa`;
    const body = await getJson(url, { headers });
    if (!isObj(body)) throw new AttestError("attestation_malformed");

    // 1. gateway first
    const gw = body.gateway_attestation;
    if (!isObj(gw) || !str(gw.signing_address) || typeof gw.request_nonce !== "string" || gw.request_nonce.toLowerCase() !== nonce) throw new AttestError("nonce_mismatch");
    if (!bound(gw.intel_quote, gw.signing_address, nonce)) throw new AttestError("gateway_report_data_mismatch");

    // 2. every model entry, none skipped
    const entries = body.model_attestations;
    if (!Array.isArray(entries) || entries.length === 0) throw new AttestError("no_model_attestation");
    const models = new Set<string>();
    const evidence: unknown[] = [];
    let nv: "verified" | "skipped" = "skipped";
    for (const e of entries) {
      if (!isObj(e) || !str(e.signing_address)) throw new AttestError("model_entry_without_signing_address");
      if (typeof e.request_nonce !== "string" || e.request_nonce.toLowerCase() !== nonce) throw new AttestError("nonce_mismatch");
      if (e.signing_algo !== "ecdsa") throw new AttestError("model_entry_wrong_signing_algo");
      if (e.model_name !== model) throw new AttestError("model_entry_wrong_model");
      if (!bound(e.intel_quote, e.signing_address, nonce)) throw new AttestError("model_report_data_mismatch");
      nv = await nras(e.nvidia_payload, nonce);
      models.add(addr(e.signing_address));
      evidence.push({ signing_address: addr(e.signing_address), quote: sha(String(e.intel_quote)), nvidia: sha(String(e.nvidia_payload)) });
    }
    const checks: AttestChecks = { gateway_nonce: true, model_entries: entries.length, quote_report_data_bound: true, nvidia_nras: nv };
    const digest = sha(canonicalJson({ model, nonce, gateway: { signing_address: addr(gw.signing_address), quote: sha(String(gw.intel_quote)) }, models: evidence }));
    return { at: clock(), result: { sha256: digest, modelId: model, checks, notVerified: NOT_VERIFIED }, models, gateway: addr(gw.signing_address) };
  }

  return {
    async get(tier: Tier): Promise<AttestResult> {
      const model = o.models[tier];
      if (!model) throw new AttestError("unknown_tier");
      const hit = cache.get(model);
      if (hit) {
        const c = await hit.catch(() => null);
        if (c && clock() - c.at <= TTL_MS) return c.result;
        if (cache.get(model) === hit) cache.delete(model);
      }
      const p = fetchOne(model);
      cache.set(model, p);
      try {
        const c = await p;
        settled.set(model, c);
        return c.result;
      } catch (e) {
        if (cache.get(model) === p) cache.delete(model);
        throw e;
      }
    },

    // After a completion (E17). Never throws: a response with no verifiable signature is stored with response_verified = false
    // and the attempt goes on. requestHash and responseHash are sha256 hex of the exact request and response body bytes.
    async verifyCompletion(chatId: string, model: string, expected: { requestHash: string; responseHash: string }): Promise<CompletionCheck> {
      const no = (reason: string): CompletionCheck => ({ verified: false, reason });
      const att = settled.get(model);
      if (!att) return no("no_attestation_for_model");
      let sig: unknown;
      try {
        sig = await getJson(`${base}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers });
      } catch (e) {
        return no((e as Error).message);
      }
      if (!isObj(sig) || !str(sig.text) || !str(sig.signature) || !str(sig.signing_address)) return no("signature_missing");
      if (sig.signing_algo !== "ecdsa") return no("signing_algo_not_ecdsa");
      const kind = sig.signature_kind;
      if (kind !== "provider_tee" && kind !== "gateway") return no("unknown_signature_kind");
      const want = kind === "provider_tee" ? `${model}:${expected.requestHash}:${expected.responseHash}` : `${expected.requestHash}:${expected.responseHash}`;
      if (sig.text !== want) return no("text_does_not_match_request_and_response");
      const claimed = addr(sig.signing_address);
      if (kind === "provider_tee" ? !att.models.has(claimed) : claimed !== att.gateway) return no("signer_not_attested");
      let recovered: string;
      try {
        recovered = await recoverMessageAddress({ message: sig.text, signature: (sig.signature.startsWith("0x") ? sig.signature : `0x${sig.signature}`) as `0x${string}` });
      } catch {
        return no("signature_malformed");
      }
      return addr(recovered) === claimed ? { verified: true } : no("signature_does_not_match_signer");
    },
  };
}
export type Attest = ReturnType<typeof makeAttest>;
