// The HTTP surface. Reachable only through the web proxy (M11): /session and /attempt need the proxy secret, which is also what
// makes x-real-ip trustworthy. /v1/check is mounted from firewall/api.ts (API key or proxy secret). No CORS is set.
// Chain and database access are injected; src/main.ts is the only file that builds the real ones.
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Hono, type Context } from "hono";
import { ulid } from "ulid";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { MAX_MESSAGE, type Stage } from "../../shared/attempt";
import { isoMs } from "../../shared/leaf";
import { verifyNep413 } from "./auth";
import { CHAIN, parsePayee, type Hrp } from "./address";
import { NOT_VERIFIED } from "./attest";
import type { Db } from "./db";
import { firewallRoutes, type CheckReq, type FirewallDeps, type FirewallResult } from "./firewall/api";
import { ipKey, SlidingWindow } from "./firewall/window";
import type { ChatOut, Tier } from "./llm";
import {
  AttestationUnavailableError, BadPayoutAddressError, BudgetExhaustedError, BudgetUnavailableError, ConsentRequiredError,
  FirewallDegradedError, LlmUnavailableError, MessageTooLongError, SpendCapError, TierClosedError, TierCoolingError, runAttempt,
  type AttemptResult, type TierState,
} from "./pipeline";
import { RateLimiter } from "./ratelimit";
import { responseVerified, withCompletions } from "./completions";

// What the chain side must provide (Task 9a builds it; tests use fakes).
export type ChainDeps = {
  // Signs and broadcasts the payout. Throws BroadcastFailedError(nearTx) when the contract signed but the broadcast failed.
  release: (tier: Tier, attemptId: string, recipient: string) => Promise<{ nearTx: string; chainTxid: string }>;
  // Contract status and cooldown. Open with retryAfterS > 0 is a cooldown.
  tierOpen: (tier: Tier) => Promise<TierState>;
  // After `release` threw: did the contract sign for this attempt? Returns false ONLY when the release tx is known final-failed (or
  // never included) AND get_pending_tx(attemptId) is None. THROWS when that is unknown: a tx still in flight can execute later,
  // and the pipeline treats a throw as "signed" (outcome signed_pending_broadcast, lock kept).
  wasSigned: (tier: Tier, attemptId: string) => Promise<boolean>;
  // true only for a FullAccess key on the account; false when the key is absent; THROWS on RPC failure (see accesskey.ts).
  viewAccessKey: (accountId: string, publicKey: string) => Promise<boolean>;
  // Keeps the fully signed tx so the rebroadcast loop can resend it (E6). Called by the chain side; the server never calls it.
  storeSignedTx: (attemptId: string, chain: "btc" | "evm", hex: string) => Promise<void>;
};

export type AttemptDb = Pick<Db, "ping" | "insertAttempt" | "updateAttempt" | "setStage"> & {
  // The public row of an attempt (reasons already stripped), or null. Only read for ids this process does not hold.
  getAttempt: (id: string) => Promise<Record<string, any> | null>;
};
export type Alert = (kind: string, details: Record<string, unknown>) => void | Promise<void>;

export type ServerDeps = {
  cfg: {
    network: "testnet" | "mainnet";
    mock: boolean;
    btcHrp: Hrp;
    proxySecret: string;
    sessionSecret: string;
    siteUrl: string;
    codehash: string;
    firewallVersion: string;
    configSha: string;
    models: Record<Tier, string>;
    tierEnabled: Record<Tier, boolean>;
    judgeModel: string;
  };
  chain: ChainDeps;
  db: AttemptDb;
  chat: (tier: Tier, userMsg: string) => Promise<ChatOut>;
  arenaFirewall: (req: CheckReq) => Promise<FirewallResult>;
  attest: (tier: Tier) => Promise<{ sha256: string; modelId: string }>;
  promptSha: Record<Tier, string>;
  firewall: Omit<FirewallDeps, "proxySecret">;
  limiter?: RateLimiter;
  alert?: Alert;
  log?: (event: string, data: Record<string, unknown>) => void;
  newId?: () => string;
  clock?: () => number;
  completionWaitMs?: number; // how long the row waits for response-signature checks before recording false (default 2000)
};

