import { expect, test } from "bun:test";
import { loginCopy } from "./outcome";
import { nonceB64, walletError } from "./near";

// TODO(E22, needs a person with a wallet): capture one real NEP-413 signature from each wallet the site offers (Meteor, and
// MyNearWallet in its callbackUrl form) on testnet, and add each as a vector here and in agent/test/auth.test.ts. Remove a wallet
// from AttemptPanel if its signature does not verify. Not done: no wallet signing in this environment.

test("wallet errors map to sign-in codes", () => {
  expect(walletError(new Error("Popup window blocked. Please allow popups for this site."))).toBe("popup_blocked");
  expect(walletError(new Error("User closed the window"))).toBe("rejected");
  expect(walletError(new Error("User rejected the request"))).toBe("rejected");
  expect(walletError(new Error("Meteor Wallet extension not installed"))).toBe("no_wallet");
  expect(walletError("weird")).toBe("rejected");
});

test("popup_blocked has its own copy", () => {
  expect(loginCopy("popup_blocked")).toContain("pop-up");
  expect(loginCopy("popup_blocked")).not.toBe(loginCopy("rejected"));
});

test("the nonce goes to the agent as canonical padded base64 of its 32 bytes", () => {
  const n = new Uint8Array(32).map((_, i) => i * 7);
  const b = nonceB64(n);
  expect(b.length).toBe(44);
  expect(b.endsWith("=")).toBe(true);
  expect(Buffer.from(b, "base64").equals(Buffer.from(n))).toBe(true);
  expect(Buffer.from(b, "base64").toString("base64")).toBe(b);
});
