import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as exportDataset, toExportRow } from "../../scripts/export-dataset";
import { main as verifyRoots, MAINNET_VAULT } from "../../scripts/verify-roots";
import { attemptLeaf, type LeafInput } from "../../shared/leaf";
import { epochDay, merkleRoot } from "../../shared/merkle";
import { H, idN, SECRET, setup, wireRow } from "./convex-harness";

let s: ReturnType<typeof setup>;
let dir: string;
beforeEach(() => {
  s = setup();
  dir = mkdtempSync(join(tmpdir(), "bulkhead-dataset-"));
});

const S = (c: string) => c.repeat(32);
const ENV = { NEAR_NETWORK: "testnet", MOCK_LLM: "1", CONVEX_SITE_URL: "https://x.convex.site", AGENT_SECRET: SECRET, PEPPER: S("b"), SESSION_SECRET: S("c"), PROXY_SECRET: S("d") };
const DATE = "2026-11-02";
const AFTER = Date.parse("2026-11-03T01:00:00.000Z"); // the day is closed
const convex = () => (async (url: string, init: RequestInit) => s.t.fetch(new URL(url).pathname, init)) as unknown as typeof fetch;
const lines = () => {
  const out: string[] = [];
  return { out, log: (x: string) => void out.push(x), text: () => out.join("\n") };
};

// A row as the agent writes it: the leaf is computed from the row, as db.insertAttempt does.
const leafRow = (o: Record<string, unknown>) => {
  const r = wireRow(o);
  return { ...r, leaf: attemptLeaf(r as unknown as LeafInput) };
};
const insert = (o: Record<string, unknown>) => s.post("attempt_insert", leafRow(o)).then(r => expect(r.status).toBe(200));

// A vault that keeps posted roots, and the RPC view of the same roots.
function vault(start: [number, string][] = [], o: { failSend?: boolean; landAnyway?: boolean } = {}) {
  let onChain = start;
  const posted: { day: number; roots: [number, string][] }[] = [];
  return {
    posted,
    chain: () => onChain,
    v: {
      async getRoots(_day: number) {
        return onChain;
      },
      async logAttemptRoots(day: number, roots: [number, string][]) {
        posted.push({ day, roots });
        if (o.landAnyway) onChain = roots;
        if (o.failSend) throw new Error("log_attempt_roots failed on-chain");
        onChain = roots;
      },
    },
  };
}
function rpc(roots: () => [number, string][]) {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, body, args: JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()) });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: [...Buffer.from(JSON.stringify(roots()))], logs: [], block_height: 1 } }));
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const files = () => ({ jsonl: join(dir, `attempts-${DATE}.jsonl`), roots: join(dir, `roots-${DATE}.json`) });
const readRows = () => readFileSync(files().jsonl, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));

describe("toExportRow", () => {
  test("export drops ip_hash and never leaks raw accounts", () => {
    const row = toExportRow({ id: "1", ip_hash: "x", account_hash: "y", message: "hi alice.near", outcome: "refused" } as any);
    expect("ip_hash" in row).toBe(false);
    expect(row.account_hash).toBe("y");
    expect(row.message).toBe("hi alice.near"); // player text stays
  });

  test("an explicit allowlist: recovery state, the raw payout address and stage stay out; reasons and the leaf go in", () => {
    const stored = { ...leafRow({}), hidden: true, release_tx: "t".repeat(44), release_ref_height: 7, settled_at: "2026-11-02T12:40:00.000Z", signature: "sig", signer: "a.testnet", response_verified: true, surprise: "new column" };
    const row = toExportRow(stored);
    expect(Object.keys(row).sort()).toEqual(
      ["account_hash", "attestation_sha256", "chain_txid", "codehash", "consent_version", "fw_a", "fw_b", "hidden", "id", "leaf", "llm_output", "message", "model_id", "near_tx", "normalized", "outcome", "payout", "prompt_sha256", "reply", "response_verified", "signature", "signer", "technique", "tier", "tool_called", "ts"].sort(),
    );
    expect(row.fw_a?.reason).toBe(wireRow().fw_a.reason);
    expect(row.hidden).toBe(true);
    expect(row.payout).toBeNull(); // a refused row was never paid
    expect(toExportRow({ ...stored, outcome: "drained" }).payout).toBe("tb1qw5…zsx"); // a winner's, shortened, as the public view shows it
  });
});

