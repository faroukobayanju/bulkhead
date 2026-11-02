// Payout addresses (E9), checked with the rules the contract uses: bech32/bech32m for the network's prefix on Bitcoin, and
// EIP-55 on Base. Player input and model output both go through here, so anything odd is refused rather than repaired.
import { bech32, bech32m } from "@scure/base";
import { getAddress, isAddress } from "viem";

export type Chain = "btc" | "evm";
export const CHAIN: Record<1 | 2 | 3, Chain> = { 1: "btc", 2: "evm", 3: "btc" };
export type Hrp = "bc" | "tb";

// `address` is what goes to the contract. Two strings name the same payee exactly when their `key`s are equal.
export type Payee = { address: string; key: string };

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// ponytail: witness versions 0 (P2WPKH, P2WSH) and 1 (taproot) only. v2+ outputs are consensus-valid but non-standard, and a
// payout the contract refuses is a release_failed, so they are refused here. Raise this if the contract ever accepts them.
function btc(input: unknown, hrp: Hrp): Payee | null {
  // 90 is the BIP173 limit; checking it first keeps a huge string away from the decoder
  if (typeof input !== "string" || input.length > 90) return null;
  for (const [enc, version] of [[bech32, 0], [bech32m, 1]] as const) {
    let decoded: { prefix: string; words: number[] };
    try {
      decoded = enc.decode(input as `${string}1${string}`); // refuses mixed case and a bad checksum
    } catch {
      continue;
    }
    // the checksum matched this encoding, so the other one cannot match: an answer here is final
    if (decoded.prefix !== hrp || decoded.words[0] !== version) return null;
    let program: Uint8Array;
    try {
      program = enc.fromWords(decoded.words.slice(1)); // refuses non-zero padding
    } catch {
      return null;
    }
    if (version === 0 ? program.length !== 20 && program.length !== 32 : program.length !== 32) return null;
    return { address: enc.encode(hrp, decoded.words), key: `${hrp}:${version}:${hex(program)}` };
  }
  return null;
}

// isAddress is strict: an all-lowercase address passes, a mixed-case one must carry a correct EIP-55 checksum.
function evm(input: unknown): Payee | null {
  if (typeof input !== "string" || !isAddress(input)) return null;
  const address = getAddress(input);
  return { address, key: address.toLowerCase() };
}

export const parsePayee = (chain: Chain, input: unknown, hrp: Hrp): Payee | null => (chain === "btc" ? btc(input, hrp) : evm(input));

// The key of a recipient the model wrote, for comparing it with the payout address. Nothing from this string is ever sent on, so
// EVM case is not checked (a model copying an address may change its case): only its shape. Bitcoin is decoded as for a payout.
export function recipientKey(chain: Chain, input: unknown, hrp: Hrp): string | null {
  if (chain === "btc") return btc(input, hrp)?.key ?? null;
  return typeof input === "string" && /^0x[0-9a-fA-F]{40}$/.test(input) ? input.toLowerCase() : null;
}
