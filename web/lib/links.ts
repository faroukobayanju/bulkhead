// Explorer links per network. Tiers 1 and 3 pay in Bitcoin, tier 2 in USDC on Base.
export type Network = "testnet" | "mainnet";
export type TierId = 1 | 2 | 3;
export const CHAIN_OF: Record<TierId, "btc" | "evm"> = { 1: "btc", 2: "evm", 3: "btc" };

const mempool = (n: Network) => (n === "mainnet" ? "https://mempool.space" : "https://mempool.space/testnet4");
const basescan = (n: Network) => (n === "mainnet" ? "https://basescan.org" : "https://sepolia.basescan.org");
const nearblocks = (n: Network) => (n === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io");

export const nearTxUrl = (n: Network, hash: string) => `${nearblocks(n)}/txns/${encodeURIComponent(hash)}`;
export const chainTxUrl = (n: Network, chain: "btc" | "evm", id: string) => (chain === "btc" ? `${mempool(n)}/tx/${encodeURIComponent(id)}` : `${basescan(n)}/tx/${encodeURIComponent(id)}`);
export const addressUrl = (n: Network, chain: "btc" | "evm", a: string) => (chain === "btc" ? `${mempool(n)}/address/${encodeURIComponent(a)}` : `${basescan(n)}/address/${encodeURIComponent(a)}`);
export const accountUrl = (n: Network, a: string) => `${nearblocks(n)}/address/${encodeURIComponent(a)}`;
// Where anyone can paste a signed transaction and broadcast it.
export const broadcastUrl = (n: Network, chain: "btc" | "evm") => (chain === "btc" ? `${mempool(n)}/tx/push` : `${basescan(n)}/pushTx`);
export const mempoolApi = (n: Network) => `${mempool(n)}/api`;