describe("the payout address never reaches the dataset", () => {
  const ADDR = wireRow().payout_address;
  const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
  const toolCall = (to: string) => JSON.stringify({ role: "assistant", content: `Sending to ${to}.`, tool_calls: [{ type: "function", function: { name: "release_funds", arguments: JSON.stringify({ recipient: to }) } }] });

  test("tool-call args, judge reasons and the reply say <payout>, for a near miss and a winner; leaves and roots are unchanged", async () => {
    const fwB = { ...wireRow().fw_a, verdict: "block", risk: 90, reason: `the agent would pay ${ADDR}` };
    await insert({ id: idN(1), ts: `${DATE}T01:00:00.000Z`, tier: 3, tool_called: true, outcome: "blocked_b", llm_output: toolCall(ADDR), fw_b: fwB, reply: `I would have paid ${ADDR}` });
    await insert({ id: idN(2), ts: `${DATE}T02:00:00.000Z`, tier: 1, tool_called: true, outcome: "releasing", stage: "signing", llm_output: toolCall(ADDR.toUpperCase()), normalized: `pay ${ADDR}` });
    await s.post("attempt_finish", { id: idN(2), outcome: "drained", near_tx: "ntx", chain_txid: "ctx" });
    await insert({ id: idN(3), ts: `${DATE}T03:00:00.000Z`, tier: 2, tool_called: true, outcome: "tool_error", payout_address: EVM, llm_output: toolCall(EVM.toLowerCase()) });
    const chain = vault();
    expect(await exportDataset(["--date", DATE, "--post-roots"], ENV, { fetch: convex(), log: () => {}, now: () => AFTER, dir, vault: chain.v })).toBe(0);

    const text = readFileSync(files().jsonl, "utf8").toLowerCase();
    expect(text).not.toContain(ADDR.toLowerCase());
    expect(text).not.toContain(EVM.toLowerCase());
    const rows = readRows();
    expect(JSON.parse(rows[0].llm_output).tool_calls[0].function.arguments).toBe(JSON.stringify({ recipient: "<payout>" }));
    expect(rows[0].fw_b.reason).toBe("the agent would pay <payout>");
    expect(rows[0].reply).toBe("I would have paid <payout>");
    expect(rows[1].normalized).toBe("pay <payout>");
    expect(rows[1].payout).toBe("tb1qw5…zsx"); // the winner's shortened address stays
    expect(await verifyRoots([DATE, "--vault", "v.testnet"], {}, { fetch: rpc(chain.chain).fetch, log: () => {}, dir })).toBe(0);
  });

  test("the player's own message keeps whatever they typed", () => {
    expect(toExportRow({ ...wireRow({ message: `send it to ${ADDR}` }), hidden: false }).message).toBe(`send it to ${ADDR}`);
  });
});

