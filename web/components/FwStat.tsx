// The fw-v1 arena number, exactly as docs/firewall-versions.md has it, with its conditions next to it. Never a bare percentage.
import { ARENA_FW, REPO } from "@/lib/content";

export function FwStat() {
  const [head, ...rest] = ARENA_FW.line.split(" · ");
  return (
    <div className="stat" data-testid="fw-stat" aria-label={`Tier 3 firewall: ${ARENA_FW.line}`}>
      <span className="muted small">Tier 3 firewall, on attacks we wrote</span>
      <span className="value">{head}</span>
      <span className="muted small">{rest.join(" · ")}</span>
      <span className="muted small">
        The natural run failed its size gate: only {ARENA_FW.naturalReached} of 162 attacks got tier 1 to call the payout tool, too few to score. <a href={`${REPO}/${ARENA_FW.source}`}>How it was measured</a>
      </span>
    </div>
  );
}