const TTL_S = 7200;
const SESSION_IP_PER_MIN = 10;
const KEEP_MS = 600_000; // how long a finished attempt stays in memory; after that the database answers
const ALERT_THROTTLE_MS = 600_000;
const DEGRADED_MAX = 5;
const DEGRADED_WINDOW_MS = 600_000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CONSENT = /^[A-Za-z0-9._-]{1,64}$/; // same rule as the pipeline's, checked here so a 400 never costs a rate-limit slot
const tierOf = (x: unknown): Tier | null => (x === 1 || x === 2 || x === 3 ? x : null);
// Byte lengths, not string lengths: timingSafeEqual throws on buffers of different size, and "é" is one character but two bytes.
const eq = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

type Fail = { status: ContentfulStatusCode; code: string; message: string; fix: string };
// Every error the API can return, by code. docs/ publishes the same table on /firewall#errors.
const E = {
  proxy_secret_missing: { status: 403, message: "The proxy secret is missing or wrong.", fix: "Call this route through the web proxy, which adds x-bulkhead-proxy-secret." },
  bad_client_ip: { status: 400, message: "The proxy did not send a valid x-real-ip.", fix: "The web proxy must set x-real-ip to the client address." },
  bad_request: { status: 400, message: "The body is not the expected JSON.", fix: "Send the documented fields as a JSON object." },
  body_too_large: { status: 413, message: "The body is over 16 KiB.", fix: "Send a smaller body." },
  bad_tier: { status: 400, message: "tier must be 1, 2 or 3.", fix: "Send tier as the number 1, 2 or 3." },
  message_too_long: { status: 400, message: `The message is over ${MAX_MESSAGE} characters.`, fix: `Send at most ${MAX_MESSAGE} characters.` },
  consent_required: { status: 400, message: "A consent version is required.", fix: "Accept the terms in the UI and send consent_version." },
  bad_payout_address: { status: 400, message: "The payout address is not valid for this tier's chain and network.", fix: "Use a bech32 bc1... address (tb1... on testnet) for tiers 1 and 3, a 0x... address for tier 2." },
  session_invalid: { status: 401, message: "The session is missing, expired or not ours.", fix: "Log in again with POST /session." },
  bad_sig: { status: 401, message: "The login signature does not verify.", fix: "Sign the login message again with your wallet." },
  expired: { status: 401, message: "The login nonce is too old or too far ahead.", fix: "Fetch a fresh nonce and sign again." },
  replay: { status: 401, message: "This login was already used.", fix: "Sign again with a fresh nonce." },
  key_not_on_account: { status: 401, message: "That key is not a full-access key on the account.", fix: "Sign with a full-access key of the account, not a limited app key." },
  bad_recipient: { status: 401, message: "The login was signed for another recipient.", fix: "Sign for the recipient the site asks for." },
  rate_limited: { status: 429, message: "Too many requests.", fix: "Wait for Retry-After, then retry." },
  tier_closed: { status: 409, message: "This tier is closed right now.", fix: "Pick another tier or retry later." },
  tier_cooling: { status: 409, message: "This tier is cooling down after a payout.", fix: "Retry after retry_after_s." },
  won_race_lost: { status: 409, message: "The agent agreed, but another attempt took the payout first.", fix: "Retry when the tier reopens." },
  db_unavailable: { status: 503, message: "The database is unreachable.", fix: "Retry in a moment." },
  rpc_unavailable: { status: 503, message: "The NEAR RPC is unreachable, so the key could not be checked.", fix: "Retry in a moment; your key is not at fault." },
  chain_unavailable: { status: 503, message: "The vault state cannot be read right now.", fix: "Retry in a moment." },
  attestation_unavailable: { status: 503, message: "The model's attestation could not be verified, so no attempt ran.", fix: "Retry in a moment. The attempt did not count." },
  llm_unavailable: { status: 503, message: "The model did not answer in time.", fix: "Retry in a moment. The attempt did not count." },
  firewall_degraded: { status: 503, message: "The firewall judge was unavailable, so the attempt was stopped.", fix: "Retry in a moment. The attempt did not count." },
  budget_exhausted: { status: 503, message: "The arena's daily firewall budget is used up.", fix: "It resets at 00:00 UTC." },
  budget_unavailable: { status: 503, message: "The daily budget cannot be checked right now.", fix: "Retry in a moment." },
  spend_cap: { status: 503, message: "The daily model spend limit is reached.", fix: "It resets at 00:00 UTC." },
  attempt_not_found: { status: 404, message: "No such attempt.", fix: "Check the attempt_id." },
  not_found: { status: 404, message: "No such route.", fix: "See the API docs." },
  internal: { status: 500, message: "Something went wrong on our side.", fix: "Retry; if it repeats, report the attempt id." },
} as const satisfies Record<string, Omit<Fail, "code">>;
type Code = keyof typeof E;
// pipeline error class -> code. 503s and 409s leave no row, so their rate-limit hit is refunded.
const CLASS: [new (...a: any[]) => Error, Code][] = [
  [MessageTooLongError, "message_too_long"], [BadPayoutAddressError, "bad_payout_address"], [ConsentRequiredError, "consent_required"],
  [AttestationUnavailableError, "attestation_unavailable"], [FirewallDegradedError, "firewall_degraded"], [LlmUnavailableError, "llm_unavailable"],
  [BudgetExhaustedError, "budget_exhausted"], [BudgetUnavailableError, "budget_unavailable"], [SpendCapError, "spend_cap"],
];

