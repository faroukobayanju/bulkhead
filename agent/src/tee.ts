// TEE boot (TEE=1): the agent makes its own implicit account, waits to be funded, registers with the vault by a Phala TDX quote
// that binds the account, then swaps its full-access key for one that can only call the vault. The secrets live in memory only.
import { KeyPair } from "near-api-js";
import { keysAreScoped } from "../../scripts/check-agent-key";
import { ContractRefusedError, makeVault, type Signer } from "./chain/vault";

const DSTACK = { unix: "/var/run/dstack.sock" };
const PHALA_VERIFY = "https://cloud-api.phala.network/api/v1/attestations/verify";
const NEAR = 10n ** 24n;
const MIN_BALANCE = (6n * NEAR) / 10n; // registering needs ~0.31 NEAR free; the rest pays for gas
const STORAGE_DEPOSIT = NEAR / 100n; // first registration stores ~486 bytes
// The scoped key's lifetime gas budget: with the full-access key gone nothing can top it up. The most check-agent-key.ts accepts.
const ALLOWANCE = NEAR;
const FUND_POLL_MS = 15_000;
const TRIES = 5; // register and the key swap: 15 s, 30 s, 60 s, 120 s between tries
const RETRY_MS = 15_000;
const LOW_ALLOWANCE = NEAR / 5n;
const LOW_BALANCE = NEAR / 10n;

// The contract wants the 32 account-id bytes, then 32 zero bytes.
export const reportData = (account: string) => account + "0".repeat(64);

export type Attestation = { quote: number[]; collateral: Record<string, string>; tcb_info: Record<string, unknown> };
const COLLATERAL = ["pck_crl_issuer_chain", "root_ca_crl", "pck_crl", "tcb_info_issuer_chain", "tcb_info", "tcb_info_signature", "qe_identity_issuer_chain", "qe_identity", "qe_identity_signature"];
const TCB = ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3", "os_image_hash", "compose_hash", "device_id", "app_compose"];

// A missing field would only fail on-chain, after the gas is spent.
function field(o: any, k: string, what: string): string {
  if (typeof o?.[k] !== "string") throw new Error(`${what} missing ${k}`);
  return o[k];
}

async function json(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what}: http ${res.status}`);
  return res.json();
}

// A quote over this account from the dstack guest socket, with Phala's collateral, in the shape register_agent takes.
export async function buildAttestation(f: typeof fetch, account: string): Promise<Attestation> {
  const post = (path: string, body: unknown) => f(`http://localhost/${path}`, { method: "POST", ...DSTACK, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) } as RequestInit);
  const info = await json(await post("Info", {}), "dstack Info");
  const tcb = typeof info.tcb_info === "string" ? JSON.parse(info.tcb_info) : info.tcb_info;
  const quoteHex = String((await json(await post("GetQuote", { report_data: reportData(account) }), "dstack GetQuote")).quote).replace(/^0x/, "");
  const form = new FormData();
  form.append("hex", quoteHex);
  const c = (await json(await f(PHALA_VERIFY, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) }), "phala collateral")).quote_collateral;
  return {
    quote: [...Buffer.from(quoteHex, "hex")],
    collateral: Object.fromEntries(COLLATERAL.map(k => [k, field(c, k, "phala collateral")])),
    tcb_info: {
      ...Object.fromEntries(TCB.map(k => [k, field(tcb, k, "tcb")])),
      event_log: (tcb.event_log ?? []).map((e: any) => ({ imr: e.imr, event_type: e.event_type, digest: e.digest, event: e.event, event_payload: e.event_payload })),
    },
  };
}

const signerOf = (k: KeyPair): Signer => ({ publicKey: k.getPublicKey().toString(), sign: async m => k.sign(m).signature });