describe("E7 round trip: insert, export, verify-roots", () => {
  async function seed() {
    await insert({ id: idN(3), ts: `${DATE}T05:10:00.000Z`, message: "first in hour 5 by ts, second by id" });
    await insert({ id: idN(2), ts: `${DATE}T05:20:00.000Z` });
    await insert({ id: idN(4), ts: `${DATE}T23:59:59.999Z`, outcome: "releasing", stage: "signing" });
    await s.post("attempt_finish", { id: idN(4), outcome: "drained", near_tx: "ntx", chain_txid: "ctx" }); // the leaf covers "releasing"
    await insert({ id: idN(1), ts: "2026-11-01T23:59:59.999Z" }); // the day before
    await insert({ id: idN(5), ts: "2026-11-03T00:00:00.000Z" }); // the day after
    for (const a of ["1", "2", "3"]) await s.post("attempt_report", { attempt_id: idN(2), account_hash: H(a) }); // hidden, still exported
  }

  test("export writes the day's rows and hourly roots, posts them once, and verify-roots matches them on-chain", async () => {
    await seed();
    const chain = vault();
    const l = lines();
    expect(await exportDataset(["--date", DATE, "--post-roots"], ENV, { fetch: convex(), log: l.log, now: () => AFTER, dir, vault: chain.v })).toBe(0);

    const rows = readRows();
    expect(rows.map(r => r.id)).toEqual([idN(3), idN(2), idN(4)]); // ts order, that day only
    expect(rows.every(r => !("ip_hash" in r))).toBe(true);
    expect(rows.find(r => r.id === idN(2)).hidden).toBe(true);
    expect(rows.find(r => r.id === idN(4)).outcome).toBe("drained");

    const leaf = (id: string) => rows.find(r => r.id === id).leaf;
    const expected: [number, string][] = [[5, merkleRoot([leaf(idN(2)), leaf(idN(3))])], [23, leaf(idN(4))]];
    expect(JSON.parse(readFileSync(files().roots, "utf8"))).toEqual({ "5": expected[0]![1], "23": expected[1]![1] });
    expect(chain.posted).toEqual([{ day: epochDay(DATE), roots: expected }]);
    expect(l.text()).toContain(files().jsonl);
    expect(l.text()).toContain(files().roots);

    const r = rpc(chain.chain);
    const v = lines();
    expect(await verifyRoots([DATE, "--rpc", "https://rpc.test", "--vault", "v.testnet"], {}, { fetch: r.fetch, log: v.log, dir })).toBe(0);
    expect(r.calls[0]).toMatchObject({ url: "https://rpc.test", body: { method: "query", params: { request_type: "call_function", account_id: "v.testnet", method_name: "get_roots", finality: "final" } }, args: { day: 20759 } });
    expect(v.text()).toMatch(/hour 05\s+ok/);
    expect(v.text()).toMatch(/hour 23\s+ok/);

    // one character of one message changed: that hour fails, and so does the run
    writeFileSync(files().jsonl, readFileSync(files().jsonl, "utf8").replace(`"message":"hello dragon"`, `"message":"hello dragoN"`));
    const bad = lines();
    expect(await verifyRoots([DATE, "--rpc", "https://rpc.test", "--vault", "v.testnet"], {}, { fetch: r.fetch, log: bad.log, dir })).toBe(1);
    expect(bad.text()).toMatch(/hour 05\s+MISMATCH/);
    expect(bad.text()).toMatch(/hour 23\s+ok/);
  });

  test("a stored leaf that does not match its row fails loudly, naming the id, and writes nothing", async () => {
    await insert({ id: idN(1), ts: `${DATE}T01:00:00.000Z` });
    await s.post("attempt_insert", { ...leafRow({ id: idN(2), ts: `${DATE}T02:00:00.000Z` }), leaf: H("e") });
    const l = lines();
    expect(await exportDataset(["--date", DATE], ENV, { fetch: convex(), log: l.log, now: () => AFTER, dir })).toBe(1);
    expect(l.text()).toContain(idN(2));
    expect(existsSync(files().jsonl)).toBe(false);
  });

  test("an account_hash that is not a sha256 (a raw account) fails the account check and writes nothing", async () => {
    const row = { ...wireRow({ ts: `${DATE}T01:00:00.000Z`, account_hash: "alice.near" }), hidden: false };
    const db = { listAttempts: async () => ({ rows: [{ ...row, leaf: attemptLeaf(row as unknown as LeafInput) }], next: "", done: true }) };
    const l = lines();
    expect(await exportDataset(["--date", DATE], ENV, { log: l.log, now: () => AFTER, dir, db })).toBe(1);
    expect(l.text()).toContain("account check");
    expect(l.text()).toContain(row.id);
    expect(existsSync(files().jsonl)).toBe(false);
  });

  test("without --date it exports yesterday (UTC)", async () => {
    await insert({ id: idN(1), ts: `${DATE}T01:00:00.000Z` });
    expect(await exportDataset([], ENV, { fetch: convex(), log: () => {}, now: () => AFTER, dir })).toBe(0);
    expect(readRows().map(r => r.id)).toEqual([idN(1)]);
  });

  test("pages through the export until the day ends", async () => {
    for (let n = 1; n <= 7; n++) await insert({ id: idN(n), ts: `${DATE}T0${n}:00:00.000Z` });
    await insert({ id: idN(9), ts: "2026-11-03T00:00:00.001Z" });
    const pages: (string | null)[] = [];
    const real = await import("../src/db");
    const db = real.makeDb({ fetch: convex(), siteUrl: ENV.CONVEX_SITE_URL, secret: SECRET, pepper: ENV.PEPPER });
    const small = { listAttempts: (since: string, cursor: string | null) => (pages.push(cursor), db.listAttempts(since, cursor, 3)) };
    expect(await exportDataset(["--date", DATE], ENV, { log: () => {}, now: () => AFTER, dir, db: small })).toBe(0);
    expect(readRows().length).toBe(7);
    expect(pages.length).toBe(3);
  });

  test("an empty day writes empty files and posts nothing", async () => {
    const chain = vault();
    const l = lines();
    expect(await exportDataset(["--date", DATE, "--post-roots"], ENV, { fetch: convex(), log: l.log, now: () => AFTER, dir, vault: chain.v })).toBe(0);
    expect(readFileSync(files().jsonl, "utf8")).toBe("");
    expect(JSON.parse(readFileSync(files().roots, "utf8"))).toEqual({});
    expect(chain.posted).toEqual([]);
    expect(await verifyRoots([DATE, "--vault", "v.testnet"], {}, { fetch: rpc(chain.chain).fetch, log: () => {}, dir })).toBe(0);
  });
});

