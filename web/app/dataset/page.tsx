import { DownloadSimple } from "@phosphor-icons/react/ssr";
import { REPO } from "@/lib/content";
import { loadPublic } from "@/lib/public-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dataset" };

const DATASET_URL = process.env.DATASET_URL || "https://github.com/faroukobayanju/bulkhead/tree/main/dataset";

export default async function DatasetPage() {
  const { counters } = await loadPublic();
  const total = counters?.reduce((n, c) => n + c.attempts, 0);
  return (
    <div className="stack">
      <header className="stack">
        <h1>Every attempt, published</h1>
        <p className="muted">One JSONL file per UTC day, with the Merkle root of each hour written to the vault contract. CC-BY 4.0.</p>
      </header>
      <div className="row">
        <a className="btn" href={DATASET_URL}>
          <DownloadSimple size={16} weight="bold" aria-hidden="true" /> Download the dataset
        </a>
        <a className="btn ghost" href={`${REPO}/dataset/README.md`}>
          Column schema
        </a>
      </div>

      <section className="section" aria-labelledby="count-h">
        <div className="section-head">
          <h2 id="count-h">Attempts so far</h2>
          <p className="muted small">Counted as each attempt is written. A day is published after it ends, so the files trail these counts by up to a day.</p>
        </div>
        {counters === null ? (
          <p className="empty">Counts are unavailable right now.</p>
        ) : (
          <table className="datatable" style={{ maxWidth: 520 }}>
            <thead>
              <tr>
                <th scope="col">Tier</th>
                <th scope="col">Attempts</th>
                <th scope="col">Near misses</th>
              </tr>
            </thead>
            <tbody>
              {counters.map(c => (
                <tr key={c.tier}>
                  <td>Tier {c.tier}</td>
                  <td className="mono">{c.attempts.toLocaleString("en-US")}</td>
                  <td className="mono">{c.nearMisses.toLocaleString("en-US")}</td>
                </tr>
              ))}
              <tr>
                <td>All</td>
                <td className="mono" data-testid="row-total">
                  {total!.toLocaleString("en-US")}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section className="section split" aria-labelledby="roots-h">
        <div className="prose">
          <h2 id="roots-h">Check a day against the chain</h2>
          <p className="muted">The script recomputes every leaf from the rows, rebuilds each hour's root, reads the roots the agent wrote to the vault, and exits 0 only if every hour matches. It needs no keys or wallet.</p>
          <pre className="code">bun run scripts/verify-roots.ts 2026-11-10 --vault &lt;vault account&gt;</pre>
          <p className="small muted">
            Add <span className="mono">--rpc https://rpc.testnet.near.org</span> for a testnet vault. How leaves and roots are built is in the <a href={`${REPO}/dataset/README.md`}>dataset README</a>.
          </p>
        </div>
        <div className="prose">
          <h2>What is in it</h2>
          <ul className="muted">
            <li>The message exactly as the player wrote it, anything typed into it included. The reply shown, the outcome and the firewall verdicts with their full reasons.</li>
            <li>The player's account only as a salted sha256. Never the account name or IP.</li>
            <li>A winner's payout address, shortened. Outside the message, every other payout address is replaced with a placeholder.</li>
            <li>A winner's full address is not hidden anywhere: it is in the signed payout transaction, listed on /verify and public on the chain.</li>
            <li>Rows hidden from the site after reports stay in the dataset.</li>
          </ul>
          <p className="small">
            License: <a href="https://creativecommons.org/licenses/by/4.0/">CC-BY 4.0</a>. Credit "Drain Me / Bulkhead attempts dataset".
          </p>
        </div>
      </section>
    </div>
  );
}
