"use client";
import { ArrowRight } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import type { Arena } from "@/lib/arena";
import { chainTxUrl, CHAIN_OF, nearTxUrl } from "@/lib/links";
import { riskBand } from "@/lib/outcome";
import type { PublicAttempt, PublicData } from "@/lib/public-data";
import { TIER_INFO, potText } from "@/lib/tiers";
import { Countdown } from "./Countdown";
import { LivePublic } from "./Live";
import { StatusLabel } from "./Status";
import { UntrustedText } from "./UntrustedText";
import { useArena } from "./useArena";

export function Home({ arena, pub, live }: { arena: Arena; pub: PublicData; live: boolean }) {
  return live ? <LivePublic initial={pub}>{d => <HomeView initial={arena} pub={d} />}</LivePublic> : <HomeView initial={arena} pub={pub} />;
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function HomeView({ initial, pub }: { initial: Arena; pub: PublicData }) {
  const { arena, pots } = useArena(initial);
  const attemptsOf = (id: number) => pub.counters?.find(c => c.tier === id)?.attempts;
  // Near misses ranked by how close checkpoint B came to allowing the payout: the lowest blocking risk first.
  const near = [...(pub.nearMisses ?? [])].sort((a, b) => (a.fw_b?.risk ?? 100) - (b.fw_b?.risk ?? 100));

  return (
    <>
      <table className="tiers" aria-label="Tiers">
        <thead>
          <tr>
            <th scope="col">Tier</th>
            <th scope="col">Defense</th>
            <th scope="col">Pot</th>
            <th scope="col">Status</th>
            <th scope="col">Rounds left</th>
            <th scope="col">Attempts</th>
            <th scope="col">
              <span className="visually-hidden">Attack</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {arena.tiers.map(t => (
            <tr key={t.id} data-testid="tier-card">
              <td data-label="Tier">
                <span className="name">
                  {t.id} · {TIER_INFO[t.id].name}
                </span>
              </td>
              <td data-label="Defense" className="muted">
                {TIER_INFO[t.id].defense}
              </td>
              <td data-label="Pot" className="num" data-testid={`pot-${t.id}`}>
                {potText(pots[t.id]!, t.state.status === "drained" ? t.state.attemptId : undefined)}
              </td>
              <td data-label="Status">
                <StatusLabel status={t.state.status} />
                {t.state.status === "cooling" && t.state.nextRoundAt && (
                  <div className="small muted">
                    <Countdown until={t.state.nextRoundAt} template="next in {t}" />
                  </div>
                )}
              </td>
              <td data-label="Rounds left" className="num">
                {t.roundsLeft ?? "unknown"}
              </td>
              <td data-label="Attempts" className="num">
                {attemptsOf(t.id)?.toLocaleString("en-US") ?? "unknown"}
              </td>
              <td data-label="">
                <Link className={t.state.status === "open" ? "btn" : "btn ghost"} href={`/tier/${t.id}`} aria-label={`Attack tier ${t.id}`}>
                  {t.state.status === "open" ? "Attack" : "View"} <ArrowRight size={16} weight="bold" aria-hidden="true" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="panels section">
        <section aria-labelledby="winners-h" id="winners">
          <div className="section-head">
            <h2 id="winners-h">Top attackers</h2>
            <p className="muted small">Attempts that won a round. Shown by their payout address, shortened.</p>
          </div>
          <AttemptList rows={pub.winners} empty="No one has won a round yet." network={arena.network} win />
        </section>
        <section aria-labelledby="near-h">
          <div className="section-head">
            <h2 id="near-h">Near misses</h2>
            <p className="muted small">The agent agreed to pay, and the firewall stopped it.</p>
          </div>
          <AttemptList rows={near} empty="No near misses yet." network={arena.network} />
        </section>
      </div>
    </>
  );
}

function AttemptList({ rows, empty, network, win }: { rows: PublicAttempt[] | null; empty: string; network: Arena["network"]; win?: boolean }) {
  if (rows === null) return <p className="empty">Unavailable right now.</p>;
  if (!rows.length) return <p className="empty">{empty}</p>;
  return (
    <ul className="attempts">
      {rows.slice(0, 5).map(r => (
        <li key={r.id}>
          <div className="meta">
            <span>Tier {r.tier}</span>
            {win && r.payout && <span className="mono">{r.payout}</span>}
            {!win && r.fw_b && (
              <span>
                {r.fw_b.technique}, risk {riskBand(r.fw_b.risk)}
              </span>
            )}
            <span>{when(r.ts)}</span>
          </div>
          <UntrustedText text={r.message} label={`Attack message, tier ${r.tier}`} />
          {win && (
            <div className="meta">
              {r.near_tx && (
                <a href={nearTxUrl(network, r.near_tx)} target="_blank" rel="noopener noreferrer">
                  NEAR tx
                </a>
              )}
              {r.chain_txid && (
                <a href={chainTxUrl(network, CHAIN_OF[r.tier], r.chain_txid)} target="_blank" rel="noopener noreferrer">
                  {CHAIN_OF[r.tier] === "btc" ? "Bitcoin tx" : "Base tx"}
                </a>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
