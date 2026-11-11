import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { KeyPair, transactions, utils } from "near-api-js";
import { AGENT_METHODS } from "../../scripts/check-agent-key";
import { makeChainDeps } from "../src/chain/vault";
import type { Config } from "../src/config";
import { bootTee, buildAttestation, reportData, startRenewal } from "../src/tee";

const fixture = JSON.parse(readFileSync(new URL("../../contracts/vault/tests/fixtures/s3-attestation.json", import.meta.url), "utf8"));
const RPC = "https://rpc.test";
const VAULT = "vault.testnet";
const NEAR = 10n ** 24n;
const hexOf = (pk: any) => Buffer.from(pk.ed25519Key.data).toString("hex");

// One fake for the dstack socket, Phala's collateral API and the NEAR RPC. The NEAR side keeps the agent account's keys, so the
// key list it answers is what the broadcast txs made of it.
// Balance -1 is "no account yet", -2 an RPC outage. `lose` drops the answer to the first broadcast of that kind after applying it.
function fakeNet(o: { balances?: bigint[]; registerFails?: string; keyList?: (keys: any[]) => any[]; lose?: "register" | "scope"; collateral?: object } = {}) {
  const balances = [...(o.balances ?? [NEAR])];
  const txs: any[] = [];
  const quotes: string[] = [];
  const forms: string[] = [];
  let keys: any[] = [];
  let failNext: unknown = null;
  const f = (async (url: string, init: any = {}) => {
    const u = String(url);
    if (u.startsWith("http://localhost/")) {
      expect(init.unix).toBe("/var/run/dstack.sock");
      if (u.endsWith("/Info")) return Response.json({ tcb_info: JSON.stringify({ ...fixture.tcb_info, extra: "ignored" }) });
      quotes.push(JSON.parse(init.body).report_data);
      return Response.json({ quote: "0x" + Buffer.from(fixture.quote).toString("hex"), event_log: "[]" });
    }
    if (u.startsWith("https://cloud-api.phala.network/")) {
      forms.push((init.body as FormData).get("hex") as string);
      return Response.json({ quote_collateral: o.collateral ?? fixture.collateral });
    }
    const { method, params } = JSON.parse(init.body);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: "x", result });
    if (method === "query" && params.request_type === "view_account") {
      const b = balances.length > 1 ? balances.shift()! : balances[0]!;
      if (b === -2n) return new Response("bad gateway", { status: 502 });
      return b < 0n ? Response.json({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }) : ok({ amount: b.toString() });
    }
    if (method === "query" && params.request_type === "view_access_key") return ok({ nonce: 5, block_hash: utils.serialize.base_encode(new Uint8Array(32)), block_height: 10 });
    if (method === "query" && params.request_type === "view_access_key_list") return ok({ keys: o.keyList ? o.keyList(keys) : keys });
    if (method === "broadcast_tx_async") {
      const t = transactions.SignedTransaction.decode(Buffer.from(params[0], "base64")).transaction;
      txs.push(t);
      const a = t.actions[0] as any;
      if (a.functionCall?.methodName === "register_agent" && o.registerFails) failNext = { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${o.registerFails}` } } } };
      if (a.addKey) {
        const fc = a.addKey.accessKey.permission.functionCall;
        keys = [{ public_key: hexOf(a.addKey.publicKey), access_key: { nonce: 0, permission: { FunctionCall: { receiver_id: fc.receiverId, method_names: fc.methodNames, allowance: fc.allowance.toString() } } } }];
      }
      const kind = a.addKey ? "scope" : a.functionCall?.methodName === "register_agent" ? "register" : "";
      if (o.lose && o.lose === kind) {
        delete o.lose;
        if (kind === "register") txs.pop(); // never reached the chain
        return Response.json({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } });
      }
      return ok("hash");
    }
    if (method === "tx") {
      const status = failNext ? { Failure: failNext } : { SuccessValue: "" };
      failNext = null;
      return ok({ final_execution_status: "FINAL", status, receipts_outcome: [] });
    }
    throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
  }) as unknown as typeof fetch;
  return { f, txs, quotes, forms };
}

const keys = () => {
  const made: KeyPair[] = [];
  return { made, newKey: () => (made.push(KeyPair.fromRandom("ed25519")), made.at(-1)!) };
};
const noSecrets = (b: { lines: string[]; k: { made: KeyPair[] } }, extra: string[] = []) => {
  expect(b.k.made.length).toBe(2);
  for (const k of b.k.made) for (const l of [...b.lines, ...extra]) expect(l).not.toContain(k.toString().slice("ed25519:".length));
};
const boot = (net: ReturnType<typeof fakeNet>, x: Partial<Parameters<typeof bootTee>[0]> = {}) => {
  const lines: string[] = [];
  const k = keys();
  const slept: number[] = [];
  const p = bootTee({ fetch: net.f, rpcUrl: RPC, vault: VAULT, log: l => void lines.push(l), newKey: k.newKey, sleep: async ms => void slept.push(ms), ...x });
  return { p, lines, k, slept };
};

describe("attestation", () => {
  test("report data is the 32 account bytes then 32 zero bytes", () => {
    const acct = "ab".repeat(32);
    expect(reportData(acct)).toBe(acct + "0".repeat(64));
    expect(reportData(acct).length).toBe(128);
  });
  test("built from dstack Info + GetQuote and Phala collateral, in the contract's shape", async () => {
    const net = fakeNet();
    const acct = "cd".repeat(32);
    const a = await buildAttestation(net.f, acct);
    expect(net.quotes).toEqual([reportData(acct)]);
    expect(net.forms).toEqual([Buffer.from(fixture.quote).toString("hex")]); // no 0x
    expect(a.quote).toEqual(fixture.quote);
    expect(Object.keys(a).sort()).toEqual(Object.keys(fixture).sort());
    expect(Object.keys(a.collateral).sort()).toEqual(Object.keys(fixture.collateral).sort());
    expect(Object.keys(a.tcb_info).sort()).toEqual(Object.keys(fixture.tcb_info).sort());
    expect(a).toEqual(fixture); // the fixture went through the same pipe unchanged
  });
});

describe("bootTee", () => {
  test("asks to be funded, polls every 15 s until 0.6 NEAR, registers, swaps to a scoped key and returns it", async () => {
    const net = fakeNet({ balances: [-1n, NEAR / 2n, (6n * NEAR) / 10n] });
    const b = boot(net);
    const r = await b.p;
    const [F, S] = b.k.made;
    expect(r.account).toBe(Buffer.from(F!.getPublicKey().data).toString("hex"));
    expect(r.account).toMatch(/^[0-9a-f]{64}$/);
    expect(r.key.getPublicKey().toString()).toBe(S!.getPublicKey().toString());
    expect(JSON.parse(b.lines[0]!)).toEqual({ event: "tee_fund_me", account: r.account });
    expect(b.slept.filter(ms => ms === 15_000).length).toBe(2);

    const [reg, rot] = net.txs;
    expect(net.txs.length).toBe(2);
    const fc = reg.actions[0].functionCall;
    expect(reg.signerId).toBe(r.account);
    expect(reg.receiverId).toBe(VAULT);
    expect(fc.methodName).toBe("register_agent");
    expect(fc.gas).toBe(300n * 10n ** 12n);
    expect(fc.deposit).toBe(10n ** 22n); // 0.01 NEAR storage
    expect(Object.keys(JSON.parse(Buffer.from(fc.args).toString()).attestation).sort()).toEqual(["collateral", "quote", "tcb_info"]);
    expect(hexOf(reg.publicKey)).toBe(r.account); // signed by F

    expect(rot.receiverId).toBe(r.account);
    expect(rot.actions.length).toBe(2);
    const add = rot.actions[0].addKey;
    expect(hexOf(add.publicKey)).toBe(Buffer.from(S!.getPublicKey().data).toString("hex"));
    expect(add.accessKey.permission.functionCall).toMatchObject({ receiverId: VAULT, methodNames: AGENT_METHODS, allowance: NEAR });
    expect(hexOf(rot.actions[1].deleteKey.publicKey)).toBe(r.account); // F goes
  });
  test("a contract refusal is terminal: no retry, a tee_stranded line names the account, and the ERR_ string is thrown", async () => {
    const net = fakeNet({ registerFails: "ERR_ATTESTATION: measurements not approved" });
    const b = boot(net);
    await expect(b.p).rejects.toThrow("ERR_ATTESTATION: measurements not approved");
    expect(net.txs.length).toBe(1); // one register, no key swap
    const account = Buffer.from(b.k.made[0]!.getPublicKey().data).toString("hex");
    expect(JSON.parse(b.lines.at(-1)!)).toEqual({ event: "tee_stranded", account, step: "register", error: "ERR_ATTESTATION: measurements not approved" });
    expect(b.slept).toEqual([]);
    noSecrets(b);
  });
  test("an RPC failure on register is retried after 15 s; a lost answer to the key swap is settled by the key list", async () => {
    const net = fakeNet({ lose: "register" });
    const b = boot(net);
    await b.p;
    expect(b.slept).toEqual([15_000]);
    expect(b.lines.map(l => JSON.parse(l).event)).toEqual(["tee_fund_me", "tee_retry", "tee_registered"]);
    const lost = fakeNet({ lose: "scope" });
    const c = boot(lost);
    await c.p;
    expect(lost.txs.length).toBe(2); // the swap landed once and was not sent again
    expect(c.lines.map(l => JSON.parse(l).event)).toEqual(["tee_fund_me", "tee_retry", "tee_registered"]);
  });
  test("RPC trouble keeps failing: five tries 15 s doubling, then tee_stranded", async () => {
    const net = fakeNet();
    const failing = (async (url: string, init: any) => (String(url) === RPC && JSON.parse(init.body).method === "broadcast_tx_async" ? new Response("down", { status: 503 }) : net.f(url, init))) as unknown as typeof fetch;
    const b = boot(net, { fetch: failing });
    await expect(b.p).rejects.toThrow("http 503");
    expect(b.slept).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(JSON.parse(b.lines.at(-1)!)).toMatchObject({ event: "tee_stranded", step: "register" });
  });
  test("a failed balance poll is logged and polled again", async () => {
    const b = boot(fakeNet({ balances: [-2n, NEAR] }));
    await b.p;
    expect(JSON.parse(b.lines[1]!)).toMatchObject({ event: "tee_fund_poll_failed" });
    expect(b.slept).toEqual([15_000]);
  });
  test("refuses to serve when the account still has a key that is not vault-scoped", async () => {
    const net = fakeNet({ keyList: k => [...k, { public_key: "x", access_key: { nonce: 0, permission: "FullAccess" } }] });
    await expect(boot(net).p).rejects.toThrow("not scoped");
  });
  test("a missing collateral or tcb field fails before any gas is spent", async () => {
    const { tcb_info: _drop, ...partial } = fixture.collateral;
    await expect(buildAttestation(fakeNet({ collateral: partial }).f, "ab".repeat(32))).rejects.toThrow("phala collateral missing tcb_info");
    const noTcb = fakeNet();
    const f = (async (url: string, init: any) => (String(url).endsWith("/Info") ? Response.json({ tcb_info: JSON.stringify({ ...fixture.tcb_info, mrtd: undefined }) }) : noTcb.f(url, init))) as unknown as typeof fetch;
    await expect(buildAttestation(f, "ab".repeat(32))).rejects.toThrow("tcb missing mrtd");
  });
  test("no secret key ever reaches a log line", async () => {
    const net = fakeNet({ balances: [0n, NEAR] });
    const b = boot(net);
    await b.p;
    expect(b.lines.length).toBeGreaterThan(0);
    noSecrets(b);
  });
});

describe("startRenewal", () => {
  test("re-registers with a fresh attestation and deposit 0; a failure alerts and retries sooner", async () => {
    const net = fakeNet();
    const calls: { att: any; dep: bigint }[] = [];
    const alerts: [string, Record<string, unknown>][] = [];
    const lines: string[] = [];
    let n = 0;
    const k = keys();
    k.newKey();
    k.newKey();
    const stop = startRenewal({
      fetch: net.f, account: "ef".repeat(32), everyMs: 40, retryMs: 5,
      funds: async () => ({ allowance: NEAR / 10n, balance: NEAR }), // 0.1 NEAR of allowance left: below 0.2
      register: async (att, dep) => {
        calls.push({ att, dep });
        if (n++ === 0) throw new Error("ERR_ATTESTATION: stale collateral");
      },
      log: l => void lines.push(l), alert: (k, d) => void alerts.push([k, d]),
    });
    try {
      for (let i = 0; i < 100 && calls.length < 2; i++) await Bun.sleep(5);
      expect(calls.length).toBe(2);
      expect(calls.every(c => c.dep === 0n)).toBe(true);
      expect(calls[0]!.att.quote).toEqual(fixture.quote);
      expect(net.quotes[0]).toBe(reportData("ef".repeat(32)));
      expect(alerts.slice(0, 3)).toEqual([
        ["tee_low_funds", { allowance: (NEAR / 10n).toString(), balance: NEAR.toString() }],
        ["tee_renew_failed", { error: "ERR_ATTESTATION: stale collateral" }],
        ["tee_low_funds", { allowance: (NEAR / 10n).toString(), balance: NEAR.toString() }],
      ]);
      expect(lines.map(l => JSON.parse(l).event).slice(0, 3)).toEqual(["tee_low_funds", "tee_renew_failed", "tee_low_funds"]);
      noSecrets({ lines, k: k }, alerts.map(a => JSON.stringify(a)));
    } finally {
      stop();
    }
    const done = calls.length;
    await Bun.sleep(60);
    expect(calls.length).toBe(done); // stopped
  });
});

describe("the serving vault", () => {
  test("registerAgent and a concurrent log_attempt_roots share the nonce lock: increasing nonces, to the vault, signed by S", async () => {
    const net = fakeNet();
    const S = KeyPair.fromRandom("ed25519");
    const account = "ab".repeat(32);
    const cfg = { network: "testnet", nearRpc: RPC, vaultAccount: VAULT, agentAccount: account, mempoolBase: "https://mempool.test", baseRpc: "", btcHrp: "tb" } as Config;
    const deps = makeChainDeps(cfg, { signer: { publicKey: S.getPublicKey().toString(), sign: async m => S.sign(m).signature }, db: {} as never, onSettled: () => {}, fetch: net.f });
    await Promise.all([deps.registerAgent(fixture, 0n), deps.logAttemptRoots(1, [[1, "00".repeat(32)]]), deps.registerAgent(fixture, 0n)]);
    expect(net.txs.length).toBe(3);
    const nonces = net.txs.map(t => Number(t.nonce));
    expect(nonces).toEqual([...nonces].sort((a, b) => a - b));
    expect(new Set(nonces).size).toBe(3);
    for (const t of net.txs) {
      expect(t.receiverId).toBe(VAULT);
      expect(t.signerId).toBe(account);
      expect(hexOf(t.publicKey)).toBe(Buffer.from(S.getPublicKey().data).toString("hex"));
    }
    expect(net.txs.map(t => t.actions[0].functionCall.deposit)).toEqual([0n, 0n, 0n]);
  });
});