export async function bootTee(o: { fetch: typeof fetch; rpcUrl: string; vault: string; log: (line: string) => void; newKey?: () => KeyPair; sleep?: (ms: number) => Promise<void> }): Promise<{ account: string; key: KeyPair }> {
  const newKey = o.newKey ?? (() => KeyPair.fromRandom("ed25519"));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const full = newKey();
  const scoped = newKey();
  const account = Buffer.from(full.getPublicKey().data).toString("hex");
  // Only the NEAR calls of makeVault are used here: no tier is ever read, so the payout settings stay empty.
  const vault = makeVault({ fetch: o.fetch, rpcUrl: o.rpcUrl, vaultAccount: o.vault, agentAccount: account, signer: signerOf(full), signerAccount: "", btc: null as never, hrp: "tb", storeSignedTx: async () => {}, sleep });

  const log = (event: string, data: Record<string, unknown> = {}) => o.log(JSON.stringify({ event, account, ...data }));
  const errOf = (e: unknown) => (e as Error)?.message ?? String(e);

  log("tee_fund_me");
  for (;;) {
    try {
      if ((await vault.balance()) >= MIN_BALANCE) break;
    } catch (e) {
      log("tee_fund_poll_failed", { error: errOf(e) });
    }
    await sleep(FUND_POLL_MS);
  }

  // Bounded retries. A failure left here strands the funded account: its keys die with this process.
  const retry = async (step: string, fn: () => Promise<void>, terminal: (e: unknown) => boolean = () => false) => {
    for (let i = 1, wait = RETRY_MS; ; i++, wait *= 2) {
      try {
        return await fn();
      } catch (e) {
        if (terminal(e) || i >= TRIES) {
          log("tee_stranded", { step, error: errOf(e) });
          throw e;
        }
        log("tee_retry", { step, try: i, error: errOf(e) });
        await sleep(wait);
      }
    }
  };
  const scopedNow = async () => keysAreScoped(await vault.accessKeys(), o.vault);
  // A retry after a lost answer is a renewal on-chain, which is fine. An ERR_ from the contract will not change on retry.
  await retry("register", async () => vault.registerAgent(await buildAttestation(o.fetch, account), STORAGE_DEPOSIT), e => e instanceof ContractRefusedError);
  // The swap may have landed even when its answer was lost; then F is gone and only the key list can say so.
  let tries = 0;
  await retry("scope_keys", async () => {
    if (tries++ > 0 && (await scopedNow())) return;
    await vault.scopeKeys(scoped.getPublicKey().toString(), ALLOWANCE);
  });
  if (!(await scopedNow())) {
    log("tee_stranded", { step: "check_keys" });
    throw new Error(`agent account ${account} has keys not scoped to ${o.vault}: refusing to serve`);
  }
  log("tee_registered");
  return { account, key: scoped };
}

// The registration lasts 7 days: renew every `everyMs` (6 days) through the serving vault's nonce lock; a failure retries in an hour.
export function startRenewal(o: {
  fetch: typeof fetch;
  account: string;
  register: (attestation: Attestation, depositYocto: bigint) => Promise<void>;
  funds: () => Promise<{ allowance: bigint; balance: bigint }>; // the scoped key's allowance left, and the account balance
  log: (line: string) => void;
  alert: (kind: string, details: Record<string, unknown>) => void;
  everyMs?: number;
  retryMs?: number;
}): () => void {
  const everyMs = o.everyMs ?? 6 * 86_400_000;
  const retryMs = o.retryMs ?? 3_600_000;
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const run = async () => {
    let next = everyMs;
    try {
      const f = await o.funds();
      if (f.allowance < LOW_ALLOWANCE || f.balance < LOW_BALANCE) {
        const d = { allowance: f.allowance.toString(), balance: f.balance.toString() };
        o.log(JSON.stringify({ event: "tee_low_funds", account: o.account, ...d }));
        o.alert("tee_low_funds", d);
      }
    } catch (e) {
      o.log(JSON.stringify({ event: "tee_funds_check_failed", account: o.account, error: (e as Error)?.message ?? String(e) }));
    }
    try {
      await o.register(await buildAttestation(o.fetch, o.account), 0n);
      o.log(JSON.stringify({ event: "tee_renewed", account: o.account }));
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      o.log(JSON.stringify({ event: "tee_renew_failed", account: o.account, error }));
      o.alert("tee_renew_failed", { error });
      next = retryMs;
    }
    if (!stopped) timer = setTimeout(run, next);
  };
  timer = setTimeout(run, everyMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
