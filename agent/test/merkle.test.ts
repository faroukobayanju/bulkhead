import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { attemptLeaf, type LeafInput } from "../../shared/leaf";
import { epochDay, hourlyRoots, merkleRoot } from "../../shared/merkle";

const h = (s: string) => createHash("sha256").update(s).digest("hex");
const pair = (a: string, b: string) => createHash("sha256").update(Buffer.concat([Buffer.from(a, "hex"), Buffer.from(b, "hex")])).digest("hex");

describe("merkleRoot", () => {
  test("single leaf root is the leaf", () => expect(merkleRoot([h("a")])).toBe(h("a")));
  test("two leaves", () => expect(merkleRoot([h("a"), h("b")])).toBe(pair(h("a"), h("b"))));
  test("odd leaf promoted", () => expect(merkleRoot([h("a"), h("b"), h("c")])).toBe(pair(pair(h("a"), h("b")), h("c"))));
  test("five leaves: the odd one is promoted at every level", () =>
    expect(merkleRoot(["a", "b", "c", "d", "e"].map(h))).toBe(pair(pair(pair(h("a"), h("b")), pair(h("c"), h("d"))), h("e"))));
  test("empty", () => expect(merkleRoot([])).toBe(h("")));
  test("order matters", () => expect(merkleRoot([h("b"), h("a")])).not.toBe(merkleRoot([h("a"), h("b")])));
  test("a leaf that is not 32 bytes of lowercase hex is refused", () => {
    for (const bad of ["ab", "zz".repeat(32), "AB".repeat(32)]) expect(() => merkleRoot([bad])).toThrow();
  });
});

describe("epochDay", () => {
  test("whole days since 1970-01-01 UTC", () => {
    expect(epochDay("1970-01-01")).toBe(0);
    expect(epochDay("2026-11-10")).toBe(20767);
  });
  test("refuses anything but a real YYYY-MM-DD", () => {
    for (const bad of ["2026-11-1", "2026-13-01", "2026-02-30", "20261110", "2026-11-10T00:00:00Z", ""]) expect(() => epochDay(bad)).toThrow();
  });
});

const row = (id: string, ts: string, message = "m"): LeafInput => ({
  id, ts, tier: 1, account_hash: "a".repeat(64), message, outcome: "refused", prompt_sha256: "b".repeat(64), model_id: "m", attestation_sha256: "c".repeat(64), codehash: "local",
});

describe("hourlyRoots", () => {
  test("groups by UTC hour, orders each hour by id, recomputes every leaf", () => {
    const a = row("01A", "2026-11-02T05:10:00.000Z");
    const b = row("01B", "2026-11-02T05:00:00.000Z"); // earlier ts, later id: id decides
    const c = row("01C", "2026-11-02T23:59:59.999Z");
    expect(hourlyRoots("2026-11-02", [c, b, a])).toEqual([
      [5, merkleRoot([attemptLeaf(a), attemptLeaf(b)])],
      [23, attemptLeaf(c)],
    ]);
  });
  test("no rows, no hours", () => expect(hourlyRoots("2026-11-02", [])).toEqual([]));
  test("a row from another day is refused, naming its id", () => {
    expect(() => hourlyRoots("2026-11-02", [row("01X", "2026-11-03T00:00:00.000Z")])).toThrow("01X");
  });
});
