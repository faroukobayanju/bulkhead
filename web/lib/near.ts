// Browser only. NEP-413 sign-in through the NEAR wallet selector, then one POST /session (E22). The session token (2 h, bound to
// the account) is what attempts carry, so there is no wallet popup per message.
// The selector and the wallets are set up when the page mounts (prepareWallets), so the click that signs opens the wallet
// popup straight away. Loading them inside the click handler loses the user gesture and the browser blocks the popup.
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
export const nonceB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

// What a wallet's error means for the player. Wallets throw plain Errors, so this reads the message.
export function walletError(e: unknown): string {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  if (/popup|pop-up/.test(m) && /block/.test(m)) return "popup_blocked";
  if (/not installed|extension|no wallet|not found/.test(m)) return "no_wallet";
  return "rejected";
}

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

type SignWallet = { signMessage: (p: { message: string; recipient: string; nonce: any; callbackUrl?: string }) => Promise<{ accountId: string; publicKey: string; signature: string } | void> };
export type Wallets = Partial<Record<WalletId, SignWallet>>;

// Called on mount. A wallet that cannot be set up (Meteor's extension missing, say) is left out, and signing with it is no_wallet.
export async function prepareWallets(network: Network): Promise<Wallets> {
  const { Buffer } = await import("buffer");
  (globalThis as any).Buffer ??= Buffer; // the wallet modules call Buffer, which browsers do not have
  const [{ setupWalletSelector }, { setupMeteorWallet }, { setupMyNearWallet }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/meteor-wallet"),
    import("@near-wallet-selector/my-near-wallet"),
  ]);
  const selector = await setupWalletSelector({ network, modules: [setupMeteorWallet(), setupMyNearWallet()] });
  const out: Wallets = {};
  for (const id of ["meteor-wallet", "my-near-wallet"] as const) {
    try {
      const w = (await selector.wallet(id)) as unknown as SignWallet;
      if (typeof w.signMessage === "function") out[id] = w;
    } catch {
      // not available in this browser
    }
  }
  return out;
}

// Called from the click. Nothing is awaited before signMessage, so the wallet popup opens inside the user gesture.
export async function signIn(walletId: WalletId, wallets: Wallets | null): Promise<Session> {
  const wallet = wallets?.[walletId];
  if (!wallet) throw new LoginError(wallets ? "no_wallet" : "wallet_loading");
  const nonce = makeNonce(Date.now());
  // MyNearWallet signs with a callbackUrl (it opens a popup and uses the URL to hand the result back). That URL is part of the
  // signed bytes, so it is sent to the agent with the rest. Meteor signs without one.
  const callbackUrl = walletId === "my-near-wallet" ? window.location.href : undefined;
  let signed;
  try {
    signed = await wallet.signMessage({ message: LOGIN_MESSAGE, recipient: LOGIN_RECIPIENT, nonce: (globalThis as any).Buffer.from(nonce), ...(callbackUrl && { callbackUrl }) });
  } catch (e) {
    throw new LoginError(walletError(e));
  }
  if (!signed?.signature) throw new LoginError("rejected");
  const nep413 = { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, message: LOGIN_MESSAGE, nonce: nonceB64(nonce), recipient: LOGIN_RECIPIENT, ...(callbackUrl && { callbackUrl }) };
  return keep(await postSession(nep413), signed.accountId);
}