type Entry = { stage: Stage; result?: unknown; at: number };

// Alerts carry codes and classes, never raw error text: a viem or fetch error can embed an RPC URL with its API key.
export const errCode = (e: unknown): string => {
  const c = (e as { code?: unknown })?.code;
  if (typeof c === "string" && /^[A-Za-z0-9_:.-]{1,64}$/.test(c)) return c;
  return /ERR_[A-Z_]+/.exec(String((e as Error)?.message ?? e))?.[0] ?? (e as Error)?.name ?? "unknown";
};
// A string under `error` or `message` in alert details is replaced by its code, whoever built the details (the rebroadcast loop too).
const scrub = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, (k === "error" || k === "message") && typeof v === "string" ? errCode(v) : v]));

export function makeAlert(o: { fetch: typeof fetch; url?: string; clock?: () => number }): Alert {
  // Never throws and never waits for the webhook: a broken receiver must not slow or fail an attempt.
  return (kind, details) => {
    if (!o.url) return;
    details = scrub(details);
    Promise.resolve()
      .then(() => o.fetch(o.url!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, details, ts: isoMs((o.clock ?? Date.now)()) }), signal: AbortSignal.timeout(5000) }))
      .catch(() => {});
  };
}

export function makeServer(d: ServerDeps) {
  const app = new Hono();
  const now = () => (d.clock ?? Date.now)();
  const limiter = d.limiter ?? new RateLimiter();
  const sessionWindow = new SlidingWindow();
  const locks = new Set<number>();
  const lockedBy = new Map<number, string>();
  const attempts = new Map<string, Entry>(); // ponytail: in-memory, swept by age; the database answers for anything older or after a restart
  const log = d.log ?? (() => {});
  const alert: Alert = (k, x) => {
    try {
      void Promise.resolve(d.alert?.(k, x)).catch(() => {});
    } catch {}
  };
  const url = (code: string) => `${d.cfg.siteUrl}/firewall#errors-${code}`;

  const body = (code: Code, extra: Record<string, unknown> = {}, message?: string) => ({
    error: { code, message: message ?? E[code].message, fix: E[code].fix, docs_url: url(code), ...extra },
  });
  const fail = (c: Context, code: Code, extra: Record<string, unknown> = {}, headers?: Record<string, string>, message?: string) =>
    c.json(body(code, extra, message), E[code].status, headers);

  // Every non-2xx JSON body carries docs_url, including the ones /v1/check builds itself.
  app.use(async (c, next) => {
    await next();
    if (c.res.status < 400 || !c.res.headers.get("content-type")?.includes("json")) return;
    const j: any = await c.res.clone().json().catch(() => null);
    if (!isObj(j) || !isObj(j.error) || j.error.docs_url !== undefined) return;
    j.error.docs_url = url(String(j.error.code));
    const h = new Headers(c.res.headers);
    h.delete("content-length");
    c.res = new Response(JSON.stringify(j), { status: c.res.status, headers: h });
  });
  app.notFound(c => fail(c, "not_found"));
  app.onError((e, c) => {
    log("unhandled", { path: c.req.path, error: String((e as Error)?.message ?? e) });
    return fail(c, "internal");
  });
  const limit = bodyLimit({ maxSize: 16 * 1024, onError: c => fail(c, "body_too_large") });
  app.use("/attempt", limit);
  app.use("/session", limit);

  // The proxy secret proves the request came through our web proxy, and only then is x-real-ip believed.
  const viaProxy = (c: Context) => {
    const given = c.req.header("x-bulkhead-proxy-secret");
    return !!given && eq(given, d.cfg.proxySecret);
  };
  const clientIp = (c: Context): string | null => {
    const ip = c.req.header("x-real-ip");
    return ip && isIP(ip) ? ipKey(ip) : null; // /64 for IPv6, the address for IPv4
  };
  const json = async (c: Context): Promise<Record<string, unknown> | null> => {
    try {
      const j = await c.req.json();
      return isObj(j) ? j : null;
    } catch {
      return null;
    }
  };

  const sign = (account: string, exp: number) => createHmac("sha256", d.cfg.sessionSecret).update(`${account}|${exp}`).digest("hex");
  // account|exp|hmac. Accounts cannot contain "|" (login accepts [a-z0-9._-] only).
  const accountOf = (session: unknown): string | null => {
    if (typeof session !== "string") return null;
    const [account, exp, mac, ...rest] = session.split("|");
    if (!account || !exp || !mac || rest.length || !/^[1-9]\d{0,10}$/.test(exp)) return null;
    if (!eq(mac, sign(account, Number(exp)))) return null;
    return Number(exp) * 1000 > now() ? account : null;
  };

  app.post("/session", async c => {
    if (!viaProxy(c)) return fail(c, "proxy_secret_missing");
    const ip = clientIp(c);
    if (!ip) return fail(c, "bad_client_ip");
    // E22: before any signature work or RPC call, since a replayed valid message still costs one lookup
    const wait = sessionWindow.hit(`s:${ip}`, SESSION_IP_PER_MIN, now());
    if (wait) return fail(c, "rate_limited", { rule: "ip", retry_after_s: wait }, { "retry-after": String(wait) });
    const b = await json(c);
    if (!b || !isObj(b.nep413)) return fail(c, "bad_request");
    let r;
    try {
      r = await verifyNep413(b.nep413 as never, now(), d.chain.viewAccessKey);
    } catch {
      return fail(c, "rpc_unavailable"); // never key_not_on_account for an RPC failure
    }
    if (!r.ok) return fail(c, r.reason);
    const exp = Math.floor(now() / 1000) + TTL_S;
    const account = (b.nep413 as { accountId: string }).accountId;
    return c.json({ session: `${account}|${exp}|${sign(account, exp)}`, expires_at: isoMs(exp * 1000) });
  });

  const sweep = () => {
    const t = now();
    for (const [id, e] of attempts) if (e.result !== undefined && t - e.at > KEEP_MS) attempts.delete(id);
  };

  const degraded: number[] = [];
  let lastDegradedAlert = 0;
  const noteDegraded = () => {
    const t = now();
    degraded.push(t);
    while (degraded.length && degraded[0]! < t - DEGRADED_WINDOW_MS) degraded.shift();
    if (degraded.length > DEGRADED_MAX && t - lastDegradedAlert > DEGRADED_WINDOW_MS) {
      lastDegradedAlert = t;
      alert("judge_degraded", { count: degraded.length, window_s: DEGRADED_WINDOW_MS / 1000 });
    }
  };
  let lastAttestAlert = 0;
  const lastRelease = new Map<string, number>();

  // AttemptResult in the wire's snake_case. The firewall objects never carry `reason` (the pipeline strips it).
  const wire = (r: AttemptResult) => ({
    id: r.id, outcome: r.outcome, reply: r.reply,
    ...(r.firewall && { firewall: r.firewall }),
    ...(r.txs && { txs: { near_tx: r.txs.nearTx, ...(r.txs.chainTxid !== undefined && { chain_txid: r.txs.chainTxid }) } }),
  });

  async function run(id: string, key: { account: string; ip: string; tier: Tier }, inp: Parameters<typeof runAttempt>[1]) {
    const refund = () => limiter.refund(key, now());
    const e = attempts.get(id)!;
    let releaseError: unknown;
    try {
      const r = await withCompletions(() => runAttempt(
        {
          chat: d.chat,
          firewall: async req => {
            const f = await d.arenaFirewall(req);
            if (f?.degraded) noteDegraded();
            return f;
          },
          release: async (t, a, rcpt) => {
            try {
              return await d.chain.release(t, a, rcpt);
            } catch (err) {
              releaseError = err;
              throw err;
            }
          },
          attest: async t => {
            try {
              return await d.attest(t);
            } catch (err) {
              if (now() - lastAttestAlert > 60_000) {
                lastAttestAlert = now();
                alert("attestation_failure", { tier: t, code: errCode(err) });
              }
              throw err;
            }
          },
          // E17: every model call of this attempt is already being checked (completions.ts); the row records the outcome of those
          // checks, false for any that is not done or did not verify
          insertAttempt: async row => d.db.insertAttempt({ ...row, response_verified: await responseVerified(d.completionWaitMs) }),
          updateAttempt: d.db.updateAttempt,
          tierOpen: d.chain.tierOpen,
          wasSigned: d.chain.wasSigned,
          promptSha: d.promptSha,
          codehash: d.cfg.codehash,
          btcHrp: d.cfg.btcHrp,
          locks,
          lockedBy,
          stage: async (aid, s) => {
            if (s !== "done") e.stage = s; // "done" is set with the result, so a poll never sees done without one
            await d.db.setStage(aid, s);
          },
          warn: (what, aid, err) => log(`pipeline_${what}`, { id: aid, error: String((err as Error)?.message ?? err) }),
          newId: () => id,
          clock: d.clock,
        },
        inp,
      ));
      const info = { attempt_id: id, tier: key.tier, near_tx: r.txs?.nearTx, chain_txid: r.txs?.chainTxid };
      if (r.outcome === "drained" || r.outcome === "signed_pending_broadcast") alert(r.outcome, info);
      if (r.outcome === "release_failed") {
        refund(); // no money moved: the player may try again
        // one alert per error code per 10 minutes: a broken gas wallet would otherwise page on every attempt
        const code = errCode(releaseError);
        if (now() - (lastRelease.get(code) ?? -Infinity) >= ALERT_THROTTLE_MS) {
          lastRelease.set(code, now());
          alert("release_failed", { attempt_id: id, tier: key.tier, code, error_class: (releaseError as Error)?.name ?? "unknown" });
        }
      }
      e.result = wire(r);
    } catch (err) {
      const hit = CLASS.find(([k]) => err instanceof k);
      if (err instanceof TierClosedError && err.payload) {
        refund();
        e.result = body("won_race_lost", { reply: err.payload.reply });
      } else if (err instanceof TierClosedError) {
        refund();
        e.result = body("tier_closed");
      } else if (err instanceof TierCoolingError) {
        refund();
        e.result = body("tier_cooling", { retry_after_s: err.retryAfterS });
      } else if (hit) {
        if (E[hit[1]].status >= 500) refund();
        e.result = body(hit[1]);
      } else {
        log("attempt_failed", { id, error: String((err as Error)?.message ?? err) });
        e.result = body("internal", {}, `${E.internal.message} Attempt id: ${id}.`);
      }
    }
    e.stage = "done";
    e.at = now();
  }

  app.post("/attempt", async c => {
    if (!viaProxy(c)) return fail(c, "proxy_secret_missing");
    const ip = clientIp(c);
    if (!ip) return fail(c, "bad_client_ip");
    const b = await json(c);
    if (!b) return fail(c, "bad_request");
    const { session, tier: rawTier, message, payout_address: payout, consent_version: consent } = b;
    if (typeof session !== "string" || typeof message !== "string" || typeof payout !== "string" || typeof consent !== "string") return fail(c, "bad_request");
    const account = accountOf(session);
    if (!account) return fail(c, "session_invalid");
    const tier = tierOf(rawTier);
    if (!tier) return fail(c, "bad_tier");
    if (message.length > MAX_MESSAGE) return fail(c, "message_too_long");
    if (!CONSENT.test(consent)) return fail(c, "consent_required");
    if (!parsePayee(CHAIN[tier], payout, d.cfg.btcHrp)) return fail(c, "bad_payout_address");
    if (!d.cfg.tierEnabled[tier]) return fail(c, "tier_closed");

    // E22: only with the account of a verified session, so nobody can burn a victim's slot
    const key = { account, ip, tier };
    const rate = limiter.check(key, now());
    if (!rate.ok) return fail(c, "rate_limited", { rule: rate.rule, retry_after_s: rate.retryAfterS }, { "retry-after": String(rate.retryAfterS) });
    const refused = (code: Code, extra?: Record<string, unknown>, headers?: Record<string, string>) => (limiter.refund(key, now()), fail(c, code, extra, headers));

    try {
      await d.db.ping();
    } catch {
      return refused("db_unavailable");
    }
    let st: TierState;
    try {
      st = await d.chain.tierOpen(tier);
    } catch {
      return refused("chain_unavailable");
    }
    if (locks.has(tier) || st?.status !== "open") return refused("tier_closed");
    if (typeof st.retryAfterS !== "number" || !(st.retryAfterS >= 0)) return refused("tier_closed");
    if (st.retryAfterS > 0) return refused("tier_cooling", { retry_after_s: Math.ceil(st.retryAfterS) }, { "retry-after": String(Math.ceil(st.retryAfterS)) });

    sweep();
    const id = (d.newId ?? ulid)();
    attempts.set(id, { stage: "reading", at: now() });
    // The pipeline runs on; its failures are answered through GET /attempt/:id, and run() never throws.
    void run(id, key, { tier, account, ip, message, payoutAddress: payout, consentVersion: consent });
    return c.json({ attempt_id: id }, 202);
  });

  // The public row, as the database holds it, in the same shape a live attempt returns.
  const fromRow = (r: Record<string, any>) => {
    const strip = (f: any) => (isObj(f) ? Object.fromEntries(Object.entries(f).filter(([k]) => k !== "reason")) : undefined);
    const tx = r.near_tx || r.chain_txid ? { txs: { ...(r.near_tx && { near_tx: r.near_tx }), ...(r.chain_txid && { chain_txid: r.chain_txid }) } } : {};
    const fw = r.tier === 3 ? { firewall: { ...(strip(r.fw_a) && { a: strip(r.fw_a) }), ...(strip(r.fw_b) && { b: strip(r.fw_b) }) } } : {};
    return { stage: r.stage as Stage, ...(r.stage === "done" && { result: { id: r.id, outcome: r.outcome, reply: r.reply, ...fw, ...tx } }) };
  };

  app.get("/attempt/:id", async c => {
    if (!viaProxy(c)) return fail(c, "proxy_secret_missing");
    const id = c.req.param("id");
    if (!ULID.test(id)) return fail(c, "attempt_not_found");
    const e = attempts.get(id);
    if (e) return c.json({ stage: e.stage, ...(e.result !== undefined && { result: e.result }) });
    let row;
    try {
      row = await d.db.getAttempt(id);
    } catch {
      return fail(c, "db_unavailable");
    }
    return row ? c.json(fromRow(row)) : fail(c, "attempt_not_found");
  });

  firewallRoutes(app as never, { ...d.firewall, proxySecret: d.cfg.proxySecret });

  app.get("/attestation", c => {
    if (!viaProxy(c)) return fail(c, "proxy_secret_missing");
    return c.json({
      codehash: d.cfg.codehash,
      checksum: d.cfg.configSha,
      prompt_sha256: d.promptSha,
      models: d.cfg.models,
      judge_model: d.cfg.judgeModel,
      firewall_version: d.cfg.firewallVersion,
      mock: d.cfg.mock,
      // what the model attestation check covers, so nobody reads more into "attested" than the code does
      verification: d.cfg.mock
        ? { verified: [], not_verified: ["mock mode: no attestation performed"] }
        : {
            verified: ["gateway_and_model_nonce", "signing_address_present_on_every_model_entry", "quote_report_data_binds_address_and_nonce", "nvidia_nras_verdict", "response_signature_checked_and_recorded_per_attempt"],
            not_verified: NOT_VERIFIED,
          },
    });
  });
  app.get("/health", c => c.json({ ok: true, mock: d.cfg.mock }));

  // The rebroadcast loop calls this when it settles a tier, so the process-local lock the pipeline kept (a paid tier) is freed.
  // The rebroadcast loop settles an attempt: its lock is freed only while that attempt still holds it, never one a live attempt took since.
  const onSettled = (tier: Tier, attemptId: string) => {
    if (lockedBy.get(tier) !== attemptId) return;
    lockedBy.delete(tier);
    locks.delete(tier);
  };
  // At startup: a payout still in flight from before the restart keeps its tier shut.
  const adopt = (tier: Tier, attemptId: string) => {
    locks.add(tier);
    lockedBy.set(tier, attemptId);
  };
  return { app, locks, lockedBy, onSettled, adopt };
}
