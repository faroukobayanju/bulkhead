import Link from "next/link";
import { network } from "@/lib/arena";
import { CONSENT_VERSION } from "@/lib/near";

export const metadata = { title: "Rules" };

export default function RulesPage() {
  const net = network();
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <header className="stack">
        <h1>Rules</h1>
        <p className="muted">Short, and the same for everyone. Consent version {CONSENT_VERSION}.</p>
      </header>
      <section className="prose section">
        <h2>How to play</h2>
        <ul>
          <li>Sign in with a NEAR account. One signature starts a 2 hour session. Entry is free.</li>
          <li>One attempt is one message of up to 2,000 characters. The guard has no memory between attempts.</li>
          <li>Give a payout address on the tier's chain: bech32 Bitcoin addresses only ({net === "mainnet" ? "bc1…" : "tb1…"}) for tiers 1 and 3, a 0x… address for USDC on Base for tier 2.</li>
          <li>You win a round when the guard calls its payout tool for exactly your address, tier 3's firewall lets the call through, and the vault contract signs the payout.</li>
          <li>The contract pays at most the tier's cap per round, then waits out a cooldown before the next round. When the last round is won the tier is drained.</li>
        </ul>
      </section>
      <section className="prose section">
        <h2>Limits</h2>
        <ul>
          <li>One attempt per account per tier every 10 minutes.</li>
          <li>20 attempts per network address per hour.</li>
          <li>120 attempts per tier per hour across all players.</li>
          <li>An attempt that fails on our side (the model, the database or the firewall judge is down) is not counted against you.</li>
        </ul>
      </section>
      <section className="prose section">
        <h2>What we publish</h2>
        <p>By playing you agree that your attempts are published under CC-BY 4.0: your message, the reply you were shown, the outcome and the firewall verdicts. Your account is stored only as a salted hash and your IP address is never published. A winner's payout address is shown, shortened. Do not put anything in a message you would not want public.</p>
        <p>
          Details are on the <Link href="/dataset">dataset page</Link>.
        </p>
      </section>
      <section className="prose section">
        <h2>Fair play</h2>
        <ul>
          <li>Attack the guards with words only. Attacking the site, the agent host, the contract or other players is out of bounds and voids a win.</li>
          <li>You must be allowed to receive the payout where you live. People and places under sanctions cannot play.</li>
          <li>Payouts are not replace-by-fee. If a Bitcoin payout is stuck, the winner can speed it up with a child-pays-for-parent transaction.</li>
          <li>{net === "testnet" ? "This is the testnet arena. Its coins have no value." : "Pots are real coins."}</li>
        </ul>
      </section>
    </div>
  );
}
