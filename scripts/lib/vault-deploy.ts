// Pure parts of scripts/deploy-vault.ts: argument checks, tier address
// derivation and contract call arguments. No network or file access here.
import { ripemd160 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export type Network = "testnet" | "mainnet";

export const TESTNET_SIGNER = "v1.signer-prod.testnet";
// Same bounds as configure_tier in contracts/vault/src/lib.rs.
const MAX_COOLDOWN_S = 30 * 24 * 60 * 60;
const MAX_ROUNDS = 255;

export type DeployOptions = {
  owner: string;
  vault: string;
  agent: string;
  tier: number;
  path: string;
  maxSats: bigint;
  cooldownS: number;
  rounds: number;
};

const FLAGS = ["--owner", "--vault", "--agent", "--tier", "--max-sats", "--cooldown", "--rounds"] as const;

function int(flag: string, v: string, min: number, max: number): number {
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
    throw new Error(`${flag} must be a whole number from ${min} to ${max}, got "${v}"`);
  }
  return Number(v);
}

function testnetAccount(flag: string, v: string): string {
  if (!/^([a-z0-9]+[-_]?)*[a-z0-9]+(\.([a-z0-9]+[-_]?)*[a-z0-9]+)*\.testnet$/.test(v)) {
    throw new Error(`${flag} must be a NEAR testnet account (name.testnet), got "${v}". This script deploys to testnet only.`);
  }
  return v;
}

export function parseArgs(argv: string[]): DeployOptions {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!(FLAGS as readonly string[]).includes(flag)) throw new Error(`unknown flag ${flag}`);
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
    raw.set(flag, argv[i + 1]);
  }
  const need = (flag: string) => {
    const v = raw.get(flag);
    if (v === undefined) throw new Error(`${flag} is required`);
    return v;
  };

  const owner = testnetAccount("--owner", need("--owner"));
  const maxRaw = need("--max-sats");
  if (!/^\d+$/.test(maxRaw) || BigInt(maxRaw) === 0n) throw new Error(`--max-sats must be a positive whole number of sats, got "${maxRaw}"`);
  const tier = int("--tier", raw.get("--tier") ?? "1", 0, 3);
  const vault = testnetAccount("--vault", raw.get("--vault") ?? `vault.${owner}`);
  if (!vault.endsWith(`.${owner}`)) throw new Error(`--vault must be a sub-account of ${owner} (e.g. vault.${owner}), got "${vault}"`);
  return {
    owner,
    vault,
    agent: testnetAccount("--agent", raw.get("--agent") ?? owner),
    tier,
    path: `bulkhead-tier-${tier}`,
    maxSats: BigInt(maxRaw),
    cooldownS: int("--cooldown", need("--cooldown"), 0, MAX_COOLDOWN_S),
    rounds: int("--rounds", need("--rounds"), 1, MAX_ROUNDS),
  };
}

// ---- tier address from the signer's derived key ----

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const P = 2n ** 256n - 2n ** 32n - 977n;

function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const d = B58.indexOf(c);
    if (d < 0) throw new Error(`bad base58 character "${c}"`);
    n = n * 58n + BigInt(d);
  }
  const hex = n === 0n ? "" : n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0");
  const zeros = s.length - s.replace(/^1+/, "").length;
  return new Uint8Array([...new Uint8Array(zeros), ...hexToBytes(hex)]);
}

const mod = (a: bigint) => ((a % P) + P) % P;

/** Compressed SEC1 key from v1.signer's `secp256k1:<base58 of x||y>`. */
export function compressedKey(derived: string): Uint8Array {
  const [scheme, body] = derived.split(":");
  if (scheme !== "secp256k1" || !body) throw new Error(`expected a secp256k1:… key, got "${derived.slice(0, 20)}…"`);
  const raw = base58Decode(body);
  if (raw.length !== 64) throw new Error(`expected 64 key bytes, got ${raw.length}`);
  const x = BigInt("0x" + bytesToHex(raw.slice(0, 32)));
  const y = BigInt("0x" + bytesToHex(raw.slice(32)));
  if (mod(y * y - x * x * x - 7n) !== 0n) throw new Error("derived key is not on the secp256k1 curve");
  return new Uint8Array([y % 2n === 0n ? 2 : 3, ...raw.slice(0, 32)]);
}

// BIP-173 bech32 (witness v0 uses bech32, not bech32m).
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk = (chk ^ gen[i]) >>> 0;
  }
  return chk;
}

function toWords(bytes: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}

export function p2wpkhAddress(keyHashHex: string, network: Network): string {
  const hrp = network === "mainnet" ? "bc" : "tb";
  const data = [0, ...toWords(hexToBytes(keyHashHex))];
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = polymod([...expand, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (pm >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((d) => CHARSET[d]).join("");
}

/** P2WPKH address of the key v1.signer derives for (vault, path). */
export function tierAddress(derived: string, network: Network): string {
  return p2wpkhAddress(bytesToHex(ripemd160(sha256(compressedKey(derived)))), network);
}

/** near-cli-rs view of the tier key; `now` (block reference) must come after the network. */
export function derivedKeyCommand(o: DeployOptions): string[] {
  const args = JSON.stringify({ path: o.path, predecessor: o.vault, domain_id: 0 });
  return ["near", "contract", "call-function", "as-read-only", TESTNET_SIGNER, "derived_public_key", "json-args", args,
    "network-config", "testnet", "now"];
}

/** An expired transaction never executed, so sending it again cannot double-apply. */
export function isExpiredTx(output: string): boolean {
  return output.includes("Transaction has expired");
}

// ---- contract call arguments ----

export function initArgs(owner: string) {
  return { owner_id: owner, mpc_contract: TESTNET_SIGNER, mainnet: false };
}

export function configureTierArgs(o: DeployOptions, address: string) {
  return {
    id: o.tier,
    chain: "Bitcoin",
    derivation_path: o.path,
    address,
    max_release: o.maxSats.toString(),
    cooldown_s: o.cooldownS,
    rounds: o.rounds,
  };
}
