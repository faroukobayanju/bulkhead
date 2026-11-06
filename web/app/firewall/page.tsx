// Every number here comes from lib/content.ts, which content.test.ts checks against the docs it names.
import { CopyButton } from "@/components/CopyDownload";
import { ARENA_FW, CURL_GENERAL, CURL_STRICT, GENERAL_EVAL, GUARDED_SNIPPET, PUBLIC_BASELINES, REPO } from "@/lib/content";

export const metadata = { title: "Firewall API" };

function Code({ code, label }: { code: string; label: string }) {
  return (
    <figure className="stack" style={{ margin: 0 }}>
      <figcaption className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted small">{label}</span>
        <CopyButton text={code} />
      </figcaption>
      <pre className="code" tabIndex={0} aria-label={label}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

const ERRORS: [string, string, string][] = [
  ["401", "missing_api_key", "send x-api-key"],
  ["401", "invalid_api_key", "the key is unknown"],
  ["400", "bad_json / bad_request", "the body is not JSON, or does not match the request table"],
  ["413", "body_too_large", "send at most 16,384 bytes"],
  ["429", "rate_limited", "wait Retry-After seconds"],
  ["503", "budget_exhausted", "the daily budget is used up; it resets at 00:00 UTC. Never a block: no verdict was made"],
  ["503", "budget_unavailable, key_lookup_unavailable, signing_unavailable", "retry"],
];

export default function FirewallPage() {
  return (
    <div className="stack">
      <header className="stack">
        <h1>A firewall call before your agent acts</h1>
        <p className="muted">
          <span className="mono">POST /v1/check</span> rates a conversation and the action your agent is about to take, and answers allow, escalate or block. Every answer is signed by the agent key registered in the vault contract.
        </p>
      </header>

      <section className="section" aria-labelledby="m-h">
        <div className="section-head">
          <h2 id="m-h">Measured</h2>
          <p className="muted small">All single-turn. Each number links to the run that produced it.</p>
        </div>
        <div className="metrics">
          <div className="metric">
            <span className="muted small">General mode, attacks stopped</span>
            <span className="value">{GENERAL_EVAL.summary.attacksStopped}</span>
            <span className="small muted">
              holdout, {GENERAL_EVAL.summary.cases}, <a href={`${REPO}/${GENERAL_EVAL.source}`}>eval-general.md</a>
            </span>
          </div>
          <div className="metric">
            <span className="muted small">General mode, legitimate requests allowed</span>
            <span className="value">{GENERAL_EVAL.summary.legitAllowed}</span>
            <span className="small muted">0 false blocks, 1 escalated; p95 {GENERAL_EVAL.summary.p95}</span>
          </div>
          <div className="metric">
            <span className="muted small">Arena block rate, {ARENA_FW.version}</span>
            <span className="value" style={{ fontSize: 22 }}>
              {ARENA_FW.blockRate}
            </span>
            <span className="small muted">
              <a href={`${REPO}/${ARENA_FW.source}`}>firewall-versions.md</a>
            </span>
          </div>
        </div>
        <pre className="code small" style={{ marginTop: 24 }} aria-label="General mode holdout output">
          {GENERAL_EVAL.lines.join("\n")}
        </pre>
        <p className="small muted" style={{ marginTop: 12 }}>
          All three missed attacks broke a number limit with no trick wording. A model is weak at checking numbers against a limit: enforce hard limits in code or in a contract, as the Drain Me vault does.
        </p>

        <h3 style={{ marginTop: 32 }}>Attack sets we did not write</h3>
        <p className="small muted">Checkpoint A only, one exploratory run each. These are not {ARENA_FW.version} eval numbers.</p>
        <div className="scroll-x">
          <table className="datatable" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th scope="col">Set</th>
                <th scope="col">Mode</th>
                <th scope="col">Blocked</th>
                <th scope="col">Heuristics only</th>
                <th scope="col">p95</th>
              </tr>
            </thead>
            <tbody>
              {PUBLIC_BASELINES.rows.map(r => (
                <tr key={r.set + r.mode}>
                  <td>{r.set}</td>
                  <td>{r.mode}</td>
                  <td className="mono">{r.blocked}</td>
                  <td className="mono">{r.heuristics}</td>
                  <td className="mono">{r.p95}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          Source: <a href={`${REPO}/${PUBLIC_BASELINES.source}`}>public-baselines.md</a>
        </p>
      </section>

      <section className="section stack" aria-labelledby="use-h">
        <h2 id="use-h">Use it</h2>
        <Code label="Strict mode: the arena's rules, the agent must never pay anyone" code={CURL_STRICT} />
        <Code label="General mode: your own tools and rules in policy" code={CURL_GENERAL} />
        <ul className="prose small muted">
          <li>Write policy yourself, in your own code. Never build it from anything an end user or a web page wrote: whoever controls the policy controls the verdict.</li>
          <li>A proposed tool that is not in policy.tools is always a block.</li>
          <li>The firewall lowers the chance your agent gets tricked. It does not limit what a tricked agent can spend. For a hard limit, hold the funds in a contract that enforces one.</li>
        </ul>
        <Code label="Around a Shade Agent tool call, with guardedCall from shared/guarded-call.ts" code={GUARDED_SNIPPET} />
        <p className="small muted">Only an explicit allow, or an escalate a human approves, runs the action. A thrown check or an unknown verdict never does.</p>
      </section>

      <section className="section" aria-labelledby="ref-h">
        <div className="section-head">
          <h2 id="ref-h">Reference</h2>
        </div>
        <div className="split">
          <div className="prose small">
            <p>
              <strong>verdict</strong>: allow below risk 40, escalate from 40 to 69, block from 70. Drain Me treats escalate as block.
            </p>
            <p>
              <strong>Degraded</strong>: if the judge fails or takes over 3.5 s, the answer is HTTP 200, block, risk 100, reason judge_unavailable, with the header <span className="mono">x-firewall-degraded: 1</span>. Retry.
            </p>
            <p>
              <strong>Verify a verdict</strong>: ed25519 over sha256 of the canonical JSON without the signature, by the key in the vault's agent record. A short verify.ts is in the API docs.
            </p>
            <p>
              Full API docs: <a href={`${REPO}/docs/firewall-api.md`}>docs/firewall-api.md</a>. Key issuance on this page is not built yet.
            </p>
          </div>
          <div className="scroll-x" id="errors">
            <table className="datatable">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Code</th>
                  <th scope="col">What to do</th>
                </tr>
              </thead>
              <tbody>
                {ERRORS.map(([s, c, w]) => (
                  <tr key={c}>
                    <td className="mono">{s}</td>
                    <td className="mono">{c}</td>
                    <td>{w}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