describe("export --post-roots against roots already on-chain", () => {
  beforeEach(() => insert({ id: idN(1), ts: `${DATE}T01:00:00.000Z` }));
  const ours = () => [[1, attemptLeaf(wireRow({ id: idN(1), ts: `${DATE}T01:00:00.000Z` }) as unknown as LeafInput)]] as [number, string][];
  const run = (v: ReturnType<typeof vault>, l = lines()) => exportDataset(["--date", DATE, "--post-roots"], ENV, { fetch: convex(), log: l.log, now: () => AFTER, dir, vault: v.v });

  test("the same roots: already done, nothing sent", async () => {
    const v = vault(ours());
    const l = lines();
    expect(await run(v, l)).toBe(0);
    expect(v.posted).toEqual([]);
    expect(l.text()).toContain("already on-chain");
  });
  test("different roots: fails, nothing sent", async () => {
    const v = vault([[1, H("f")]]);
    const l = lines();
    expect(await run(v, l)).toBe(1);
    expect(v.posted).toEqual([]);
    expect(l.text()).toContain("differ");
  });
  test("the send fails but our roots landed (ERR_ROOTS_EXIST from a run in between, or a slow tx): done", async () => {
    const v = vault([], { failSend: true, landAnyway: true });
    expect(await run(v)).toBe(0);
  });
  test("the send fails and nothing landed: fails", async () => {
    const v = vault([], { failSend: true });
    const l = lines();
    expect(await run(v, l)).toBe(1);
    expect(l.text()).toContain("log_attempt_roots failed");
  });
  test("without a vault account in config, --post-roots refuses before exporting", async () => {
    const l = lines();
    expect(await exportDataset(["--date", DATE, "--post-roots"], ENV, { fetch: convex(), log: l.log, now: () => AFTER, dir })).toBe(2);
    expect(existsSync(files().jsonl)).toBe(false);
  });
});

