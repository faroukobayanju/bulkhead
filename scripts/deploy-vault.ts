// Deploy your own Bulkhead vault on NEAR testnet in one command.
//
//   bun scripts/deploy-vault.ts --owner <you>.testnet --max-sats 100000 --cooldown 3600 --rounds 5 \
//     [--vault vault.<you>.testnet] [--tier 1] [--agent <agent>.testnet | --tee]
//
// Without --tee the build includes register_agent_stub and the owner registers a dev
// agent. With --tee there is no stub: the agent registers itself from a Phala TEE,
// and the owner approves its measurements and PPID with a 60 s testnet timelock.
//
// Needs cargo-near and near-cli-rs, and the owner's key in the near-cli legacy
// keychain (~/.near-credentials). Testnet only. See docs/deploy-your-vault.md.
import { buildFeatures, configureTierArgs, derivedKeyCommand, initArgs, isExpiredTx, parseArgs, TESTNET_SIGNER, tierAddress, type DeployOptions } from "./lib/vault-deploy";

const REPO = new URL("..", import.meta.url).pathname;
const WASM = `${REPO}contracts/target/near/bulkhead_vault/bulkhead_vault.wasm`;

function run(cmd: string[], cwd = REPO): string {
  // Testnet RPC sometimes reports a fresh transaction as expired; it never ran, so resend it.
  for (let attempt = 1; ; attempt++) {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    const out = p.stdout.toString() + p.stderr.toString();
    if (p.exitCode === 0) return out;
    if (attempt < 3 && isExpiredTx(out)) continue;
    throw new Error(`${cmd.slice(0, 3).join(" ")} failed:\n${out.slice(-1500)}`);
  }
}

const send = (...args: string[]) => run(["near", ...args, "network-config", "testnet", "sign-with-legacy-keychain", "send"]);

function accountExists(id: string): boolean {
  const p = Bun.spawnSync(["near", "account", "view-account-summary", id, "network-config", "testnet", "now"], { stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0;
}

function call(o: DeployOptions, method: string, args: object) {
  send("contract", "call-function", "as-transaction", o.vault, method, "json-args", JSON.stringify(args),
    "prepaid-gas", "30 Tgas", "attached-deposit", "0 NEAR", "sign-as", o.owner);
}

function main() {
  let o: DeployOptions;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${(e as Error).message}\n\nusage: bun scripts/deploy-vault.ts --owner <you>.testnet --max-sats <sats> --cooldown <seconds> --rounds <n> [--vault vault.<you>.testnet] [--tier 0-3] [--agent <account>.testnet | --tee]`);
    process.exit(2);
  }
  for (const tool of ["cargo-near", "near"]) {
    if (!Bun.which(tool)) throw new Error(`${tool} not found: install it first (docs/deploy-your-vault.md)`);
  }
  if (accountExists(o.vault)) throw new Error(`${o.vault} already exists. Pick a new --vault; this script only deploys fresh vaults.`);

  console.log(`1/5 building the vault wasm (testnet build, ${o.tee ? "TEE agent, 60 s timelock" : "stub agent registration"})`);
  run(["cargo", "near", "build", "non-reproducible-wasm", "--no-abi", "--features", buildFeatures(o), "--out-dir", "../target/near/bulkhead_vault"],
    `${REPO}contracts/vault`);

  // The ~800 KB wasm (TDX quote checks included) needs about 8.1 NEAR of storage; the rest pays for state.
  console.log(`2/5 creating ${o.vault} (9 NEAR from ${o.owner})`);
  send("account", "create-account", "fund-myself", o.vault, "9 NEAR", "autogenerate-new-keypair", "save-to-legacy-keychain", "sign-as", o.owner);

  console.log(`3/5 deploying and initialising with signer ${TESTNET_SIGNER}`);
  send("contract", "deploy", o.vault, "use-file", WASM, "with-init-call", "new", "json-args", JSON.stringify(initArgs(o.owner)),
    "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR");

  console.log(`4/5 deriving tier ${o.tier}'s Bitcoin address from the signer`);
  const view = run(derivedKeyCommand(o));
  const key = view.match(/secp256k1:[1-9A-HJ-NP-Za-km-z]+/)?.[0];
  if (!key) throw new Error(`no derived key in signer reply:\n${view.slice(-500)}`);
  const address = tierAddress(key, "testnet");

  console.log(`5/5 configuring tier ${o.tier}${o.tee ? "" : ` and registering agent ${o.agent}`}`);
  call(o, "configure_tier", configureTierArgs(o, address));
  if (!o.tee) call(o, "register_agent_stub", { account: o.agent });

  console.log(`
Vault ready: ${o.vault} (owner ${o.owner})
Tier ${o.tier}: cap ${o.maxSats} sats per release, cooldown ${o.cooldownS} s, ${o.rounds} rounds
Fund this Bitcoin testnet4 address, one coin of at most ${o.maxSats} sats per round:
  ${address}
${o.tee
    ? "Agent: none yet. Fund the TEE agent, read its measurements and PPID from its first register_agent call, then propose_* and approve_* them (60 s apart)."
    : `Agent allowed to call release_funds: ${o.agent}`}
Check: near contract call-function as-read-only ${o.vault} get_tier json-args '{"id":${o.tier}}' network-config testnet now`);
}

try {
  main();
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
