import { describe, expect, test } from "bun:test";
import { configureTierArgs, derivedKeyCommand, initArgs, isExpiredTx, p2wpkhAddress, parseArgs, tierAddress } from "../lib/vault-deploy";

// derived_public_key("bulkhead-tier-1", vault.bulkhead-haikeys.testnet, domain 0) on
// v1.signer-prod.testnet. Spike S1 spent from this address on testnet4, so the pair is proven.
const S1_KEY =
  "secp256k1:2uQDMhqCaRrFVW4mNWv2VchYtcagNAWPyUEWMjzdJkdcf76FcUAgpkFUWzwDtER5TmXagPH2pFFQAc9op3kjudX9";
const S1_ADDR = "tb1qvg2du726tmgjzcz89m6zj7dcdzdcyeja7z9zx5";

describe("tier address", () => {
  test("matches the address spike S1 spent from", () => {
    expect(tierAddress(S1_KEY, "testnet")).toBe(S1_ADDR);
  });

  test("BIP-173 P2WPKH vectors on both networks", () => {
    const hash = "751e76e8199196d454941c45d1b3a323f1433bd6";
    expect(p2wpkhAddress(hash, "testnet")).toBe("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
    expect(p2wpkhAddress(hash, "mainnet")).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  });

  test("rejects a key that is not secp256k1", () => {
    expect(() => tierAddress("ed25519:2uQDMhqCaRrFVW4mNWv2VchYtcagNAWPyUEWMjzdJkdcf76FcUAgpkFUWzwDtER5TmXagPH2pFFQAc9op3kjudX9", "testnet")).toThrow("secp256k1");
  });

  test("rejects a point that is not on the curve", () => {
    // Same base58 length, one character changed: still 64 bytes, but off the curve.
    const bad = S1_KEY.slice(0, -1) + (S1_KEY.endsWith("9") ? "8" : "9");
    expect(() => tierAddress(bad, "testnet")).toThrow("curve");
  });
});

describe("arguments", () => {
  const base = ["--owner", "alice.testnet", "--max-sats", "100000", "--cooldown", "3600", "--rounds", "5"];

  test("defaults: vault account, tier 1, path and agent", () => {
    const o = parseArgs(base);
    expect(o.vault).toBe("vault.alice.testnet");
    expect(o.tier).toBe(1);
    expect(o.path).toBe("bulkhead-tier-1");
    expect(o.agent).toBe("alice.testnet");
    expect(o.maxSats).toBe(100_000n);
  });

  test("explicit vault, tier and agent", () => {
    const o = parseArgs([...base, "--vault", "v2.alice.testnet", "--tier", "3", "--agent", "bot.alice.testnet"]);
    expect(o.vault).toBe("v2.alice.testnet");
    expect(o.path).toBe("bulkhead-tier-3");
    expect(o.agent).toBe("bot.alice.testnet");
  });

  test("vault must be a sub-account of the owner, so the owner can create it", () => {
    expect(() => parseArgs([...base, "--vault", "vault.bob.testnet"])).toThrow("sub-account of alice.testnet");
  });

  test("testnet only", () => {
    expect(() => parseArgs(["--owner", "alice.near", "--max-sats", "1", "--cooldown", "1", "--rounds", "1"])).toThrow("testnet");
    expect(() => parseArgs([...base, "--vault", "vault.alice.near"])).toThrow("testnet");
  });

  test("required flags", () => {
    expect(() => parseArgs(["--max-sats", "1", "--cooldown", "1", "--rounds", "1"])).toThrow("--owner");
    expect(() => parseArgs(["--owner", "alice.testnet", "--cooldown", "1", "--rounds", "1"])).toThrow("--max-sats");
  });

  test("same bounds as the contract", () => {
    const with_ = (flag: string, v: string) => base.map((x, i) => (base[i - 1] === flag ? v : x));
    expect(() => parseArgs(with_("--rounds", "0"))).toThrow("--rounds");
    expect(() => parseArgs(with_("--rounds", "256"))).toThrow("--rounds");
    expect(() => parseArgs(with_("--cooldown", String(30 * 24 * 3600 + 1)))).toThrow("--cooldown");
    expect(() => parseArgs(with_("--max-sats", "0"))).toThrow("--max-sats");
    expect(() => parseArgs(with_("--max-sats", "1.5"))).toThrow("--max-sats");
    expect(() => parseArgs([...base, "--tier", "4"])).toThrow("--tier");
  });

  test("unknown flag is an error, not ignored", () => {
    expect(() => parseArgs([...base, "--max-btc", "1"])).toThrow("--max-btc");
  });
});

describe("near-cli commands", () => {
  test("an expired transaction is safe to resend; other failures are not", () => {
    expect(isExpiredTx("Error: \u001b[91mError: Transaction has expired.\u001b[0m")).toBe(true);
    expect(isExpiredTx("Error: Smart contract panicked: ERR_NOT_OWNER")).toBe(false);
    expect(isExpiredTx("")).toBe(false);
  });

  test("derived key view puts 'now' after the network, as near-cli-rs requires", () => {
    const o = parseArgs(["--owner", "alice.testnet", "--max-sats", "1", "--cooldown", "1", "--rounds", "1"]);
    expect(derivedKeyCommand(o)).toEqual([
      "near", "contract", "call-function", "as-read-only", "v1.signer-prod.testnet", "derived_public_key",
      "json-args", JSON.stringify({ path: "bulkhead-tier-1", predecessor: "vault.alice.testnet", domain_id: 0 }),
      "network-config", "testnet", "now",
    ]);
  });
});

describe("contract call arguments", () => {
  test("init uses the testnet signer", () => {
    expect(initArgs("alice.testnet")).toEqual({ owner_id: "alice.testnet", mpc_contract: "v1.signer-prod.testnet", mainnet: false });
  });

  test("configure_tier matches the contract signature", () => {
    const o = parseArgs(["--owner", "alice.testnet", "--max-sats", "100000", "--cooldown", "3600", "--rounds", "5"]);
    expect(configureTierArgs(o, S1_ADDR)).toEqual({
      id: 1,
      chain: "Bitcoin",
      derivation_path: "bulkhead-tier-1",
      address: S1_ADDR,
      max_release: "100000",
      cooldown_s: 3600,
      rounds: 5,
    });
  });
});
