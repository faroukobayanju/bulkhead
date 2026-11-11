// Check that an agent account can only call the vault, and only its two agent methods.
//
//   bun scripts/check-agent-key.ts <agent-account> --vault <vault-account> [--rpc <url>]
//
// Exits 0 only when every access key on the agent account is a FunctionCall key
// for the vault, limited to release_funds and log_attempt_roots, with an allowance
// of at most 1 NEAR. The agent runs the same check on itself before serving.

export const AGENT_METHODS = ["log_attempt_roots", "release_funds"];
const MAX_ALLOWANCE = 10n ** 24n; // 1 NEAR in yoctoNEAR
const TESTNET_RPC = "https://rpc.testnet.fastnear.com";

type Permission =
  | "FullAccess"
  | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } };

export type AccessKeyInfo = { access_key: { permission: Permission } };

export function keysAreScoped(keys: AccessKeyInfo[], vault: string): boolean {
  if (keys.length === 0) return false;
  return keys.every(({ access_key: { permission } }) => {
    if (permission === "FullAccess") return false;
    const { receiver_id, method_names, allowance } = permission.FunctionCall;
    // A null allowance is unlimited; an empty method list allows any method.
    return (
      receiver_id === vault &&
      allowance !== null &&
      BigInt(allowance) <= MAX_ALLOWANCE &&
      [...method_names].sort().join(",") === AGENT_METHODS.join(",")
    );
  });
}

async function accessKeys(rpc: string, account: string): Promise<AccessKeyInfo[]> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "check-agent-key",
      method: "query",
      params: { request_type: "view_access_key_list", finality: "final", account_id: account },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(`RPC error for ${account}: ${JSON.stringify(body.error ?? body.result.error)}`);
  return body.result.keys;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const agent = args[0];
  const vault = flag("--vault");
  if (!agent || agent.startsWith("--") || !vault) {
    console.error("usage: bun scripts/check-agent-key.ts <agent-account> --vault <vault-account> [--rpc <url>]");
    process.exit(2);
  }
  const keys = await accessKeys(flag("--rpc") ?? TESTNET_RPC, agent);
  const ok = keysAreScoped(keys, vault);
  console.log(`${agent}: ${keys.length} key(s), ${ok ? "scoped to" : "NOT scoped to"} ${vault} (${AGENT_METHODS.join(", ")}, allowance <= 1 NEAR)`);
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