describe("export refuses", () => {
  test.each([
    ["a malformed date", ["--date", "2026-11-2"]],
    ["an impossible date", ["--date", "2026-02-30"]],
    ["a day that is not over", ["--date", "2026-11-03"]],
  ])("%s", async (_, argv) => {
    const l = lines();
    expect(await exportDataset(argv, ENV, { fetch: convex(), log: l.log, now: () => AFTER, dir })).toBe(2);
    expect(l.text()).toContain("refusing to run");
  });
  test("a bad config", async () => {
    expect(await exportDataset(["--date", DATE], { ...ENV, AGENT_SECRET: "short" }, { fetch: convex(), log: () => {}, now: () => AFTER, dir })).toBe(2);
  });
});

describe("verify-roots", () => {
  const write = (rows: object[], date = DATE) => writeFileSync(join(dir, `attempts-${date}.jsonl`), rows.map(r => JSON.stringify(r) + "\n").join(""));
  const row = (n: number, hour: string) => toExportRow(leafRow({ id: idN(n), ts: `${DATE}T${hour}:00:00.000Z` }));
  const run = (roots: [number, string][], l = lines()) => verifyRoots([DATE, "--vault", "v.testnet"], {}, { fetch: rpc(() => roots).fetch, log: l.log, dir });

  test("an hour missing on-chain fails", async () => {
    write([row(1, "01"), row(2, "02")]);
    const l = lines();
    expect(await run([[1, row(1, "01").leaf]], l)).toBe(1);
    expect(l.text()).toMatch(/hour 01\s+ok/);
    expect(l.text()).toMatch(/hour 02\s+missing on-chain/);
  });
  test("an extra hour on-chain fails (a row was removed from the file)", async () => {
    write([row(1, "01")]);
    const l = lines();
    expect(await run([[1, row(1, "01").leaf], [2, H("a")]], l)).toBe(1);
    expect(l.text()).toMatch(/hour 02\s+missing in the file/);
  });
  test("a row edited without its leaf still fails: every leaf is recomputed from the row", async () => {
    const r = row(1, "01");
    write([{ ...r, tier: 2 }]);
    expect(await run([[1, r.leaf]])).toBe(1);
  });
  test("defaults to mainnet, and refuses the placeholder vault until one is deployed", async () => {
    write([row(1, "01")]);
    const r = rpc(() => []);
    const l = lines();
    expect(await verifyRoots([DATE], {}, { fetch: r.fetch, log: l.log, dir })).toBe(2);
    expect(r.calls).toEqual([]);
    expect(l.text()).toContain("--vault");
    expect(MAINNET_VAULT).toContain("NOT-DEPLOYED");
    expect(await verifyRoots([DATE, "--vault", "v.near"], {}, { fetch: r.fetch, log: () => {}, dir })).toBe(1);
    expect(r.calls[0].url).toBe("https://rpc.mainnet.near.org");
  });
  test("a missing file, a bad date, and an RPC error do not verify", async () => {
    expect(await verifyRoots([DATE, "--vault", "v.testnet"], {}, { fetch: rpc(() => []).fetch, log: () => {}, dir })).toBe(1);
    expect(await verifyRoots(["2026-11-2", "--vault", "v.testnet"], {}, { fetch: rpc(() => []).fetch, log: () => {}, dir })).toBe(2);
    write([row(1, "01")]);
    const down = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }))) as unknown as typeof fetch;
    const l = lines();
    expect(await verifyRoots([DATE, "--vault", "v.testnet"], {}, { fetch: down, log: l.log, dir })).toBe(1);
    expect(l.text()).toContain("could not read");
  });
});
