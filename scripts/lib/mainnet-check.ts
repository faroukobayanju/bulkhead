// Pure parts of scripts/check-mainnet-wasm.ts (E3). No network or file access here.
import { sha256 } from "@noble/hashes/sha2";

export type VaultConfig = { timelock_ns: number; mainnet: boolean; stub_attestation: boolean; locked: boolean; paused: boolean };

export type CheckInput = {
  wasm: Uint8Array;
  config: VaultConfig;
  onchainCodeHash: string;
  network: "mainnet" | "testnet";
  /** After launch_lock and key deletion: the vault must be locked and keyless. */
  expectLocked: boolean;
  accessKeyCount: number;
};

const DAY_NS = 86_400_000_000_000;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** NEAR's `code_hash`: base58 of the sha256 of the deployed wasm. */
export function codeHash(wasm: Uint8Array): string {
  return base58Encode(sha256(wasm));
}

export function wasmExports(wasm: Uint8Array): string[] {
  return WebAssembly.Module.exports(new WebAssembly.Module(wasm)).map((e) => e.name);
}

/** Every reason this vault is not safe to launch or call launched. Empty means pass. */
export function mainnetProblems(c: CheckInput): string[] {
  const problems: string[] = [];
  if (wasmExports(c.wasm).includes("register_agent_stub")) problems.push("wasm exports register_agent_stub (built with the stub-attestation feature)");
  if (c.config.stub_attestation) problems.push("get_config reports stub_attestation: true");
  if (c.config.timelock_ns !== DAY_NS) problems.push(`timelock is ${c.config.timelock_ns} ns, not 24 h (${DAY_NS})`);
  if (c.network === "mainnet" && !c.config.mainnet) problems.push("vault was initialised with mainnet: false");
  if (c.onchainCodeHash !== codeHash(c.wasm)) problems.push(`on-chain code_hash ${c.onchainCodeHash} is not this wasm (${codeHash(c.wasm)})`);
  if (c.expectLocked) {
    if (!c.config.locked) problems.push("launch_lock has not been called");
    if (c.accessKeyCount > 0) problems.push(`vault account still has ${c.accessKeyCount} access key(s); delete them all so the code can never change`);
  }
  return problems;
}
