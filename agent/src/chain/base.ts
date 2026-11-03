// Base (EVM) side of a payout: the reads the release payload needs, the gas pre-check, signature injection and broadcast.
// The contract builds an EIP-1559 `transfer(address,uint256)` and has the MPC sign keccak256(0x02 || rlp(fields)); this file
// appends [yParity, r, s] to the same RLP list (evm.rs).
import { hexToBytes } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import { createPublicClient, http, keccak256, parseAbi, parseTransaction, recoverAddress, serializeTransaction, type Hex } from "viem";
import type { Sig } from "./btc";

// evm.rs limits: the contract refuses anything above these, so the payload is clamped to them
export const MAX_FEE_PER_GAS = 50_000_000_000n;
export const GAS_LIMIT = 100_000n; // a USDC transfer to a fresh address costs about 65k; the contract's cap is 120k

export class NoGasFundsError extends Error {
  constructor(public have: bigint, public need: bigint) {
    super(`tier address has ${have} wei, a release needs ${need}`);
    this.name = "NoGasFundsError";
  }
}

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const N = secp256k1.CURVE.n;

/** The signed tx for `unsignedHex` (0x02 || rlp, as `release_signed` carries it). The signing hash is computed here, not trusted,
 *  and the tx is only returned when the signature recovers to `tierAddress`: a bad signature throws before any broadcast. */
export async function assembleSigned(unsignedHex: string, sig: Sig, tierAddress: string): Promise<Hex> {
  const bigR = hexToBytes(sig.bigR);
  if (bigR.length !== 33 || hexToBytes(sig.s).length !== 32) throw new Error("bad signature: big_r must be 33 bytes and s 32");
  const r = ("0x" + sig.bigR.slice(2)) as Hex;
  let sv = BigInt("0x" + sig.s);
  if (sv > N >> 1n) sv = N - sv; // EIP-2: low-s only
  const s = ("0x" + sv.toString(16).padStart(64, "0")) as Hex;
  const unsigned = (unsignedHex.startsWith("0x") ? unsignedHex : "0x" + unsignedHex) as Hex;
  const hash = keccak256(unsigned);
  for (const yParity of [0, 1] as const) {
    let who: string;
    try {
      who = await recoverAddress({ hash, signature: { r, s, yParity } });
    } catch {
      continue;
    }
    if (who.toLowerCase() === tierAddress.toLowerCase()) return serializeTransaction(parseTransaction(unsigned) as any, { r, s, yParity });
  }
  throw new Error("signature does not recover to the tier address");
}

// A viem error can carry the RPC URL (and with it the provider's API key) in its message or its meta. What leaves this file is
// the short message only, with the URL cut out if it is in there anyway. The node's own words stay available for matching.
const scrub = (url: string) => (e: unknown): never => {
  const x = e as { shortMessage?: unknown };
  const m = typeof x?.shortMessage === "string" ? x.shortMessage : "base rpc error";
  throw new Error(m.split(url).join("[rpc]").slice(0, 200));
};
const detail = (e: unknown) => String((e as { details?: unknown })?.details ?? (e as Error)?.message ?? "");

export function makeBase(o: { fetch: typeof fetch; rpcUrl: string; timeoutMs?: number }) {
  const client = createPublicClient({ transport: http(o.rpcUrl, { fetchFn: o.fetch, timeout: o.timeoutMs ?? 10_000, retryCount: 0 }) });
  const w = <T>(p: Promise<T>): Promise<T> => p.catch(scrub(o.rpcUrl));
  return {
    chainId: () => w(client.getChainId()),
    // the token address is the tier's own (get_tier.evm.usdc), never configuration
    usdcBalance: (addr: string, usdc: string) => w(client.readContract({ address: usdc as Hex, abi: ERC20, functionName: "balanceOf", args: [addr as Hex] })),
    // pending: a tx of the tier address that is still in the mempool owns the next nonce too
    nonce: (addr: string) => w(client.getTransactionCount({ address: addr as Hex, blockTag: "pending" })),
    /** Current fees, clamped to what the contract accepts. */
    async fees() {
      const f = await w(client.estimateFeesPerGas());
      const maxFeePerGas = f.maxFeePerGas! < MAX_FEE_PER_GAS ? f.maxFeePerGas! : MAX_FEE_PER_GAS;
      const p = f.maxPriorityFeePerGas!;
      return { maxFeePerGas, maxPriorityFeePerGas: p < maxFeePerGas ? p : maxFeePerGas };
    },
    /** The tier address pays the gas itself (E-gas): refuse before calling the contract when it cannot. */
    async checkGas(addr: string, gasLimit: bigint, maxFeePerGas: bigint) {
      const have = await w(client.getBalance({ address: addr as Hex }));
      const need = gasLimit * maxFeePerGas;
      if (have < need) throw new NoGasFundsError(have, need);
    },
    /** Returns the tx hash. A tx the node already has counts as sent. */
    async broadcast(rawHex: string): Promise<string> {
      const raw = rawHex as Hex;
      try {
        return await client.sendRawTransaction({ serializedTransaction: raw });
      } catch (e) {
        const hash = keccak256(raw);
        const d = detail(e);
        if (/already known|known transaction|already imported/i.test(d)) return hash;
        // "nonce too low" can mean this very tx was mined: it is sent if the chain has it
        if (/nonce too low/i.test(d) && (await client.getTransaction({ hash }).catch(() => null))) return hash;
        return scrub(o.rpcUrl)(e);
      }
    },
  };
}
export type Base = ReturnType<typeof makeBase>;

/** The nonce of a signed (or unsigned) EIP-1559 tx this agent stored. */
export const nonceOfTx = (hex: string): number => Number(parseTransaction((hex.startsWith("0x") ? hex : "0x" + hex) as Hex).nonce ?? -1);
