// One row per claim, each with an icon, a word and the raw value. "Verified" is used only for what the agent's /attestation
// lists under verification.verified; everything under not_verified is labelled so.
import { CheckCircle, Info, MinusCircle, Warning, XCircle } from "@phosphor-icons/react/ssr";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CopyButton, DownloadJson } from "@/components/CopyDownload";
import { Countdown } from "@/components/Countdown";
import { callAgent } from "@/lib/agent";
import { codehashApproved, isMock, loadArena } from "@/lib/arena";
import { broadcastUrl, CHAIN_OF, nearTxUrl } from "@/lib/links";
import { loadPublic } from "@/lib/public-data";
import { span } from "@/lib/tiers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Verify" };

type Attestation = {
  codehash: string;
  checksum: string;
  prompt_sha256: Record<string, string>;
  models: Record<string, string>;
  judge_model: string;
  firewall_version: string;
  mock: boolean;
  tee?: boolean;
  verification:{ verified: string[]; not_verified: string[] };
};
// ok: a check this page ran and passed. info: a value reported by the agent or the contract, shown so you can compare it.
type Tone = "ok" | "bad" | "none" | "warn" | "info";
const ICON = { ok: CheckCircle, bad: XCircle, none: MinusCircle, warn: Warning, info: Info };
const WORD = { ok: "Passes", bad: "Fails", none: "Not checked", warn: "Needs attention", info: "Reported" };

