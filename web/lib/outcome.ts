// What the tier page shows for each answer from the agent: the copy from the plan's outcome table, in one place.
// `reply` is model or agent text and must be rendered as plain text (components/UntrustedText).
import { CHAIN_OF, chainTxUrl, nearTxUrl, type Network, type TierId } from "./links";

export type Screen = {
  tone: "win" | "stop" | "info" | "error";
  title: string;
  lines: string[];
  reply?: string;
  countdown?: { seconds: number; template: string }; // template holds {t}
  links?: { label: string; href: string }[];
};

const ACCOUNT_WAIT_S = 600; // 1 attempt per account per tier per 10 minutes
// The agent's 503 codes (agent/src/server.ts) plus the proxy's own.
const UNAVAILABLE = new Set(["db_unavailable", "rpc_unavailable", "chain_unavailable", "attestation_unavailable", "llm_unavailable", "firewall_degraded", "budget_exhausted", "budget_unavailable", "spend_cap", "agent_unreachable", "agent_not_configured"]);
const NOT_COUNTED ="Agent unverifiable right now. Your attempt was not counted.";

export const riskBand = (r: number) => (r >= 70 ? "high" : r >= 40 ? "med" : "low");

export function clock(s: number): string {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const isObj = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null;

function fromError(status: number, e: Record<string, any>): Screen {
  const code = String(e.code ?? "");
  const wait = typeof e.retry_after_s === "number" ? e.retry_after_s : undefined;
  if (code === "won_race_lost") return { tone: "info", title: "You broke it, but someone beat you by seconds.", lines: [], reply: typeof e.reply === "string" ? e.reply : undefined };
  if (code === "tier_cooling") return { tone: "info", title: "This tier is between rounds", lines: [], countdown: { seconds: wait ?? 0, template: "Next round in {t}" } };
  if (code === "tier_closed") return { tone: "info", title: "Tier drained", lines: ["This tier is not taking attempts. The winning attempt is on the home page."], links: [{ label: "See the winner", href: "/#winners" }] };
  if (status === 429 && e.rule === "account") return { tone: "info", title: "One attempt per tier every 10 minutes", lines: [], countdown: { seconds: wait ?? 0, template: "Your next attempt on this tier in {t}" } };
  if (status === 429 && e.rule === "ip") return { tone: "info", title: "Too many attempts from your network", lines: [], ...(wait !== undefined && { countdown: { seconds: wait, template: "Try again in {t}" } }) };
  if (status === 429) return { tone: "info", title: "Arena busy", lines: [], countdown: { seconds: wait ?? 60, template: "Arena busy, try in {t}" } };
  if (status === 503) return { tone: "error", title: NOT_COUNTED, lines: typeof e.message === "string" ? [e.message] : [] };
  if (status === 401) return { tone: "error", title: "Your session ended. Sign in again.", lines: [] };
  const msg = typeof e.message === "string" ? e.message : "Something went wrong on our side.";
  return { tone: "error", title: msg, lines: typeof e.fix === "string" ? [e.fix] : [] };
}

export function screenFor(x: { status: number; body: unknown }, ctx: { tier: TierId; network: Network }): Screen {
  if (x.status === 0) return { tone: "error", title: "We could not reach the arena. Your attempt may not have been sent.", lines: ["Check your connection and try again."] };
  const b = x.body;
  // An error inside a 200 poll answer (the attempt failed after its 202) has no status of its own: its code says which it is.
  if (isObj(b) && isObj(b.error)) return fromError(x.status >= 400 ? x.status : UNAVAILABLE.has(b.error.code) ? 503 : 500, b.error);
  if (!isObj(b) || typeof b.outcome !== "string") {
    if (x.status >= 500 || x.status === 0) return { tone: "error", title: NOT_COUNTED, lines: [] };
    return { tone: "error", title: "The arena sent an answer this page does not understand.", lines: ["Reload the page; if your attempt went through it is listed on the home page."] };
  }
  const reply = typeof b.reply === "string" ? b.reply : "";
  const fw = b.firewall?.b ?? b.firewall?.a;
  switch (b.outcome) {
    case "refused":
      return { tone: "stop", title: "The guard said no", lines: [], reply, countdown: { seconds: ACCOUNT_WAIT_S, template: "Try another tier, or come back here in {t}" } };
    case "blocked_a":
    case "blocked_b":
      return {
        tone: "stop",
        title: `Blocked · ${fw?.technique ?? "other"} · risk ${riskBand(Number(fw?.risk ?? 100))}`,
        lines: [
          ...(b.outcome === "blocked_b" ? ["Near miss: the agent agreed, the firewall stopped it."] : []),
          "The full reason is hidden now and published in the next day's dataset.",
        ],
      };
    case "tool_error":
      return { tone: "stop", title: "The payout call was wrong", lines: [reply || "The agent fumbled the tool call."] };
    case "drained": {
      const links = [];
      if (b.txs?.near_tx) links.push({ label: "NEAR transaction", href: nearTxUrl(ctx.network, b.txs.near_tx) });
      if (b.txs?.chain_txid) links.push({ label: CHAIN_OF[ctx.tier] === "btc" ? "Bitcoin transaction" : "Base transaction", href: chainTxUrl(ctx.network, CHAIN_OF[ctx.tier], b.txs.chain_txid) });
      return { tone: "win", title: "You drained this round", lines: ["The contract signed your payout. This attack is now a regression test for the firewall."], reply, links };
    }
    case "signed_pending_broadcast":
      return {
        tone: "win",
        title: "You won, broadcast pending",
        lines: ["The contract signed your payout. The signed transaction is on /verify, and anyone can broadcast it, you included."],
        links: [...(b.txs?.near_tx ? [{ label: "NEAR transaction", href: nearTxUrl(ctx.network, b.txs.near_tx) }] : []), { label: "Signed transaction on /verify", href: "/verify" }],
      };
    case "release_failed":
      return { tone: "info", title: "Payout failed", lines: ["You beat the guard; the payout failed before signing. The tier is still open. Your cooldown was refunded."] };
    default:
      return { tone: "info", title: `Outcome: ${b.outcome}`, lines: [], reply };
  }
}

export const pendingScreen = (id: string): Screen => ({ tone: "info", title: `Result pending. Your attempt ID: ${id}. Check /verify.`, lines: [] });

// Sign-in failures: from the wallet (no_wallet, rejected) or from POST /session (the agent's 401 codes).
export function loginCopy(code: string, network: Network = "testnet"): string {
  switch (code) {
    case "no_wallet":
      return "No NEAR wallet found. Install Meteor Wallet, or use MyNearWallet in a new tab.";
    case "rejected":
      return "You rejected the signature, so you are not signed in.";
    case "expired":
    case "replay":
      return "That sign-in is too old. Please sign again.";
    case "key_not_on_account":
      return `That key is not a full-access key on your account. This site runs on NEAR ${network}; check your wallet is on ${network} too.`;
    case "bad_sig":
    case "bad_recipient":
      return "The wallet signed something else. Please sign again.";
    case "rate_limited":
      return "Too many sign-ins from your network. Wait a minute and try again.";
    default:
      return "Sign-in failed. Try again in a moment.";
  }
}
