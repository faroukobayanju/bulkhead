import { describe, expect, test } from "bun:test";
import { base58Encode, codeHash, mainnetProblems, wasmExports, type VaultConfig } from "../lib/mainnet-check";

// A minimal valid wasm module exporting one no-op function per name.
function wasmWith(names: string[]): Uint8Array {
  const n = names.length;
  const section = (id: number, body: number[]) => [id, body.length, ...body];
  const exports = names.flatMap((name, i) => [name.length, ...new TextEncoder().encode(name), 0x00, i]);
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [n, ...Array(n).fill(0)]),
    ...section(7, [n, ...exports]),
    ...section(10, [n, ...Array(n).fill([2, 0, 0x0b]).flat()]),
  ]);
}

const DAY_NS = 86_400_000_000_000;
const goodConfig: VaultConfig = { timelock_ns: DAY_NS, mainnet: true, stub_attestation: false, locked: true, paused: false };
const wasm = wasmWith(["release_funds", "register_agent"]);
const good = { wasm, config: goodConfig, onchainCodeHash: codeHash(wasm), network: "mainnet" as const, expectLocked: true, accessKeyCount: 0 };

describe("base58 and code hash", () => {
  test("base58 vectors", () => {
    expect(base58Encode(new Uint8Array([]))).toBe("");
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58Encode(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
  });

  test("code hash is base58 of sha256, as NEAR reports it", () => {
    expect(codeHash(new Uint8Array([]))).toBe("GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn");
  });
});

describe("wasm exports", () => {
  test("lists exported function names", () => {
    expect(wasmExports(wasmWith(["release_funds", "register_agent_stub"]))).toEqual(["release_funds", "register_agent_stub"]);
  });
});

describe("mainnet problems", () => {
  test("a locked, keyless mainnet vault running the reviewed wasm passes", () => {
    expect(mainnetProblems(good)).toEqual([]);
  });

  test("a wasm that exports the stub fails", () => {
    const stub = wasmWith(["release_funds", "register_agent_stub"]);
    expect(mainnetProblems({ ...good, wasm: stub, onchainCodeHash: codeHash(stub) }).join()).toContain("register_agent_stub");
  });

  test("stub flag, short timelock or a testnet vault on mainnet fail", () => {
    expect(mainnetProblems({ ...good, config: { ...goodConfig, stub_attestation: true } }).join()).toContain("stub_attestation");
    expect(mainnetProblems({ ...good, config: { ...goodConfig, timelock_ns: 60_000_000_000 } }).join()).toContain("timelock");
    expect(mainnetProblems({ ...good, config: { ...goodConfig, mainnet: false } }).join()).toContain("mainnet");
  });

  test("on-chain code that is not this wasm fails", () => {
    expect(mainnetProblems({ ...good, onchainCodeHash: codeHash(wasmWith(["other"])) }).join()).toContain("code_hash");
  });

  test("with --expect-locked: not locked, or any access key left, fails", () => {
    expect(mainnetProblems({ ...good, config: { ...goodConfig, locked: false } }).join()).toContain("launch_lock");
    expect(mainnetProblems({ ...good, accessKeyCount: 1 }).join()).toContain("access key");
  });

  test("before launch, lock and keys are not checked", () => {
    expect(mainnetProblems({ ...good, expectLocked: false, config: { ...goodConfig, locked: false }, accessKeyCount: 1 })).toEqual([]);
  });

  test("on testnet the mainnet flag is not required", () => {
    expect(mainnetProblems({ ...good, network: "testnet", config: { ...goodConfig, mainnet: false } })).toEqual([]);
  });
});
