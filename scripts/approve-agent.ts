// Approve a TEE agent on the vault from its own attestation.
//
//   bun scripts/approve-agent.ts --vault <vault> --owner <owner> --agent <implicit-account> \
//     [--tx <register_agent tx hash>] [--network testnet|mainnet] [--approve] [--dry-run]
//
// The agent's first register_agent call fails because nothing is approved yet,
// but its arguments carry the attestation. This reads the measurements from that
// call and proposes them, with the Phala PPIDs, as the owner. If the vault's
// timelock is short (testnet, 60 s) it waits and approves in the same run;
// otherwise run it again with --approve once the timelock has passed.
// Signs with the owner's key from the near-cli legacy keychain.
import { attestationFromTx, measurementsFromAttestation, PHALA_PPIDS, type Measurements } from "./lib/agent-approval";
import { isExpiredTx } from "./lib/vault-deploy";

const NET = {
  testnet: { rpc: "https://rpc.testnet.fastnear.com", blocks: "https://api-testnet.nearblocks.io" },
  mainnet: { rpc: "https://free.rpc.fastnear.com", blocks: "https://api.nearblocks.io" },
};
const MAX_WAIT_S = 300;

type Pending = { Measurements?: { measurements: Measurements }; Ppid?: { ppid: string } };

async function rpc(url: string, method: string, params: object) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "approve-agent", method, params }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error ?? body.result.error)}`);
  return body.result;
}

async function view<T>(url: string, vault: string, method: string): Promise<T> {
  const r = await rpc(url, "query", { request_type: "call_function", finality: "final", account_id: vault, method_name: method, args_base64: btoa("{}") });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
}

/** Newest register_agent transaction the agent sent to the vault. */
async function latestRegisterTx(blocks: string, vault: string, agent: string): Promise<string> {
  const res = await fetch(`${blocks}/v3/accounts/${vault}/txns?per_page=25`);
  const txs: { transaction_hash: string; signer_account_id: string; actions: { method?: string }[] }[] = (await res.json()).data ?? [];
  const tx = txs.find((t) => t.signer_account_id === agent && t.actions.some((a) => a.method === "register_agent"));
  if (!tx) throw new Error(`no register_agent call from ${agent} to ${vault} yet: fund the agent and wait for it to try`);
  return tx.transaction_hash;
}

function ownerCall(network: string, vault: string, owner: string, method: string, args: object) {
  const cmd = ["near", "contract", "call-function", "as-transaction", vault, method, "json-args", JSON.stringify(args),
    "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR", "sign-as", owner, "network-config", network, "sign-with-legacy-keychain", "send"];
  // An expired transaction never executed, so sending it again is safe.
  for (let attempt = 1; ; attempt++) {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    const out = p.stdout.toString() + p.stderr.toString();
    if (p.exitCode === 0) return;
    if (attempt < 3 && isExpiredTx(out)) continue;
    throw new Error(`${method} failed:\n${out.slice(-1000)}`);
  }
}

const same = (a: Measurements, b: Measurements) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const vault = flag("--vault");
  const owner = flag("--owner");
  const agent = flag("--agent");
  const network = (flag("--network") ?? "testnet") as keyof typeof NET;
  if (!vault || !owner || !agent || !NET[network]) {
    console.error("usage: bun scripts/approve-agent.ts --vault <vault> --owner <owner> --agent <implicit-account> [--tx <hash>] [--network testnet|mainnet] [--approve] [--dry-run]");
    process.exit(2);
  }
  const { rpc: url, blocks } = NET[network];

  const txHash = flag("--tx") ?? (await latestRegisterTx(blocks, vault, agent));
  const tx = await rpc(url, "EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: agent, wait_until: "NONE" });
  const m = measurementsFromAttestation(attestationFromTx(tx));
  console.log(`agent ${agent}, register_agent tx ${txHash}`);
  console.log(`measurements: ${JSON.stringify(m)}`);
  if (args.includes("--dry-run")) return;

  const approvedM = await view<Measurements[]>(url, vault, "get_approved_measurements");
  const approvedP = new Set(await view<string[]>(url, vault, "get_approved_ppids"));
  const pending = await view<Pending[]>(url, vault, "pending_owner_actions");
  const pendingM = pending.some((p) => p.Measurements && same(p.Measurements.measurements, m));
  const pendingP = new Set(pending.flatMap((p) => (p.Ppid ? [p.Ppid.ppid] : [])));
  const needM = !approvedM.some((a) => same(a, m));
  const toApproveP = PHALA_PPIDS.filter((p) => !approvedP.has(p));

  if (!args.includes("--approve")) {
    if (needM && !pendingM) {
      ownerCall(network, vault, owner, "propose_measurements", { measurements: m });
      console.log("proposed measurements");
    }
    const toProposeP = toApproveP.filter((p) => !pendingP.has(p));
    if (toProposeP.length) {
      ownerCall(network, vault, owner, "propose_ppids", { ppids: toProposeP });
      console.log(`proposed ${toProposeP.length} PPIDs`);
    }
    const { timelock_ns } = await view<{ timelock_ns: number }>(url, vault, "get_config");
    const waitS = Math.ceil(timelock_ns / 1e9) + 5;
    if (waitS > MAX_WAIT_S) {
      console.log(`timelock is ${waitS - 5} s: run again with --approve after ${new Date(Date.now() + waitS * 1000).toISOString()}`);
      return;
    }
    console.log(`waiting ${waitS} s for the timelock`);
    await Bun.sleep(waitS * 1000);
  }

  if (needM) {
    ownerCall(network, vault, owner, "approve_measurements", { measurements: m });
    console.log("approved measurements");
  }
  if (toApproveP.length) {
    ownerCall(network, vault, owner, "approve_ppids", { ppids: toApproveP });
    console.log(`approved ${toApproveP.length} PPIDs`);
  }
  console.log(`done. The agent registers on its next attempt; check with get_agent and scripts/check-agent-key.ts ${agent} --vault ${vault}`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
