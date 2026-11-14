// Check a deployed vault before launch (E3): no stub, 24 h timelock, and the
// on-chain code is exactly this wasm. With --expect-locked, also check that
// launch_lock was called and the vault account has no access keys left.
//
//   bun scripts/check-mainnet-wasm.ts <wasm> --vault <account> [--network mainnet|testnet] [--rpc <url>] [--expect-locked]
//
// Exits 0 only when every check passes. Build the wasm with
// `cargo near build reproducible-wasm` so anyone can rebuild the same bytes.
import { codeHash, mainnetProblems, type VaultConfig } from "./lib/mainnet-check";

const RPC = { mainnet: "https://free.rpc.fastnear.com", testnet: "https://rpc.testnet.fastnear.com" };

async function query(rpc: string, params: object) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "check-mainnet-wasm", method: "query", params: { finality: "final", ...params } }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(`RPC error: ${JSON.stringify(body.error ?? body.result.error)}`);
  return body.result;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const wasmPath = args[0];
  const vault = flag("--vault");
  const network = flag("--network") ?? "mainnet";
  if (!wasmPath || wasmPath.startsWith("--") || !vault || (network !== "mainnet" && network !== "testnet")) {
    console.error("usage: bun scripts/check-mainnet-wasm.ts <wasm> --vault <account> [--network mainnet|testnet] [--rpc <url>] [--expect-locked]");
    process.exit(2);
  }
  const rpc = flag("--rpc") ?? RPC[network];
  const wasm = new Uint8Array(await Bun.file(wasmPath).arrayBuffer());

  const account = await query(rpc, { request_type: "view_account", account_id: vault });
  const keys = await query(rpc, { request_type: "view_access_key_list", account_id: vault });
  const view = await query(rpc, { request_type: "call_function", account_id: vault, method_name: "get_config", args_base64: btoa("{}") });
  const config: VaultConfig = JSON.parse(new TextDecoder().decode(new Uint8Array(view.result)));

  const problems = mainnetProblems({
    wasm,
    config,
    onchainCodeHash: account.code_hash,
    network,
    expectLocked: args.includes("--expect-locked"),
    accessKeyCount: keys.keys.length,
  });
  console.log(`${vault} on ${network}: code_hash ${account.code_hash}, local wasm ${codeHash(wasm)}, ${keys.keys.length} access key(s), config ${JSON.stringify(config)}`);
  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(problems.length === 0 ? "PASS" : `${problems.length} problem(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
