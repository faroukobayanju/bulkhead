// Browser only. NEP-413 sign-in through the NEAR wallet selector, then one POST /session (E22). The session token (2 h, bound to
// the account) is what attempts carry, so there is no wallet popup per message.
import { LOGIN_MESSAGE, LOGIN_RECIPIENT, makeNonce } from "../../shared/nep413";
import type { Network } from "./links";

export type WalletId = "meteor-wallet" | "my-near-wallet";
export type Session = { session: string; expiresAt: string; accountId: string };
export class LoginError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const KEY = "bulkhead.session";
export const CONSENT_VERSION = "cc-by-4.0-2026-11";
const CONSENT_KEY = "bulkhead.consent";

export function savedSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Session | null;
    return s && Date.parse(s.expiresAt) > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}
export const forgetSession = () => localStorage.removeItem(KEY);
export const consented = () => localStorage.getItem(CONSENT_KEY) === CONSENT_VERSION;
export const saveConsent = () => localStorage.setItem(CONSENT_KEY, CONSENT_VERSION);

// Canonical padded base64 of raw bytes, as the agent's strict decoder wants it.
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

async function postSession(nep413: unknown): Promise<{ session: string; expires_at: string }> {
  const r = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nep413 }) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new LoginError(j?.error?.code ?? "unknown");
  return j;
}

function keep(s: { session: string; expires_at: string }, accountId: string): Session {
  const out = { session: s.session, expiresAt: s.expires_at, accountId };
  localStorage.setItem(KEY, JSON.stringify(out));
  return out;
}

// MOCK_AGENT=1: no wallet. The mock agent answers /session with a fixture.
export async function mockSignIn(): Promise<Session> {
  return keep(await postSession({ mock: true }), "player.testnet");
}

export async function signIn(walletId: WalletId, network: Network): Promise<Session> {
  // The wallet modules call Buffer, which browsers do not have.
  const { Buffer } = await import("buffer");
  (globalThis as any).Buffer ??= Buffer;
  const [{ setupWalletSelector }, { setupMeteorWallet }, { setupMyNearWallet }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/meteor-wallet"),
    import("@near-wallet-selector/my-near-wallet"),
  ]);
  const selector = await setupWalletSelector({ network, modules: [setupMeteorWallet(), setupMyNearWallet()] });
  let wallet;
  try {
    wallet = await selector.wallet(walletId);
  } catch {
    throw new LoginError("no_wallet");
  }
  if (!("signMessage" in wallet) || typeof wallet.signMessage !== "function") throw new LoginError("no_wallet");
  const nonce = makeNonce(Date.now());
  // MyNearWallet signs with a callbackUrl (it opens a popup and uses the URL to hand the result back). That URL is part of the
  // signed bytes, so it is sent to the agent with the rest. Meteor signs without one.
  const callbackUrl = walletId === "my-near-wallet" ? window.location.href : undefined;
  let signed;
  try {
    signed = await wallet.signMessage({ message: LOGIN_MESSAGE, recipient: LOGIN_RECIPIENT, nonce: Buffer.from(nonce), ...(callbackUrl && { callbackUrl }) });
  } catch (e) {
    const m = String((e as Error)?.message ?? e).toLowerCase();
    throw new LoginError(/not installed|extension|no wallet|not found/.test(m) ? "no_wallet" : "rejected");
  }
  if (!signed?.signature) throw new LoginError("rejected");
  const nep413 = { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, message: LOGIN_MESSAGE, nonce: b64(nonce), recipient: LOGIN_RECIPIENT, ...(callbackUrl && { callbackUrl }) };
  return keep(await postSession(nep413), signed.accountId);
}
