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
const APPROVAL_POLL_MS = 5 * 60_000;
const APPROVAL_LOG_EVERY = 12; // one tee_waiting_for_approval line an hour
const TRIES = 5; // register and the key swap: 15 s, 30 s, 60 s, 120 s between tries
const RETRY_MS = 15_000;
// ERR_ATTESTATION after funding is most likely a PPID approval not landed yet (this boot does not check PPIDs): 6 more tries, 5 min apart.
const ATTESTATION_RETRIES = 6;
const ATTESTATION_RETRY_MS = 5 * 60_000;
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

const dstack = (f: typeof fetch, path: string, body: unknown) => f(`http://localhost/${path}`, { method: "POST", ...DSTACK, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) } as RequestInit);
async function tcbInfo(f: typeof fetch): Promise<any> {
  const info = await json(await dstack(f, "Info", {}), "dstack Info");
  return typeof info.tcb_info === "string" ? JSON.parse(info.tcb_info) : info.tcb_info;
}

// This CVM's measurements in the contract's FullMeasurementsHex shape, as propose_measurements takes them.
export type Measurements = { rtmrs: { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string }; key_provider_event_digest: string; app_compose_hash_payload: string };
export function measurementsOf(tcb: any): Measurements {
  const kp = (tcb?.event_log ?? []).find((e: any) => e?.imr === 3 && e?.event === "key-provider");
  return {
    rtmrs: { mrtd: field(tcb, "mrtd", "tcb"), rtmr0: field(tcb, "rtmr0", "tcb"), rtmr1: field(tcb, "rtmr1", "tcb"), rtmr2: field(tcb, "rtmr2", "tcb") },
    key_provider_event_digest: field(kp, "digest", "tcb key-provider event"),
    app_compose_hash_payload: field(tcb, "compose_hash", "tcb"),
  };
}
const sameMeasurements = (a: Measurements, b: Measurements) => {
  const flat = (m: Measurements) => [m.rtmrs.mrtd, m.rtmrs.rtmr0, m.rtmrs.rtmr1, m.rtmrs.rtmr2, m.key_provider_event_digest, m.app_compose_hash_payload].map(x => String(x).toLowerCase()).join();
  return flat(a) === flat(b);
};

// A quote over this account from the dstack guest socket, with Phala's collateral, in the shape register_agent takes.
export async function buildAttestation(f: typeof fetch, account: string): Promise<Attestation> {
  const post = (path: string, body: unknown) => dstack(f, path, body);
  const tcb = await tcbInfo(f);
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

  // A first deploy's measurements wait out the owner's 24 h approval timelock. Wait here, before anyone funds the account, so a
  // refused register_agent cannot strand the money. The PPID is not checked here (it is in the quote's PCK cert): the owner must
  // already have approved Phala's PPID list.
  const measurements = measurementsOf(await tcbInfo(o.fetch));
  log("tee_measurements", { measurements });
  for (let i = 0; ; i++) {
    try {
      if (((await vault.approvedMeasurements()) as Measurements[]).some(m => sameMeasurements(m, measurements))) break;
      if (i % APPROVAL_LOG_EVERY === 0) log("tee_waiting_for_approval");
    } catch (e) {
      log("tee_approval_poll_failed", { error: errOf(e) });
    }
    await sleep(APPROVAL_POLL_MS);
  }

  log("tee_fund_me", { measurements });
  for (;;) {
    try {
      if ((await vault.balance()) >= MIN_BALANCE) break;
    } catch (e) {
      log("tee_fund_poll_failed", { error: errOf(e) });
    }
    await sleep(FUND_POLL_MS);
  }

  // Bounded retries. A failure left here strands the funded account: its keys die with this process.
  // "fast": RPC trouble, doubling waits. "slow": ERR_ATTESTATION, fixed waits. Each kind keeps its own count.
  type Kind = "terminal" | "fast" | "slow";
  const retry = async (step: string, fn: () => Promise<void>, kind: (e: unknown) => Kind = () => "fast") => {
    for (let fast = 0, slow = 0; ; ) {
      try {
        return await fn();
      } catch (e) {
        const k = kind(e);
        const n = k === "slow" ? ++slow : ++fast;
        if (k === "terminal" || n > (k === "slow" ? ATTESTATION_RETRIES : TRIES - 1)) {
          log("tee_stranded", { step, error: errOf(e) });
          throw e;
        }
        log("tee_retry", { step, try: fast + slow, error: errOf(e) });
        await sleep(k === "slow" ? ATTESTATION_RETRY_MS : RETRY_MS * 2 ** (n - 1));
      }
    }
  };
  const scopedNow = async () => keysAreScoped(await vault.accessKeys(), o.vault);
  // A retry after a lost answer is a renewal on-chain, which is fine. Any ERR_ but ERR_ATTESTATION will not change on retry.
  const registerKind = (e: unknown): Kind => (!(e instanceof ContractRefusedError) ? "fast" : /^ERR_ATTESTATION\b/.test(e.code) ? "slow" : "terminal");
  await retry("register", async () => vault.registerAgent(await buildAttestation(o.fetch, account), STORAGE_DEPOSIT), registerKind);
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
