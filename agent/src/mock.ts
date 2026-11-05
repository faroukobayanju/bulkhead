// MOCK_LLM=1 (testnet only, config refuses it elsewhere): canned replacements for NEAR AI chat, the judge and attestation, read
// from test/fixtures/mock-llm.json, so the whole stack runs with no key and no network. Imported by main.ts only in mock mode.
import { readFileSync } from "node:fs";
import type { Judge } from "./firewall/verdict";
import type { ChatOut, Tier } from "./llm";
import type { ChainDeps } from "./server";

type Fixture = {
  refusal: string;
  agreement: string;
  win_pattern: string;
  attack_pattern: string;
  judge: Record<"attack" | "encoded" | "benign", { risk: number; technique: any; reason: string }>;
  attestation: { sha256: string; modelId: string };
};
const ADDRESS = /\b(?:0x[0-9a-fA-F]{40}|(?:bc|tb)1[0-9a-z]{20,90})\b/;

export function loadMock(read: () => string = () => readFileSync(new URL("../test/fixtures/mock-llm.json", import.meta.url), "utf8")) {
  const f = JSON.parse(read()) as Fixture;
  const win = new RegExp(f.win_pattern, "i");
  const attack = new RegExp(f.attack_pattern, "i");
  // A message that asks for release_funds and names an address gets the tool call; anything else gets the canned refusal.
  const chat = async (_tier: Tier, msg: string): Promise<ChatOut> => {
    const to = ADDRESS.exec(msg)?.[0];
    return win.test(msg) && to
      ? { raw: { content: f.agreement }, text: f.agreement, toolCalls: [{ name: "release_funds", args: { recipient: to } }] }
      : { raw: { content: f.refusal }, text: f.refusal, toolCalls: [] };
  };
  // Like the real judge, it is also shown the payloads the normalizer decoded (Morse, base64...) and rates them like the messages.
  const judge: Judge = async ({ messages, normalized }) =>
    attack.test(messages.map(m => m.content).join("\n")) ? f.judge.attack : normalized?.decoded?.some(d => attack.test(d.value)) ? f.judge.encoded : f.judge.benign;
  const attest = async () => f.attestation;
  return { chat, judge, attest };
}

// Mock mode with no vault configured: every tier is open, a release "succeeds", nothing touches a chain.
export const mockChain = (viewAccessKey: ChainDeps["viewAccessKey"]): ChainDeps => ({
  release: async (_t, id) => ({ nearTx: `mock-near-${id}`, chainTxid: `mock-chain-${id}` }),
  tierOpen: async () => ({ status: "open", retryAfterS: 0 }),
  wasSigned: async () => false,
  viewAccessKey,
  storeSignedTx: async () => {},
});
