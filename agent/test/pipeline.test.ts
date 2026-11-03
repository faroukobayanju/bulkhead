import { beforeEach, describe, expect, test } from "bun:test";
import { attemptLeaf, isoMs } from "../../shared/leaf";
import { memoryCounter } from "../src/counter";
import { makeDb, type AttemptRow } from "../src/db";
import { makeBudget } from "../src/firewall/budget";
import { NearAIError } from "../src/nearai";
import { normalize } from "../src/normalize";
import {
  AttestationUnavailableError, BadPayoutAddressError, BroadcastFailedError, BudgetExhaustedError, BudgetUnavailableError, ConsentRequiredError, FirewallDegradedError,
  LlmUnavailableError, makeArenaFirewall, MessageTooLongError, parseRelease, runAttempt, SpendCapError, TierClosedError, TierCoolingError,
} from "../src/pipeline";
import { api, SECRET, setup } from "./convex-harness";
import { createHash } from "node:crypto";

const TB = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const TB_OTHER = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
const BC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // EIP-55
const EVM_OTHER = "0x52908400098527886E0F7030069857D2E4169EE7";

let rows: any[] = [];
let updates: any[] = [];
let releases = 0;
let released: any[] = [];
let warnings: string[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const allow = async () => ({ verdict: "allow", risk: 0, technique: "none", reason: "SECRET-REASON ok", firewall_version: "fw-v1", codehash: "c", latency_ms: 1, degraded: false } as any);
const block = async () => ({ ...(await allow()), verdict: "block", risk: 90, technique: "tool_spoof" } as any);
const open = { status: "open", retryAfterS: 0 };
const deps = (o: Partial<any> = {}) => ({
  chat: async () => ({ raw: {}, toolCalls: [], text: "No." }),
  firewall: allow,
  release: async (tier: number, id: string, recipient: string) => {
    releases++;
    released.push({ tier, id, recipient, rowsThen: rows.map(r => ({ id: r.id, outcome: r.outcome })) });
    await sleep(20);
    return { nearTx: "n", chainTxid: "c" };
  },
  attest: async () => ({ sha256: "att", modelId: "m" }),
  insertAttempt: async (r: any) => void rows.push(r),
  updateAttempt: async (id: string, p: any) => {
    updates.push({ id, ...p });
    Object.assign(rows.find(r => r.id === id) ?? {}, p);
  },
  tierOpen: async () => open,
  wasSigned: async () => false,
  warn: (what: string) => void warnings.push(what),
  promptSha: { 1: "p1", 2: "p2", 3: "p3" },
  codehash: "c",
  btcHrp: "tb",
  locks: new Set<number>(),
  ...o,
});
const inp = (tier: 1 | 2 | 3 = 1, message = "hello", payoutAddress = tier === 2 ? EVM : TB, o: Partial<any> = {}) => ({ tier, account: "a.near", ip: "1.1.1.1", message, payoutAddress, consentVersion: "consent-v1", ...o });
const call = (args: unknown, name = "release_funds") => ({ name, args });
const callsOf = (...c: { name: string; args: unknown }[]) => async () => ({ raw: { tool_calls: c.length }, text: "I will.", toolCalls: c });
const win = (recipient: unknown = TB) => callsOf(call({ recipient }));
const run = (o: Partial<any> = {}, i = inp()) => runAttempt(deps(o) as any, i);

beforeEach(() => {
  rows = [];
  updates = [];
  releases = 0;
  released = [];
  warnings = [];
});

describe("the brief's cases", () => {
  test("recipient different from payout address → tool_error, no release", async () => {
    const r = await run({ chat: win(TB_OTHER) });
    expect(r.outcome).toBe("tool_error");
    expect(r.reply).toBe("The agent tried to pay someone else.");
    expect(releases).toBe(0);
  });

  test("degraded firewall on tier 3 → FirewallDegradedError, no row", async () => {
    const degraded = async () => ({ ...(await allow()), verdict: "block", degraded: true } as any);
    await expect(run({ firewall: degraded }, inp(3))).rejects.toBeInstanceOf(FirewallDegradedError);
    expect(rows.length).toBe(0);
  });

  test("refusal logged as refused", async () => {
    const r = await run();
    expect(r.outcome).toBe("refused");
    expect(r.reply).toBe("No.");
    expect(rows[0].outcome).toBe("refused");
    expect(rows[0].prompt_sha256).toBe("p1");
    expect(rows[0].attestation_sha256).toBe("att");
    expect(rows[0].model_id).toBe("m");
    expect(rows[0].codehash).toBe("c");
    expect(rows.length).toBe(1);
  });

  test("tool call on tier 1 drains", async () => {
    expect((await run({ chat: win() })).outcome).toBe("drained");
  });

  test("two tool calls → tool_error", async () => {
    const two = callsOf(call({ recipient: TB }), call({ recipient: TB }));
    expect((await run({ chat: two })).outcome).toBe("tool_error");
    expect((await run({ chat: callsOf(call({ recipient: "tb1qa" }), call({ recipient: "tb1qb" })) })).outcome).toBe("tool_error");
    expect(releases).toBe(0);
  });

  test("EVM address on BTC tier → tool_error", async () => {
    expect((await run({ chat: win(EVM_OTHER) }, inp(1))).outcome).toBe("tool_error");
    expect((await run({ chat: win(EVM_OTHER) }, inp(3))).outcome).toBe("tool_error");
    expect(releases).toBe(0);
  });

  test("unknown tool name → tool_error", async () => {
    expect((await run({ chat: callsOf(call({}, "transfer")) })).outcome).toBe("tool_error");
    expect(releases).toBe(0);
  });

  test("tier 3 checkpoint A blocks before LLM", async () => {
    let called = false;
    const r = await run({ firewall: block, chat: async () => ((called = true), { raw: {}, text: "", toolCalls: [] }) }, inp(3));
    expect(r.outcome).toBe("blocked_a");
    expect(called).toBe(false);
  });

  test("tier 3 checkpoint B blocks the release", async () => {
    let n = 0;
    const r = await run({ firewall: async () => (n++ === 0 ? allow() : block()), chat: win() }, inp(3));
    expect(r.outcome).toBe("blocked_b");
    expect(releases).toBe(0);
  });

  test("tiers 1 and 2 never call the firewall", async () => {
    let fw = 0;
    const firewall = async () => (fw++, allow());
    await run({ firewall }, inp(2));
    await run({ firewall, chat: win() }, inp(1));
    await run({ firewall, chat: win(EVM) }, inp(2));
    expect(fw).toBe(0);
  });

  test("closed tier throws TierClosedError", async () => {
    await expect(run({ tierOpen: async () => ({ status: "drained", retryAfterS: 0 }) })).rejects.toBeInstanceOf(TierClosedError);
  });

  test("attestation down throws and logs nothing", async () => {
    await expect(run({ attest: async () => { throw new Error("x"); } })).rejects.toBeInstanceOf(AttestationUnavailableError);
    expect(rows.length).toBe(0);
  });

  test("concurrent winners: exactly one release, loser logged", async () => {
    const d = deps({ chat: win() }) as any;
    const rs = await Promise.allSettled([runAttempt(d, inp()), runAttempt(d, inp())]);
    expect(releases).toBe(1);
    expect(rs.filter(r => r.status === "rejected" && r.reason instanceof TierClosedError).length).toBe(1);
    expect(rows.filter(r => r.outcome === "won_race_lost").length).toBe(1);
  });

  test("broadcast failure → signed_pending_broadcast, tier stays locked", async () => {
    const d = deps({ chat: win(), release: async () => ((releases++), (() => { throw new BroadcastFailedError("ntx"); })()) }) as any;
    const r = await runAttempt(d, inp());
    expect(r.outcome).toBe("signed_pending_broadcast");
    await expect(runAttempt(d, inp())).rejects.toBeInstanceOf(TierClosedError);
  });

  test("release failure logged as release_failed", async () => {
    const r = await run({ chat: win(), release: async () => { throw new Error("rpc"); } });
    expect(r.outcome).toBe("release_failed");
  });

  test("message over 2000 chars rejected", async () => {
    await expect(run({}, inp(1, "x".repeat(2001)))).rejects.toThrow("message_too_long");
    await expect(run({}, inp(1, "x".repeat(2001)))).rejects.toBeInstanceOf(MessageTooLongError);
    expect((await run({}, inp(1, "x".repeat(2000)))).outcome).toBe("refused");
  });
});

describe("what the model may ask for (a bad call is tool_error, never a payout)", () => {
  const bad: [string, () => Promise<any>, 1 | 3 | 2][] = [
    ["an extra argument", win2({ recipient: TB, amount: 5 }), 1],
    ["an extra argument that is empty", win2({ recipient: TB, memo: "" }), 1],
    ["a __proto__ key beside recipient", async () => ({ raw: {}, text: "", toolCalls: [call(JSON.parse(`{"recipient":"${TB}","__proto__":{"x":1}}`))] }), 1],
    ["a non-string recipient (number)", win2({ recipient: 5 }), 1],
    ["a non-string recipient (array of the address)", win2({ recipient: [TB] }), 1],
    ["a non-string recipient (object with toString)", win2({ recipient: { toString: () => TB } }), 1],
    ["a null recipient", win2({ recipient: null }), 1],
    ["no recipient", win2({}), 1],
    ["the recipient under another name", win2({ address: TB }), 1],
    ["args that are null (unparseable arguments)", win2(null), 1],
    ["args that are an array", win2([TB]), 1],
    ["args that are a string", win2(TB), 1],
    ["a recipient with whitespace around it", win2({ recipient: ` ${TB} ` }), 1],
    ["a recipient for the wrong network", win2({ recipient: BC }), 1],
    ["a Bitcoin address on the EVM tier", win2({ recipient: TB }), 2],
    ["a nameless tool call", async () => ({ raw: {}, text: "", toolCalls: [call({ recipient: TB }, "")] }), 1],
    ["a tool name in another case", async () => ({ raw: {}, text: "", toolCalls: [call({ recipient: TB }, "Release_Funds")] }), 1],
    ["a tool name with a space", async () => ({ raw: {}, text: "", toolCalls: [call({ recipient: TB }, "release_funds ")] }), 1],
    ["three calls", callsOf(call({ recipient: TB }), call({ recipient: TB }), call({ recipient: TB })), 3],
    ["a good call and an unknown one", callsOf(call({ recipient: TB }), call({}, "other")), 1],
  ];
  function win2(args: unknown) {
    return async () => ({ raw: {}, text: "I will.", toolCalls: [call(args)] });
  }
  test.each(bad)("%s", async (_, chat, tier) => {
    const r = await run({ chat }, inp(tier));
    expect(r.outcome).toBe("tool_error");
    expect(releases).toBe(0);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe("tool_error");
    expect(rows[0].tool_called).toBe(true);
    expect(updates).toEqual([]);
  });

  test("the model's own text is the reply of a fumbled call, with a fallback when there is none", async () => {
    expect((await run({ chat: async () => ({ raw: {}, text: "Hmm.", toolCalls: [call(null)] }) })).reply).toBe("Hmm.");
    expect((await run({ chat: async () => ({ raw: {}, text: "", toolCalls: [call(null)] }) })).reply).toBe("The agent fumbled the tool call.");
  });

  test("an address that is the player's own but written differently is the same payee: upper-case Bitcoin, lower-case or wrong-case EVM", async () => {
    expect((await run({ chat: win(TB.toUpperCase()) })).outcome).toBe("drained");
    expect(released[0].recipient).toBe(TB); // the normalized address, not the model's string
    expect((await run({ chat: win(EVM.toLowerCase()) }, inp(2))).outcome).toBe("drained");
    expect((await run({ chat: win("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd") }, inp(2))).outcome).toBe("drained"); // wrong checksum: still the same bytes
    expect(released.map(r => r.recipient)).toEqual([TB, EVM, EVM]);
  });

  test("a different EVM address that differs by one hex digit is another payee", async () => {
    const flipped = EVM.slice(0, -1) + (EVM.endsWith("d") ? "e" : "d");
    expect((await run({ chat: win(flipped) }, inp(2))).outcome).toBe("tool_error");
    expect(releases).toBe(0);
  });

  test("whatever the model wrote, the recipient given to release is the normalized payout address", async () => {
    await run({ chat: win(TB.toUpperCase()) }, inp(1, "hi", TB.toUpperCase()));
    await run({ chat: win(EVM.toLowerCase()) }, inp(2, "hi", EVM.toLowerCase()));
    expect(released.map(r => r.recipient)).toEqual([TB, EVM]);
  });

  test("a hidden key beside recipient (non-enumerable, or a symbol) is still an extra argument", () => {
    const hidden = { recipient: TB };
    Object.defineProperty(hidden, "memo", { value: "x", enumerable: false });
    const sym = { recipient: TB, [Symbol("memo")]: "x" };
    expect(parseRelease([call(hidden)], "btc", "tb")).toEqual({ kind: "malformed" });
    expect(parseRelease([call(sym)], "btc", "tb")).toEqual({ kind: "malformed" });
  });

  test("the call is accepted when it is exactly one release_funds with exactly one recipient", () => {
    expect(parseRelease([call({ recipient: TB })], "btc", "tb")).toEqual({ kind: "release", key: expect.stringMatching(/^tb:0:/) });
    expect(parseRelease([], "btc", "tb")).toEqual({ kind: "none" });
    expect(parseRelease([call({ recipient: TB, extra: 1 })], "btc", "tb")).toEqual({ kind: "malformed" });
  });
});

const untouched = () => {
  const seen: string[] = [];
  const spy = (name: string, f: (...a: any[]) => any) => async (...a: any[]) => (seen.push(name), f(...a));
  return {
    seen,
    d: {
      attest: spy("attest", async () => ({ sha256: "att", modelId: "m" })),
      tierOpen: spy("tierOpen", async () => open),
      chat: spy("chat", async () => ({ raw: {}, toolCalls: [], text: "" })),
      firewall: spy("firewall", allow),
      insertAttempt: spy("insert", async () => {}),
      release: spy("release", async () => ({ nearTx: "n", chainTxid: "c" })),
    },
  };
};


describe("the payout address (E9)", () => {
  test.each([
    ["a mainnet address on a testnet agent", 1, BC],
    ["an EVM address on a Bitcoin tier", 1, EVM],
    ["an EVM address on tier 3", 3, EVM],
    ["a Bitcoin address on the EVM tier", 2, TB],
    ["an empty address", 1, ""],
    ["a broken checksum", 1, TB.slice(0, -1) + "q"],
    ["a mixed-case EVM address with a wrong checksum", 2, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd"],
    ["an address with a trailing space", 1, `${TB} `],
    ["something that is not a string", 1, 5 as unknown as string],
  ])("%s is a BadPayoutAddressError, and nothing is called or charged", async (_, tier, addr) => {
    const u = untouched();
    await expect(runAttempt(deps(u.d) as any, inp(tier as 1 | 2 | 3, "hi", addr))).rejects.toBeInstanceOf(BadPayoutAddressError);
    expect(u.seen).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("the network comes from the deps: tb for testnet, bc for mainnet", async () => {
    expect((await run({ btcHrp: "bc", chat: win(BC) }, inp(1, "hi", BC))).outcome).toBe("drained");
    await expect(run({ btcHrp: "bc" }, inp(1, "hi", TB))).rejects.toBeInstanceOf(BadPayoutAddressError);
    await expect(run({ btcHrp: "tb" }, inp(1, "hi", BC))).rejects.toBeInstanceOf(BadPayoutAddressError);
  });

  test("an all-lowercase EVM payout is normalized to EIP-55 and is not a release_failed", async () => {
    const r = await run({ chat: win(EVM.toLowerCase()) }, inp(2, "hi", EVM.toLowerCase()));
    expect(r.outcome).toBe("drained");
    expect(released[0].recipient).toBe(EVM);
    expect(rows[0].payout_address).toBe(EVM);
  });

  test("an upper-case Bitcoin payout is stored and paid in lower case", async () => {
    await run({ chat: win(TB) }, inp(1, "hi", TB.toUpperCase()));
    expect(rows[0].payout_address).toBe(TB);
    expect(released[0].recipient).toBe(TB);
  });

  test("consent_version is required and has to be plain", async () => {
    for (const consentVersion of [undefined, "", "   ", 7, null, "x".repeat(65), "v1\nx", "v 1", "v1;drop"]) {
      const u = untouched();
      await expect(runAttempt(deps(u.d) as any, inp(1, "hi", TB, { consentVersion }))).rejects.toBeInstanceOf(ConsentRequiredError);
      expect(u.seen).toEqual([]);
    }
    expect((await run({}, inp(1, "hi", TB, { consentVersion: "2026-11-01.v1" }))).outcome).toBe("refused");
  });

  test("a tier that is not 1, 2 or 3 is refused before anything runs", async () => {
    for (const tier of [0, 4, 1.5, "1", undefined, NaN]) await expect(run({}, { ...inp(1), tier } as never)).rejects.toThrow("tier");
    expect(rows).toEqual([]);
  });

  test("a message that is not a string is refused", async () => {
    await expect(run({}, inp(1, 5 as never))).rejects.toThrow(TypeError);
  });

  test("an account or ip that is not a non-empty string is refused before anything runs, so nothing hashes to a shared value", async () => {
    const u = untouched();
    for (const o of [{ account: "" }, { account: undefined }, { account: 5 }, { ip: "" }, { ip: undefined }, { ip: null }]) {
      await expect(runAttempt(deps(u.d) as any, inp(1, "hi", TB, o as never))).rejects.toThrow(TypeError);
    }
    expect(u.seen).toEqual([]);
  });
});

describe("rows (E8)", () => {
  test("payout_address and consent_version are on every inserted row, whatever the outcome", async () => {
    let n = 0;
    await run({ chat: win(TB_OTHER) }); // tool_error
    await run({}); // refused
    await run({ firewall: block }, inp(3)); // blocked_a
    await run({ firewall: async () => (n++ === 0 ? allow() : block()), chat: win() }, inp(3)); // blocked_b
    await run({ chat: win() }); // releasing (then drained)
    const d = deps({ chat: win() }) as any;
    await Promise.allSettled([runAttempt(d, inp()), runAttempt(d, inp())]); // won_race_lost
    expect(new Set(rows.map(r => r.outcome))).toEqual(new Set(["tool_error", "refused", "blocked_a", "blocked_b", "drained", "won_race_lost"]));
    for (const r of rows) {
      expect(r.payout_address, r.outcome).toBeTruthy();
      expect(r.consent_version, r.outcome).toBe("consent-v1");
    }
  });

  test("a row carries what the schema needs, including the raw account and ip for db.ts to hash", async () => {
    const raw = { role: "assistant", content: "x", tool_calls: [{ id: "1" }] };
    await run({ chat: async () => ({ raw, toolCalls: [call(null)], text: "Hmm" }), clock: () => Date.UTC(2026, 10, 2, 12, 34, 56, 789), newId: () => "01JC2ZK6V3Q8N5R7T9W1X3Y5Z7" }, inp(1, "Hello\u200B  World"));
    expect(rows[0]).toMatchObject({
      id: "01JC2ZK6V3Q8N5R7T9W1X3Y5Z7",
      ts: "2026-11-02T12:34:56.789Z",
      tier: 1,
      account: "a.near",
      ip: "1.1.1.1",
      message: "Hello\u200B  World",
      normalized: normalize("Hello\u200B  World").text,
      fw_a: null,
      fw_b: null,
      llm_output: raw,
      tool_called: true,
      outcome: "tool_error",
      technique: null,
      near_tx: null,
      chain_txid: null,
      reply: "Hmm",
      stage: "done",
    });
  });

  test("a row with no model output (blocked_a) has no llm_output and tool_called false", async () => {
    await run({ firewall: block }, inp(3));
    expect(rows[0].llm_output).toBeUndefined();
    expect(rows[0].tool_called).toBe(false);
    expect(rows[0].technique).toBe("tool_spoof");
  });

  test("a blocked_b row records the blocking checkpoint's technique", async () => {
    let n = 0;
    await run({ firewall: async () => (n++ === 0 ? { ...(await allow()), technique: "none" } : block()), chat: win() }, inp(3));
    expect(rows[0]).toMatchObject({ outcome: "blocked_b", technique: "tool_spoof", tool_called: true });
    expect(rows[0].fw_a.verdict).toBe("allow");
    expect(rows[0].fw_b.verdict).toBe("block");
  });

  test("a reply over 4000 characters is cut, in the row and in the result", async () => {
    const r = await run({ chat: async () => ({ raw: {}, toolCalls: [], text: "x".repeat(9000) }) });
    expect(r.reply.length).toBe(4000);
    expect(rows[0].reply.length).toBe(4000);
  });

  test("an injected id must be a ULID", async () => {
    await expect(run({ newId: () => "nope" })).rejects.toThrow("attempt id");
    expect(rows).toEqual([]);
  });
});

describe("tier 3 and the firewall", () => {
  test("checkpoint A sees the player's message as sent, B sees the proposed release with the payout address", async () => {
    const seen: any[] = [];
    const firewall = async (req: any) => (seen.push(req), allow());
    await run({ firewall, chat: win(TB.toUpperCase()) }, inp(3, "Hello\u200B there  "));
    expect(seen).toEqual([
      { messages: [{ role: "user", content: "Hello\u200B there  " }] },
      { messages: [{ role: "user", content: "Hello\u200B there  " }], proposed_action: { tool: "release_funds", args: { recipient: TB } } },
    ]);
  });

  test("checkpoint B is not called when the model made no call, or a bad one", async () => {
    let n = 0;
    const firewall = async () => (n++, allow());
    await run({ firewall }, inp(3));
    await run({ firewall, chat: win(TB_OTHER) }, inp(3));
    await run({ firewall, chat: callsOf(call({ recipient: TB, x: 1 })) }, inp(3));
    expect(n).toBe(3); // only A, each time
  });

  test.each(["escalate", "block", "ALLOW", "Allow", "deny", "", "allowed", undefined, null, 1, true])("checkpoint A: a verdict of %p blocks", async verdict => {
    const r = await run({ firewall: async () => ({ ...(await allow()), verdict }), chat: win() }, inp(3));
    expect(r.outcome).toBe("blocked_a");
    expect(releases).toBe(0);
  });

  test.each(["escalate", "block", "ALLOW", "deny", "", undefined, null, 1])("checkpoint B: a verdict of %p blocks the payout", async verdict => {
    let n = 0;
    const r = await run({ firewall: async () => (n++ === 0 ? allow() : { ...(await allow()), verdict }), chat: win() }, inp(3));
    expect(r.outcome).toBe("blocked_b");
    expect(releases).toBe(0);
  });

  test("degraded is an error even when the verdict says allow, at either checkpoint, and a missing or odd flag counts as degraded", async () => {
    for (const degraded of [true, undefined, null, "false", 0]) {
      rows = [];
      await expect(run({ firewall: async () => ({ ...(await allow()), degraded }) }, inp(3))).rejects.toBeInstanceOf(FirewallDegradedError);
      let n = 0;
      await expect(run({ firewall: async () => (n++ === 0 ? allow() : { ...(await allow()), degraded }), chat: win() }, inp(3))).rejects.toBeInstanceOf(FirewallDegradedError);
      expect(rows).toEqual([]);
      expect(releases).toBe(0);
    }
  });

  test("a firewall that returns nothing at all stops the attempt", async () => {
    await expect(run({ firewall: async () => undefined }, inp(3))).rejects.toBeInstanceOf(FirewallDegradedError);
    expect(rows).toEqual([]);
  });

  test("a degraded checkpoint B leaves no row and takes no lock", async () => {
    let n = 0;
    const locks = new Set<number>();
    await expect(run({ locks, firewall: async () => (n++ === 0 ? allow() : { ...(await allow()), degraded: true }), chat: win() }, inp(3))).rejects.toBeInstanceOf(FirewallDegradedError);
    expect(rows).toEqual([]);
    expect(locks.size).toBe(0);
  });

  test("the result's firewall objects have no reason, and the stored row keeps it", async () => {
    let n = 0;
    const r = await run({ firewall: async () => (n++ === 0 ? allow() : block()), chat: win() }, inp(3));
    expect(r.firewall?.a).toEqual({ verdict: "allow", risk: 0, technique: "none", firewall_version: "fw-v1", codehash: "c", latency_ms: 1, degraded: false });
    expect(r.firewall?.b?.verdict).toBe("block");
    expect(JSON.stringify(r)).not.toContain("SECRET-REASON");
    expect(rows[0].fw_a.reason).toBe("SECRET-REASON ok");
  });

  test("a blocked_a result carries the firewall object too", async () => {
    const r = await run({ firewall: block }, inp(3));
    expect(r.outcome).toBe("blocked_a");
    expect(r.reply).toBe("The guard refuses to read this.");
    expect(r.firewall?.a?.verdict).toBe("block");
  });
});

describe("the arena firewall (ruling 7)", () => {
  const T0 = Date.UTC(2026, 10, 2, 12);
  const judge = (risk: number, seen: any[] = []) => async (input: any) => (seen.push(input), { risk, technique: "none" as const, reason: "judged" });
  const rig = (limits = { arena: 100 }) => {
    const counter = memoryCounter();
    const budget = makeBudget({ counter, clock: () => T0, limits });
    return { counter, budget };
  };

  test("charges the arena pool once per checkpoint, before the judge runs, and nothing else", async () => {
    const { counter, budget } = rig();
    const seen: any[] = [];
    const firewall = makeArenaFirewall({ budget, judge: judge(5, seen) });
    const r = await run({ firewall, chat: win() }, inp(3));
    expect(r.outcome).toBe("drained");
    expect(seen.length).toBe(2);
    expect(await counter.get("fw:arena:2026-11-02")).toBe(2);
    expect(await counter.get("fw:api:2026-11-02")).toBe(0);
    expect(await counter.get("fw:playground:2026-11-02")).toBe(0);
  });

  test("when the arena pool is used up the judge is never called, and there is no row", async () => {
    const { budget } = rig({ arena: 0 });
    const seen: any[] = [];
    await expect(run({ firewall: makeArenaFirewall({ budget, judge: judge(5, seen) }) }, inp(3))).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(seen).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("the pool running out between checkpoints A and B is an error with no row and no payout", async () => {
    const { budget } = rig({ arena: 1 });
    await expect(run({ firewall: makeArenaFirewall({ budget, judge: judge(5) }), chat: win() }, inp(3))).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(rows).toEqual([]);
    expect(releases).toBe(0);
  });

  test("exhausting the API pool does not touch the arena", async () => {
    const { budget } = rig();
    for (let i = 0; i < 2000; i++) if (!(await budget.chargeApi("k" + (i % 7)))) break;
    expect(await run({ firewall: makeArenaFirewall({ budget, judge: judge(5) }) }, inp(3))).toMatchObject({ outcome: "refused" });
  });

  test("a counter that cannot be reached is BudgetUnavailableError, and the judge is not called", async () => {
    const counter = { get: async () => 0, add: async () => { throw new Error("convex down"); } };
    const budget = makeBudget({ counter, clock: () => T0 });
    const seen: any[] = [];
    await expect(run({ firewall: makeArenaFirewall({ budget, judge: judge(5, seen) }) }, inp(3))).rejects.toBeInstanceOf(BudgetUnavailableError);
    expect(seen).toEqual([]);
  });

  test("a judge risk of 70 blocks and 40 to 69 blocks too: only a risk under 40 is allow", async () => {
    for (const [risk, outcome] of [[39, "refused"], [40, "blocked_a"], [69, "blocked_a"], [70, "blocked_a"], [100, "blocked_a"]] as const) {
      rows = [];
      const { budget } = rig();
      expect((await run({ firewall: makeArenaFirewall({ budget, judge: judge(risk) }) }, inp(3))).outcome, `risk ${risk}`).toBe(outcome);
    }
  });

  test("a judge that fails is a degraded block, which is FirewallDegradedError, not blocked_a", async () => {
    const { budget } = rig();
    const bad = async () => { throw new NearAIError("spend_cap", "x"); };
    await expect(run({ firewall: makeArenaFirewall({ budget, judge: bad as never }) }, inp(3))).rejects.toBeInstanceOf(FirewallDegradedError);
    expect(rows).toEqual([]);
  });

  test("the injected timeout reaches checkFirewall", async () => {
    const { budget } = rig();
    const slow = (_: unknown, signal: AbortSignal) => new Promise<never>((_r, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(run({ firewall: makeArenaFirewall({ budget, judge: slow as never, timeoutMs: 30 }) }, inp(3))).rejects.toBeInstanceOf(FirewallDegradedError);
  });
});

describe("model failures", () => {
  test.each([["timeout"], ["http"], ["network"], ["bad_response"], ["aborted"], ["no_price"], ["bad_request"]] as const)("NearAIError %s is LlmUnavailableError and logs nothing", async code => {
    await expect(run({ chat: async () => { throw new NearAIError(code, "x"); } })).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(rows).toEqual([]);
  });

  test("the daily spend cap is SpendCapError and logs nothing", async () => {
    await expect(run({ chat: async () => { throw new NearAIError("spend_cap", "x"); } })).rejects.toBeInstanceOf(SpendCapError);
    expect(rows).toEqual([]);
  });

  test("any other error from chat is passed on as it is", async () => {
    const e = new RangeError("bug");
    await expect(run({ chat: async () => { throw e; } })).rejects.toBe(e);
    expect(rows).toEqual([]);
  });

  test("a model failure on tier 3 after checkpoint A leaves no row", async () => {
    await expect(run({ chat: async () => { throw new NearAIError("timeout", "x"); } }, inp(3))).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(rows).toEqual([]);
  });
});

describe("attestation", () => {
  test.each([[{}], [{ sha256: "" , modelId: "m" }], [{ sha256: "a" }], [{ sha256: 5, modelId: "m" }], [null], [undefined]])("a malformed attestation %p is AttestationUnavailableError", async att => {
    await expect(run({ attest: async () => att })).rejects.toBeInstanceOf(AttestationUnavailableError);
    expect(rows).toEqual([]);
  });

  test("attestation is checked before the model or firewall is called", async () => {
    let called = 0;
    await expect(run({ attest: async () => { throw new Error("x"); }, chat: async () => (called++, { raw: {}, toolCalls: [], text: "" }), firewall: async () => (called++, allow()) }, inp(3))).rejects.toBeInstanceOf(AttestationUnavailableError);
    expect(called).toBe(0);
  });
});

describe("tier status and cooldown (E14)", () => {
  test("during cooldown: TierCoolingError with retryAfterS, rounded up, before attestation or any charge", async () => {
    let attested = 0;
    const e = await run({ tierOpen: async () => ({ status: "open", retryAfterS: 90.2 }), attest: async () => (attested++, { sha256: "a", modelId: "m" }) }).catch(x => x);
    expect(e).toBeInstanceOf(TierCoolingError);
    expect(e.retryAfterS).toBe(91);
    expect(attested).toBe(0);
    expect(rows).toEqual([]);
  });

  test.each([["releasing"], ["drained"]])("status %s is TierClosedError", async status => {
    await expect(run({ tierOpen: async () => ({ status, retryAfterS: 0 }) })).rejects.toBeInstanceOf(TierClosedError);
    await expect(run({ tierOpen: async () => ({ status, retryAfterS: 30 }) })).rejects.toBeInstanceOf(TierClosedError);
  });

  test.each([[true], [false], [undefined], [null], [{}], [{ status: "open" }], [{ status: "OPEN", retryAfterS: 0 }], [{ status: "open", retryAfterS: -1 }], [{ status: "open", retryAfterS: NaN }], [{ status: "open", retryAfterS: Infinity }], [{ status: "open", retryAfterS: "0" }], [{ retryAfterS: 0 }]])("a tier state of %p is not open (fails closed)", async st => {
    await expect(run({ tierOpen: async () => st })).rejects.toBeInstanceOf(TierClosedError);
    expect(rows).toEqual([]);
  });

  test("a tierOpen that throws stops the attempt before anything else runs", async () => {
    let called = 0;
    const boom = new Error("rpc");
    await expect(run({ tierOpen: async () => { throw boom; }, attest: async () => (called++, { sha256: "a", modelId: "m" }) })).rejects.toBe(boom);
    expect(called).toBe(0);
  });

  test("a locked tier is closed without asking the contract", async () => {
    let asked = 0;
    await expect(run({ locks: new Set([1]), tierOpen: async () => (asked++, open) })).rejects.toBeInstanceOf(TierClosedError);
    expect(asked).toBe(0);
  });

  test("a tier that closes while the model is thinking: the attempt is logged as won_race_lost and no payout is made", async () => {
    let n = 0;
    const tierOpen = async () => (n++ === 0 ? open : { status: "drained", retryAfterS: 0 });
    const e = await run({ tierOpen, chat: win() }).catch(x => x);
    expect(e).toBeInstanceOf(TierClosedError);
    expect(e.payload).toEqual({ outcome: "won_race_lost", reply: "I will." });
    expect(releases).toBe(0);
    expect(rows.map(r => r.outcome)).toEqual(["won_race_lost"]);
    expect(rows[0].llm_output).toBeDefined();
  });

  test("a tier that begins a cooldown while the model is thinking (another winner's round) is the same", async () => {
    let n = 0;
    const tierOpen = async () => (n++ === 0 ? open : { status: "open", retryAfterS: 600 });
    await expect(run({ tierOpen, chat: win() })).rejects.toBeInstanceOf(TierClosedError);
    expect(releases).toBe(0);
    expect(rows.map(r => r.outcome)).toEqual(["won_race_lost"]);
  });

  test("a tierOpen that fails on the last look stops the payout", async () => {
    let n = 0;
    const tierOpen = async () => { if (n++ > 0) throw new Error("rpc"); return open; };
    await expect(run({ tierOpen, chat: win() })).rejects.toThrow("rpc");
    expect(releases).toBe(0);
    expect(rows).toEqual([]);
  });
});

describe("the lock (ruling 13)", () => {
  test("no await between the last lock check and locks.add", async () => {
    let yielded = false;
    let adds = 0;
    class Spy extends Set<number> {
      override has(x: number) {
        yielded = false;
        queueMicrotask(() => (yielded = true)); // runs before any `await` that follows this call continues
        return super.has(x);
      }
      override add(x: number) {
        adds++;
        expect(yielded).toBe(false);
        return super.add(x);
      }
    }
    const r = await run({ locks: new Spy(), chat: win() });
    expect(r.outcome).toBe("drained");
    expect(adds).toBe(1);
  });

  test("two winners at once: one release, the other logged won_race_lost with its model output and TierClosedError", async () => {
    const d = deps({ chat: win(), tierOpen: async () => (await sleep(1), open) }) as any;
    const rs = await Promise.allSettled([runAttempt(d, inp()), runAttempt(d, inp(1, "second"))]);
    expect(releases).toBe(1);
    const lost = rs.filter(r => r.status === "rejected") as PromiseRejectedResult[];
    expect(lost.length).toBe(1);
    expect(lost[0]!.reason).toBeInstanceOf(TierClosedError);
    expect(lost[0]!.reason.payload.outcome).toBe("won_race_lost");
    const row = rows.find(r => r.outcome === "won_race_lost");
    expect(row.tool_called).toBe(true);
    expect(row.llm_output).toEqual({ tool_calls: 1 });
  });

  test("five winners at once: exactly one release", async () => {
    const d = deps({ chat: win() }) as any;
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => runAttempt(d, inp())));
    expect(releases).toBe(1);
    expect(rs.filter(r => r.status === "fulfilled").length).toBe(1);
    expect(rows.filter(r => r.outcome === "won_race_lost").length).toBe(4);
  });

  test("a winner racing a closed tier: the tier closes just as the second attempt looks, and it does not release", async () => {
    const locks = new Set<number>();
    let slow = 0;
    // the first attempt reaches the lock quickly; the second is held up in its last tierOpen look and finds the tier drained
    const d = deps({ locks, chat: win(), tierOpen: async () => { if (slow++ === 3) { await sleep(5); return { status: "drained", retryAfterS: 0 }; } return open; } }) as any;
    const rs = await Promise.allSettled([runAttempt(d, inp()), runAttempt(d, inp())]);
    expect(releases).toBe(1);
    expect(rs.filter(r => r.status === "rejected" && r.reason instanceof TierClosedError).length).toBe(1);
  });

  test("the lock records which attempt holds it: kept with a signed payout, gone after a won round or a failed release", async () => {
    const lockedBy = new Map<number, string>();
    const locks = new Set<number>();
    const signed = await run({ locks, lockedBy, chat: win(), release: async () => { throw new BroadcastFailedError("ntx"); } });
    expect(locks.has(1)).toBe(true);
    expect(lockedBy.get(1)).toBe(signed.id);
    locks.clear();
    lockedBy.clear();
    expect((await run({ locks, lockedBy, chat: win() })).outcome).toBe("drained");
    expect(lockedBy.size).toBe(0);
    expect((await run({ locks, lockedBy, chat: win(), release: async () => { throw new Error("boom"); }, wasSigned: async () => false })).outcome).toBe("release_failed");
    expect(lockedBy.size).toBe(0);
  });

  test("a lock on one tier does not block another", async () => {
    const locks = new Set<number>([1]);
    expect((await run({ locks, chat: win() }, inp(3))).outcome).toBe("drained");
  });

  test("drained deletes the lock, so the next round can run (E14)", async () => {
    const locks = new Set<number>();
    const d = deps({ locks, chat: win() }) as any;
    expect((await runAttempt(d, inp())).outcome).toBe("drained");
    expect(locks.has(1)).toBe(false);
    expect((await runAttempt(d, inp())).outcome).toBe("drained");
    expect(releases).toBe(2);
  });

  test("signed_pending_broadcast keeps the lock", async () => {
    const locks = new Set<number>();
    const d = deps({ locks, chat: win(), release: async () => { throw new BroadcastFailedError("ntx"); } }) as any;
    expect((await runAttempt(d, inp())).outcome).toBe("signed_pending_broadcast");
    expect(locks.has(1)).toBe(true);
    await expect(runAttempt(d, inp())).rejects.toBeInstanceOf(TierClosedError);
  });

  test("release_failed releases the lock, and the next attempt can win", async () => {
    const locks = new Set<number>();
    let n = 0;
    const d = deps({ locks, chat: win(), release: async () => { if (n++ === 0) throw new Error("rpc"); return { nearTx: "n", chainTxid: "c" }; } }) as any;
    expect((await runAttempt(d, inp())).outcome).toBe("release_failed");
    expect(locks.has(1)).toBe(false);
    expect((await runAttempt(d, inp())).outcome).toBe("drained");
  });

  test("the lock is taken only after the checks that can fail without a payout, so a blocked or refused attempt never holds it", async () => {
    const locks = new Set<number>();
    await run({ locks, firewall: block }, inp(3));
    await run({ locks });
    await run({ locks, chat: win(TB_OTHER) });
    expect(locks.size).toBe(0);
  });
});

describe("persist first, then update (E6)", () => {
  test("the releasing row exists, with the model's text, before release is called", async () => {
    await run({ chat: win() });
    expect(releases).toBe(1);
    expect(released[0].rowsThen).toEqual([{ id: rows[0].id, outcome: "releasing" }]);
    expect(rows.length).toBe(1);
  });

  test("release is called with the tier, the attempt id and the normalized payout address", async () => {
    const r = await run({ chat: win() });
    expect(released).toMatchObject([{ tier: 1, id: r.id, recipient: TB }]);
  });

  test("after release the same row is updated to drained with the transactions, and no second row is inserted", async () => {
    const r = await run({ chat: win() });
    expect(rows.length).toBe(1);
    expect(updates).toEqual([{ id: r.id, outcome: "drained", reply: "I will.", near_tx: "n", chain_txid: "c" }]);
    expect(rows[0]).toMatchObject({ outcome: "drained", near_tx: "n", chain_txid: "c" });
    expect(r).toMatchObject({ outcome: "drained", reply: "I will.", txs: { nearTx: "n", chainTxid: "c" } });
  });

  test.each([[undefined], [null], [{}], ["ok"], [{ nearTx: 5 }], [{ chainTxid: "c" }]])("a release that returns without throwing is a payout even when its answer is malformed (%p): drained, never release_failed", async answer => {
    const locks = new Set<number>();
    const r = await run({ locks, chat: win(), release: async () => answer });
    expect(r.outcome).toBe("drained");
    expect(locks.has(1)).toBe(false);
    expect(rows[0].outcome).toBe("drained");
    expect(updates[0]).toMatchObject({ outcome: "drained" });
    expect(Object.keys(updates[0]).every(k => ["id", "outcome", "reply", "near_tx", "chain_txid"].includes(k))).toBe(true);
    expect(typeof updates[0].near_tx === "string" || updates[0].near_tx === undefined).toBe(true);
  });

  test("if the update after a successful release fails, the result still reports the payout and the releasing row stays", async () => {
    const locks = new Set<number>();
    const r = await run({ locks, chat: win(), updateAttempt: async () => { throw new Error("convex down"); } });
    expect(r.outcome).toBe("drained");
    expect(r.txs).toEqual({ nearTx: "n", chainTxid: "c" });
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe("releasing");
    expect(locks.has(1)).toBe(false);
    expect(warnings).toEqual(["update_failed"]);
  });

  test("a warn hook that throws changes nothing", async () => {
    const r = await run({ chat: win(), updateAttempt: async () => { throw new Error("x"); }, warn: () => { throw new Error("hook"); } });
    expect(r.outcome).toBe("drained");
  });

  test("if the update after a broadcast failure fails, the result is still signed_pending_broadcast and the lock stays", async () => {
    const locks = new Set<number>();
    const r = await run({ locks, chat: win(), release: async () => { throw new BroadcastFailedError("ntx"); }, updateAttempt: async () => { throw new Error("convex down"); } });
    expect(r.outcome).toBe("signed_pending_broadcast");
    expect(r.txs).toEqual({ nearTx: "ntx" });
    expect(rows[0].outcome).toBe("releasing");
    expect(locks.has(1)).toBe(true);
  });

  test("if the update after a failed release fails, the result is still release_failed and the lock is freed", async () => {
    const locks = new Set<number>();
    const r = await run({ locks, chat: win(), release: async () => { throw new Error("rpc"); }, updateAttempt: async () => { throw new Error("convex down"); } });
    expect(r.outcome).toBe("release_failed");
    expect(locks.has(1)).toBe(false);
  });

  test("if the releasing row cannot be written, release is never called, the lock is freed and the error is passed on", async () => {
    const locks = new Set<number>();
    const boom = new Error("convex down");
    await expect(run({ locks, chat: win(), insertAttempt: async () => { throw boom; } })).rejects.toBe(boom);
    expect(releases).toBe(0);
    expect(locks.size).toBe(0);
    expect((await run({ locks, chat: win() })).outcome).toBe("drained");
  });

  test("a failed insert of an ordinary row (refused) is an error and holds nothing", async () => {
    const locks = new Set<number>();
    await expect(run({ locks, insertAttempt: async () => { throw new Error("convex down"); } })).rejects.toThrow("convex down");
    expect(locks.size).toBe(0);
  });

  test("BroadcastFailedError records the nearTx and keeps the lock", async () => {
    const locks = new Set<number>();
    const r = await run({ locks, chat: win(), release: async () => { throw new BroadcastFailedError("ntx"); } });
    expect(r).toMatchObject({ outcome: "signed_pending_broadcast", txs: { nearTx: "ntx" } });
    expect(updates).toEqual([{ id: r.id, outcome: "signed_pending_broadcast", reply: r.reply, near_tx: "ntx" }]);
    expect(r.reply).toBe("You won. The payout is signed on-chain and being broadcast; see /verify.");
    expect(locks.has(1)).toBe(true);
  });

  test("a failed release is release_failed with the copy from the brief, and the row is updated", async () => {
    const r = await run({ chat: win(), release: async () => { throw new Error("rpc"); } });
    expect(r).toMatchObject({ outcome: "release_failed", reply: "The agent agreed, but the payout failed before signing. The tier stays open." });
    expect(updates).toEqual([{ id: r.id, outcome: "release_failed", reply: r.reply }]);
  });
});

describe("a release that threw is checked against the contract (E6)", () => {
  const boom = async () => { throw new Error("rpc timeout"); };

  test("not signed (the check says false): release_failed, lock freed", async () => {
    const locks = new Set<number>();
    const asked: any[] = [];
    const r = await run({ locks, chat: win(), release: boom, wasSigned: async (t: number, id: string) => (asked.push([t, id]), false) });
    expect(r.outcome).toBe("release_failed");
    expect(asked).toEqual([[1, r.id]]);
    expect(locks.has(1)).toBe(false);
  });

  test("signed (the check says true): signed_pending_broadcast, lock kept, no transaction ids", async () => {
    const locks = new Set<number>();
    const r = await run({ locks, chat: win(), release: boom, wasSigned: async () => true });
    expect(r.outcome).toBe("signed_pending_broadcast");
    expect(r.txs).toBeUndefined();
    expect(locks.has(1)).toBe(true);
    expect(updates[0]).toEqual({ id: r.id, outcome: "signed_pending_broadcast", reply: r.reply });
    expect(releases).toBe(0); // boom does not count
  });

  test("the check itself failing is treated as signed, never as a safe release_failed", async () => {
    const locks = new Set<number>();
    const r = await run({ locks, chat: win(), release: boom, wasSigned: async () => { throw new Error("rpc down too"); } });
    expect(r.outcome).toBe("signed_pending_broadcast");
    expect(locks.has(1)).toBe(true);
    expect(warnings).toEqual(["was_signed_failed"]);
  });

  test.each([[undefined], [null], [0], ["false"], ["no"], [{}], [1], [NaN]])("an answer of %p from the check is not `false`, so it counts as signed", async answer => {
    const locks = new Set<number>();
    const r = await run({ locks, chat: win(), release: boom, wasSigned: async () => answer });
    expect(r.outcome).toBe("signed_pending_broadcast");
    expect(locks.has(1)).toBe(true);
  });

  test("the check is not consulted when release succeeded or when it threw BroadcastFailedError", async () => {
    let asked = 0;
    const wasSigned = async () => (asked++, false);
    await run({ chat: win(), wasSigned });
    await run({ chat: win(), wasSigned, release: async () => { throw new BroadcastFailedError("n"); }, locks: new Set() });
    expect(asked).toBe(0);
  });

  test("while the check runs the lock is held, so a second winner cannot start a payout", async () => {
    const locks = new Set<number>();
    const d = deps({ locks, chat: win(), release: boom, wasSigned: async () => (await sleep(30), false) }) as any;
    const first = runAttempt(d, inp());
    await sleep(10);
    await expect(runAttempt(d, inp())).rejects.toBeInstanceOf(TierClosedError);
    expect((await first).outcome).toBe("release_failed");
  });
});

describe("stage reporting (ruling 12)", () => {
  const record = () => {
    const seen: [string, string][] = [];
    return { seen, stage: (id: string, s: string) => void seen.push([id, s]) };
  };

  test("tier 1 without a call: reading, thinking, done", async () => {
    const s = record();
    const r = await run({ stage: s.stage });
    expect(s.seen).toEqual([[r.id, "reading"], [r.id, "thinking"], [r.id, "done"]]);
  });

  test("tier 3 with a payout: reading, firewall_a, thinking, firewall_b, signing, done", async () => {
    const s = record();
    const r = await run({ stage: s.stage, chat: win() }, inp(3));
    expect(s.seen.map(x => x[1])).toEqual(["reading", "firewall_a", "thinking", "firewall_b", "signing", "done"]);
    expect(new Set(s.seen.map(x => x[0]))).toEqual(new Set([r.id]));
  });

  test("a stage function that throws, rejects or hangs never stops an attempt or a payout", async () => {
    const hang = () => new Promise<void>(() => {});
    for (const stage of [() => { throw new Error("sync"); }, async () => { throw new Error("async"); }, hang]) {
      releases = 0;
      const r = await run({ stage, chat: win(), locks: new Set() }, inp(3));
      expect(r.outcome).toBe("drained");
      expect(releases).toBe(1);
    }
  });

  test("stage is optional", async () => {
    expect((await run({ stage: undefined })).outcome).toBe("refused");
  });

  test("a failed stage is reported to the warn hook and nothing else", async () => {
    await run({ stage: async () => { throw new Error("async"); } });
    await sleep(5);
    expect(warnings.every(w => w === "stage_failed")).toBe(true);
    expect(warnings.length).toBe(3);
  });

  test("the final stage is done, and a refused attempt row is inserted already at done", async () => {
    await run({});
    expect(rows[0].stage).toBe("done");
  });

  test("a payout row is inserted at stage signing, as releasing, and the update finishes it", async () => {
    const inserted: any[] = [];
    const r = await run({ chat: win(), insertAttempt: async (row: any) => void (inserted.push({ ...row }), rows.push(row)) });
    expect(inserted).toMatchObject([{ id: r.id, outcome: "releasing", stage: "signing", reply: "I will." }]);
    expect(rows[0].outcome).toBe("drained");
  });
});

describe("end to end over db.ts and the Convex functions", () => {
  const PEPPER = "test-pepper-0123456789abcdef-0123456789";
  const bridge = (t: any) => (async (url: string, init: RequestInit) => t.fetch(new URL(url).pathname, init)) as unknown as typeof globalThis.fetch;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  function rig(over: Partial<any> = {}, failOps: string[] = []) {
    const z = setup();
    const base = bridge(z.t);
    const f = (async (url: string, init: RequestInit) => {
      if (failOps.some(op => url.endsWith(`/agent/${op}`))) throw new Error("injected failure");
      return base(url, init);
    }) as unknown as typeof globalThis.fetch;
    const db = makeDb({ fetch: f, siteUrl: "https://agent-test.convex.site", secret: SECRET, pepper: PEPPER });
    const d = deps({ insertAttempt: (r: AttemptRow) => db.insertAttempt(r), updateAttempt: db.updateAttempt, stage: db.setStage, ...over }) as any;
    return { ...z, db, d };
  }

  test("a won round: the row ends drained, stage done, the leaf is the one the final row recomputes to, and no raw account or ip is stored", async () => {
    const z = rig({ chat: win(), clock: () => Date.UTC(2026, 10, 2, 12, 34, 56, 789) });
    const r = await runAttempt(z.d, inp(1, "hello", TB, { account: "alice-SENTINEL.near", ip: "203.0.113.77" }));
    expect(r.outcome).toBe("drained");
    const [stored] = (await z.dump()).attempts;
    expect(stored).toMatchObject({ id: r.id, outcome: "drained", stage: "done", near_tx: "n", chain_txid: "c", ts: "2026-11-02T12:34:56.789Z", payout_address: TB, consent_version: "consent-v1", hidden: false });
    expect(stored!.account_hash).toBe(sha("alice-SENTINEL.near" + PEPPER));
    // the leaf was written when the row was `releasing`; the exported final row recomputes to it
    expect(stored!.leaf).toBe(attemptLeaf({ ...stored!, ts: stored!.ts } as any));
    const page = await z.db.listAttempts("", null, 10);
    expect(attemptLeaf(page.rows[0] as any)).toBe(stored!.leaf);
    const all = JSON.stringify(await z.dump());
    for (const raw of ["alice-SENTINEL", "203.0.113.77"]) expect(all).not.toContain(raw);
    expect(await z.t.query(api.counters.tiers, {})).toEqual([{ tier: 1, attempts: 1, nearMisses: 0 }, { tier: 2, attempts: 0, nearMisses: 0 }, { tier: 3, attempts: 0, nearMisses: 0 }]);
  });

  test("a refusal, a near miss, a tool error and a lost race each become one row whose leaf recomputes", async () => {
    const z = rig({ chat: win(TB_OTHER) });
    await runAttempt(z.d, inp(1)); // tool_error
    let n = 0;
    await runAttempt({ ...z.d, firewall: async () => (n++ === 0 ? allow() : block()), chat: win(), locks: new Set() }, inp(3)); // blocked_b
    await runAttempt({ ...z.d, chat: async () => ({ raw: {}, toolCalls: [], text: "No." }) }, inp(1)); // refused
    const page = await z.db.listAttempts("", null, 10);
    expect(page.rows.map(r => r.outcome).sort()).toEqual(["blocked_b", "refused", "tool_error"]);
    for (const row of page.rows) expect(attemptLeaf(row as any)).toBe(row.leaf as string);
    expect(await z.t.query(api.counters.tiers, {})).toMatchObject([{ attempts: 2 }, { attempts: 0 }, { attempts: 1, nearMisses: 1 }]);
  });

  test("the public view of a blocked_b attempt has the risk and no reason", async () => {
    let n = 0;
    const z = rig({ firewall: async () => (n++ === 0 ? allow() : block()), chat: win() });
    const r = await runAttempt(z.d, inp(3));
    const pub = (await z.t.query(api.attempts.get, { id: r.id })) as any;
    expect(pub).toMatchObject({ outcome: "blocked_b", stage: "done", technique: "tool_spoof", fw_b: { verdict: "block", risk: 90 } });
    expect(JSON.stringify(pub)).not.toContain("SECRET-REASON");
  });

  test("when the Convex update fails after the payout, the row stays releasing in the store and the player still gets the win", async () => {
    const z = rig({ chat: win() }, ["attempt_finish"]);
    const r = await runAttempt(z.d, inp());
    expect(r.outcome).toBe("drained");
    expect((await z.dump()).attempts.map(a => a.outcome)).toEqual(["releasing"]);
  });

  test("when Convex is down for the releasing insert, no payout is made", async () => {
    const z = rig({ chat: win() }, ["attempt_insert"]);
    await expect(runAttempt(z.d, inp())).rejects.toThrow("db attempt_insert failed");
    expect(releases).toBe(0);
  });

  test("when every stage call fails the attempt still completes", async () => {
    const z = rig({ chat: win() }, ["attempt_stage"]);
    expect((await runAttempt(z.d, inp())).outcome).toBe("drained");
    expect((await z.dump()).attempts[0]!.outcome).toBe("drained");
  });

  test("a pot of attempts over Convex counters: concurrent tier-3 checkpoints never pass the arena limit", async () => {
    const z = rig();
    const budget = makeBudget({ counter: z.db.counter, clock: () => Date.UTC(2026, 10, 2, 12), limits: { arena: 5 } });
    const firewall = makeArenaFirewall({ budget, judge: async () => ({ risk: 1, technique: "none", reason: "ok" }) });
    const rs = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => runAttempt({ ...z.d, firewall, locks: new Set() }, inp(3, `m${i}`))));
    expect(rs.filter(r => r.status === "fulfilled").length).toBe(5);
    expect(rs.filter(r => r.status === "rejected" && r.reason instanceof BudgetExhaustedError).length).toBe(3);
    expect((await z.dump()).attempts.length).toBe(5);
  });

  test("stage updates reach the row once it exists, never backward", async () => {
    const z = rig({ chat: win() });
    const r = await runAttempt(z.d, inp());
    await sleep(20);
    expect(((await z.t.query(api.attempts.get, { id: r.id })) as any).stage).toBe("done");
  });

  test("isoMs is what the pipeline writes for ts by default", async () => {
    const before = Date.now();
    await run({});
    const t = Date.parse(rows[0].ts);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(rows[0].ts).toBe(isoMs(t));
  });
});
