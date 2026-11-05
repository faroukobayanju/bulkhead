// The hourly Merkle roots of the dataset (E7): what export-dataset posts with log_attempt_roots and verify-roots checks.
// Pure and without node: APIs, like leaf.ts.
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import { attemptLeaf, type LeafInput } from "./leaf";

const HEX64 = /^[0-9a-f]{64}$/;

// Pairwise sha256(a‖b) over the raw 32 bytes. An odd node is carried up unchanged. No leaves: sha256("").
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return bytesToHex(sha256(new Uint8Array()));
  for (const l of leaves) if (!HEX64.test(l)) throw new Error("a leaf must be 64 lowercase hex characters");
  let level = leaves.map(hexToBytes);
  while (level.length > 1) {
    const up: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) up.push(i + 1 < level.length ? sha256(concatBytes(level[i]!, level[i + 1]!)) : level[i]!);
    level = up;
  }
  return bytesToHex(level[0]!);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

// The `day` of the contract's log_attempt_roots and get_roots: whole days since 1970-01-01 UTC. 2026-11-10 is day 20767.
// This is the only place that defines it.
export function epochDay(date: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!DATE.test(date) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) throw new Error(`not a YYYY-MM-DD date: "${date}"`);
  return ms / DAY_MS;
}

// One root per UTC hour that has rows, as [hour, root] sorted by hour (the contract's Vec<(u8, String)>). Within an hour the leaves
// are ordered by id (ULID). Every leaf is recomputed from the row, never read from it.
export function hourlyRoots(date: string, rows: LeafInput[]): [number, string][] {
  epochDay(date);
  const hours = new Map<number, LeafInput[]>();
  for (const r of rows) {
    if (typeof r.ts !== "string" || !r.ts.startsWith(`${date}T`)) throw new Error(`row ${r.id} is not from ${date}`);
    const h = Number(r.ts.slice(11, 13));
    hours.set(h, [...(hours.get(h) ?? []), r]);
  }
  return [...hours.entries()]
    .sort(([a], [b]) => a - b)
    .map(([h, rs]) => [h, merkleRoot(rs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(attemptLeaf))]);
}
