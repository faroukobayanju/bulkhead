"use client";
import { Warning } from "@phosphor-icons/react/ssr";
import type { Arena } from "@/lib/arena";
import { addressUrl, type TierId } from "@/lib/links";
import { TIER_INFO, potText } from "@/lib/tiers";
import { AttemptPanel } from "./AttemptPanel";
import { Countdown } from "./Countdown";
import { StatusLabel } from "./Status";
import { useArena } from "./useArena";

export function TierView({ initial, tier }: { initial: Arena; tier: TierId }) {
  const { arena, pots } = useArena(initial);
  const t = arena.tiers.find(x => x.id === tier)!;
  const info = TIER_INFO[tier];
  const st = t.state;
  const withdraw = arena.pending?.filter(p => p.kind === "withdraw") ?? [];
  const closed =
    st.status === "cooling" ? "This tier is between rounds." : st.status === "releasing" ? "A payout is in progress." : st.status === "drained" ? "This tier is drained." : st.status === "paused" ? "The vault is paused." : st.status === "not_launched" ? "This tier is not launched." : st.status === "unknown" ? "The vault cannot be read right now, so attempts are off." : undefined;

  return (
    <div className="stack">
      {withdraw.length > 0 && (
        <div className="banner" role="alert">
          <Warning size={20} weight="bold" aria-label="Warning" className="warn" />
          <p>
            The owner has proposed an emergency withdraw ({withdraw.map(w => `tier ${w.kind === "withdraw" ? w.tierId : ""}`).join(", ")}). It can run after its 24 hour timelock. Details on <a href="/verify">/verify</a>.
          </p>
        </div>
      )}
      <header className="stack" style={{ gap: 4 }}>
        <h1>
          Tier {tier} · {info.name}
        </h1>
        <p className="muted">{info.defense}.</p>
      </header>
      <div className="tier-layout">
        <AttemptPanel tier={tier} network={arena.network} mock={arena.mock} open={st.status === "open"} closedReason={closed} />
        <aside className="stack" aria-label="Tier facts">
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <StatusLabel status={st.status} testId="status" />
              {st.status === "cooling" && st.nextRoundAt && (
                <div className="small muted">
                  <Countdown until={st.nextRoundAt} template="Next round in {t}" />
                </div>
              )}
            </dd>
            <dt>Pot</dt>
            <dd className="mono" data-testid={`pot-${tier}`}>
              {potText(pots[tier]!, st.status === "drained" ? st.attemptId : undefined)}
            </dd>
            <dt>Rounds left</dt>
            <dd className="mono">{t.roundsLeft ?? "unknown"}</dd>
            <dt>Cap per payout</dt>
            <dd className="mono">{t.maxRelease ?? "unknown"}</dd>
            <dt>Cooldown</dt>
            <dd className="mono">{t.cooldownS === null ? "unknown" : t.cooldownS >= 3600 ? `${t.cooldownS / 3600} h` : `${t.cooldownS} s`}</dd>
            <dt>Address</dt>
            <dd className="mono small">{t.address ? <a href={addressUrl(arena.network, t.chain, t.address)} target="_blank" rel="noopener noreferrer">{t.address}</a> : "unknown"}</dd>
          </dl>
          {st.status === "drained" && st.attemptId && (
            <p className="small">
              Won by attempt <span className="mono">{st.attemptId}</span>. This attack is now a regression test. The winning prompt and the payout transactions are on the <a href="/#winners">home page</a>.
            </p>
          )}
          <div className="prose small muted">
            <p>The contract caps each payout and waits {t.cooldownS ? `${t.cooldownS >= 3600 ? `${t.cooldownS / 3600} h` : `${t.cooldownS} s`}` : "a cooldown"} between rounds, so even a guard that is fully fooled can lose one round at a time.</p>
            <p>Limits: one attempt per account on this tier every 10 minutes, 20 per network per hour.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