async function attestation(): Promise<Attestation | null> {
  try {
    const r = await callAgent("/attestation");
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
// Written by CI at deploy. Absent until there is a published image.
async function imageDigest(): Promise<string | null> {
  try {
    return (await readFile(join(process.cwd(), "public", "image-digest.txt"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function Row({ tone, title, children, raw, testId }: { tone: Tone; title: string; children?: React.ReactNode; raw?: unknown; testId?: string }) {
  const I = ICON[tone];
  return (
    <li>
      <I size={20} weight="bold" aria-label={WORD[tone]} className={tone === "ok" ? "ok" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : tone === "info" ? "" : "muted"} />
      <div className="stack" style={{ gap: 6 }}>
        <h3>{title}</h3>
        <div className="small" data-testid={testId}>
          {children}
        </div>
      </div>
      {raw !== undefined && (
        <details>
          <summary>Raw value</summary>
          <pre className="raw">{typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)}</pre>
        </details>
      )}
    </li>
  );
}

const fmtTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export default async function VerifyPage() {
  const [att, arena, pub, digest] = await Promise.all([attestation(), loadArena(), loadPublic(), imageDigest()]);
  const approved = att ? await codehashApproved(att.codehash) : undefined;
  const digestMatch = digest && att ? digest.replace(/^sha256:/, "") === att.codehash.replace(/^sha256:/, "") : null;
  const mismatch = approved === false || digestMatch === false;
  const cfg = arena.config;
  const tee = att?.tee === true; // no agent build reports this yet (Task 10)
  const net = arena.network;

  return (
    <div className="stack">
      <header className="stack">
        <h1>Verify</h1>
        <p className="muted">What you can check yourself, and what is not checked yet. Each row links to its raw value.</p>
      </header>
      {isMock() && (
        <div className="banner">
          <Warning size={20} weight="bold" aria-label="Warning" className="warn" />
          <p>Demo data: this site runs with MOCK_AGENT=1, so every value below comes from fixtures, not from the agent or the chain.</p>
        </div>
      )}
      {mismatch && (
        <div className="banner bad" data-testid="mismatch-banner" role="alert">
          <XCircle size={20} weight="bold" aria-label="Fails" className="bad" />
          <p>
            <strong>Mismatch.</strong> The code the agent reports running is {approved === false ? "not approved in the vault contract" : "not the published image"}. Do not trust payouts from it.
          </p>
        </div>
      )}

      <ul className="checklist">
        <Row tone={tee ? "info" : "warn"} title={tee ? "Agent runs in a TEE: reported by the agent's /attestation" : "Agent runs in a TEE: not yet (testnet, stub codehash)"} testId="tee-row">
          {tee
            ? "The agent's /attestation says it runs in a TEE. This page does not check that itself."
            : "The agent runs on an ordinary server. The testnet vault registered it with a stub codehash, so the codehash below is a label the agent reports, not a measurement of the code it runs."}
        </Row>
        {/* Reported, not proven: without a TEE, the agent says which codehash it runs and the contract says that codehash is approved. */}
        <Row
          tone={approved === false ? "bad" : approved === true ? "info" : "none"}
          title="Codehash the agent reports is approved"
          raw={att ? { codehash: att.codehash, is_codehash_approved: approved ?? "unreadable" } : undefined}
        >
          <span data-testid="codehash-match">{approved === true ? "Match" : approved === false ? "Mismatch" : "Unknown: the agent or the contract cannot be read right now"}</span>
          {att && <div className="mono muted">{att.codehash}</div>}
        </Row>
        <Row tone={digestMatch === true ? "ok" : digestMatch === false ? "bad" : "none"} title="Running codehash equals the published image digest" raw={digest ?? undefined}>
          {digest === null ? "No image digest is published yet." : digestMatch ? "Match" : "Mismatch"}
        </Row>
        <Row tone={!att ? "none" : att.mock || att.verification.not_verified.length ? "warn" : "ok"} title="NEAR AI model attestation" raw={att?.verification}>
          {!att ? (
            "The agent cannot be reached, so its attestation is not shown."
          ) : att.mock ? (
            "The agent runs in mock mode: no attestation is performed."
          ) : (
            <>
              <p>What the agent checks on each model attestation, as its /attestation reports it:</p>
              <ul className="labels" aria-label="Attestation checks">
                {att.verification.verified.map(v => (
                  <li key={v}>
                    <CheckCircle size={16} weight="bold" className="ok" aria-hidden="true" />
                    <span className="mono">{v}</span>
                    <span className="ok">verified</span>
                  </li>
                ))}
                {att.verification.not_verified.map(v => (
                  <li key={v}>
                    <MinusCircle size={16} weight="bold" className="muted" aria-hidden="true" />
                    <span className="mono">{v}</span>
                    <span className="muted">not verified</span>
                  </li>
                ))}
              </ul>
              <div className="row" style={{ marginTop: 12 }}>
                <DownloadJson data={att} name="bulkhead-attestation.json" label="Download attestation JSON" />
              </div>
            </>
          )}
        </Row>
        <Row tone={att ? "info" : "none"} title="System prompt sha256 per tier" raw={att?.prompt_sha256}>
          {att ? (
            <dl className="facts">
              {Object.entries(att.prompt_sha256).map(([t, h]) => (
                <div key={t} style={{ display: "contents" }}>
                  <dt>Tier {t}</dt>
                  <dd className="mono">{h}</dd>
                </div>
              ))}
            </dl>
          ) : (
            "Unavailable."
          )}
        </Row>
        <Row tone={att ? "info" : "none"} title="Models, firewall version and config" raw={att ? { models: att.models, judge_model: att.judge_model, firewall_version: att.firewall_version, config_sha256: att.checksum } : undefined}>
          {att ? (
            <>
              Firewall <span className="mono">{att.firewall_version}</span>, judge <span className="mono">{att.judge_model}</span>, config sha256 <span className="mono">{att.checksum.slice(0, 16)}…</span>
            </>
          ) : (
            "Unavailable."
          )}
        </Row>
        <Row tone={cfg ? "info" : "none"} title="Cap and cooldown, read from the contract" raw={arena.tiers.map(t => ({ tier: t.id, max_release: t.maxRelease, rounds_left: t.roundsLeft, cooldown_s: t.cooldownS }))}>
          <ul className="labels">
            {arena.tiers.map(t => (
              <li key={t.id}>
                Tier {t.id}: max {t.maxRelease ?? "unknown"} per release, {t.roundsLeft ?? "unknown"} rounds left
                {t.state.status === "cooling" && t.state.nextRoundAt ? `, next at ${fmtTime(t.state.nextRoundAt)}` : ""}
              </li>
            ))}
          </ul>
        </Row>
        <Row tone={!cfg ? "none" : cfg.stub_attestation || cfg.paused || !cfg.locked ? "warn" : "ok"} title="Vault contract settings" raw={cfg ?? undefined} testId="settings-row">
          {cfg ? (
            <>
              {cfg.locked ? "Tiers are locked." : "Tiers are not locked yet: the owner can still change them."} {cfg.paused ? "The vault is paused." : "Not paused."} Owner timelock {span(cfg.timelock_ns / 1e9)}.
              {cfg.stub_attestation && " This build accepts agents without a real TEE attestation (stub_attestation)."}
            </>
          ) : (
            "The contract cannot be read right now."
          )}
        </Row>
        <Row tone="none" title="Agent key is function-call only">
          Not checked on this page yet.
        </Row>
        <Row tone="none" title="Vault account has 0 full-access keys">
          Not checked on this page yet.
        </Row>
        <Row tone="none" title="On-chain code_hash equals the reproducible wasm build">
          Not checked on this page yet.
        </Row>
        <Row tone={arena.pending === null ? "none" : arena.pending.length ? "warn" : "ok"} title="Pending owner actions" raw={arena.pending ?? undefined}>
          {arena.pending === null ? (
            "Unavailable."
          ) : !arena.pending.length ? (
            "None."
          ) : (
            <ul className="labels">
              {arena.pending.map((p, i) => (
                <li key={i}>
                  {p.kind === "codehash" ? (
                    <span>
                      New codehash <span className="mono">{p.codehash.slice(0, 12)}…</span>
                    </span>
                  ) : (
                    <span>
                      Emergency withdraw of tier {p.tierId} to <span className="mono">{p.to}</span>
                    </span>
                  )}
                  <span className="warn">
                    <Countdown until={p.readyAt} template="can run in {t}" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row tone={pub.pendingBroadcasts === null ? "none" : pub.pendingBroadcasts.length ? "warn" : "ok"} title="Signed payouts waiting for broadcast">
          {pub.pendingBroadcasts === null ? (
            "Unavailable."
          ) : !pub.pendingBroadcasts.length ? (
            "None."
          ) : (
            <ul className="attempts" data-testid="pending-broadcasts">
              {pub.pendingBroadcasts.map(p => {
                const chain = p.chain ?? CHAIN_OF[p.tier];
                return (
                  <li key={p.id}>
                    <div className="meta">
                      <span>Tier {p.tier}</span>
                      <span className="mono">{p.id}</span>
                      {p.near_tx && (
                        <a href={nearTxUrl(net, p.near_tx)} target="_blank" rel="noopener noreferrer">
                          NEAR tx
                        </a>
                      )}
                    </div>
                    {p.hex ? (
                      <>
                        <pre className="raw">{p.hex}</pre>
                        <div className="row">
                          <CopyButton text={p.hex} label="Copy signed tx" />
                          <a className="btn ghost" href={broadcastUrl(net, chain)} target="_blank" rel="noopener noreferrer">
                            Broadcast it yourself
                          </a>
                        </div>
                      </>
                    ) : (
                      <p className="muted">The contract signed this payout; the agent has not stored the assembled transaction yet.</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Row>
      </ul>
    </div>
  );
}
