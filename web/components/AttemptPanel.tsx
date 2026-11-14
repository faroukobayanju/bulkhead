"use client";
// The tier page's working part: sign in, write one message, give a payout address, send, watch the stages, read the outcome.
import { ArrowRight, CaretRight, Check, Circle, SignOut } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { parsePayee } from "../../agent/src/address";
import { MAX_MESSAGE, STAGES } from "../../shared/attempt";
import { CHAIN_OF, type Network, type TierId } from "@/lib/links";
import { CONSENT_VERSION, LoginError, consented, forgetSession, mockSignIn, prepareWallets, saveConsent, savedSession, signIn, type Session, type WalletId, type Wallets } from "@/lib/near";
import { loginCopy, pendingScreen, screenFor, type Screen } from "@/lib/outcome";
import { Countdown } from "./Countdown";
import { LiveStage, convexLive } from "./Live";
import { UntrustedText } from "./UntrustedText";

const STAGE_COPY: Record<string, string> = {
  reading: "Gorvath is reading…",
  firewall_a: "Firewall check…",
  thinking: "Gorvath is thinking…",
  firewall_b: "Firewall check on the payout…",
  signing: "Agent agreed, requesting signature…",
  broadcasting: "Broadcasting the payout…",
};
const POLL_MS = 1000;
const GIVE_UP_MS = 90_000;
const ANNOUNCE_AT = 1900;

type Phase = { kind: "idle" } | { kind: "sending" } | { kind: "running"; id: string; stage: string; since: number } | { kind: "done"; screen: Screen; at: number };

export function AttemptPanel({ tier, network, mock, open, closedReason }: { tier: TierId; network: Network; mock: boolean; open: boolean; closedReason?: string }) {
  const chain = CHAIN_OF[tier];
  const hrp = network === "mainnet" ? "bc" : "tb";
  const [session, setSession] = useState<Session | null>(null);
  const [agree, setAgree] = useState(false);
  const [hadConsent, setHadConsent] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [message, setMessage] = useState("");
  const [payout, setPayout] = useState("");
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const draftKey = `bulkhead.draft.${tier}`;
  const payoutKey = `bulkhead.payout.${chain}.${network}`;

  // Restore the session, consent and draft (a wallet popup or redirect must not lose what the player wrote).
  useEffect(() => {
    setSession(savedSession());
    const c = consented();
    setAgree(c);
    setHadConsent(c);
    setMessage(localStorage.getItem(draftKey) ?? "");
    setPayout(localStorage.getItem(payoutKey) ?? "");
  }, [draftKey, payoutKey]);
  // The wallet selector is set up now, not at click time, so the signing click can open the wallet's popup (lib/near.ts).
  const [wallets, setWallets] = useState<Wallets | null>(null);
  useEffect(() => {
    if (mock) return;
    let live = true;
    prepareWallets(network)
      .then(w => live && setWallets(w))
      .catch(() => live && setWallets({}));
    return () => {
      live = false;
    };
  }, [mock, network]);
  useEffect(() => localStorage.setItem(draftKey, message), [draftKey, message]);
  useEffect(() => localStorage.setItem(payoutKey, payout), [payoutKey, payout]);

  const len = message.length;
  const over = len > MAX_MESSAGE;
  const payee = payout ? parsePayee(chain, payout.trim(), hrp) : null;
  const payoutBad = touched && payout !== "" && !payee;
  const busy = phase.kind === "sending" || phase.kind === "running";
  const canSend = open && !!session && agree && len > 0 && !over && !!payee && !busy;

  async function doSignIn(w: WalletId | "mock") {
    setLoginErr(null);
    if (!agree) return setLoginErr("Tick the box to accept the rules first.");
    setSigning(true);
    try {
      saveConsent();
      setSession(w === "mock" ? await mockSignIn() : await signIn(w, wallets));
    } catch (e) {
      setLoginErr(loginCopy(e instanceof LoginError ? e.code : "unknown", network));
    } finally {
      setSigning(false);
    }
  }

  const finish = useCallback(
    (screen: Screen, status?: number) => {
      if (status === 401) {
        forgetSession();
        setSession(null);
      }
      setPhase({ kind: "done", screen, at: Date.now() });
    },
    [],
  );

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!canSend || !session) return;
    setPhase({ kind: "sending" });
    let r: Response;
    try {
      r = await fetch("/api/attempt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: session.session, tier, message, payout_address: payee!.address, consent_version: CONSENT_VERSION }),
      });
    } catch {
      return finish(screenFor({ status: 0, body: null }, { tier, network }));
    }
    const body = await r.json().catch(() => null);
    if (r.status !== 202 || typeof body?.attempt_id !== "string") return finish(screenFor({ status: r.status, body }, { tier, network }), r.status);
    setPhase({ kind: "running", id: body.attempt_id, stage: "reading", since: Date.now() });
  }

  // Poll GET /attempt/:id every second until done; past 90 s, give the id instead of an error.
  const running = phase.kind === "running" ? phase : null;
  const runId = running?.id;
  const since = running?.since ?? 0;
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      if (Date.now() - since > GIVE_UP_MS) return finish(pendingScreen(runId));
      try {
        const r = await fetch(`/api/attempt/${encodeURIComponent(runId)}`, { cache: "no-store" });
        const j = await r.json().catch(() => null);
        if (stop) return;
        if (r.ok && j?.stage === "done" && j.result) {
          localStorage.removeItem(draftKey);
          return finish(screenFor({ status: 200, body: j.result }, { tier, network }));
        }
        if (r.ok && typeof j?.stage === "string") setPhase(p => (p.kind === "running" && p.id === runId ? { ...p, stage: later(p.stage, j.stage) } : p));
        else if (r.status === 404 || r.status === 401) return finish(screenFor({ status: r.status, body: j }, { tier, network }), r.status);
      } catch {
        // a dropped poll is retried; the 90 s limit still applies
      }
      t = setTimeout(tick, POLL_MS);
    };
    t = setTimeout(tick, POLL_MS / 2);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [runId, since, tier, network, draftKey, finish]);

  const onLiveStage = useCallback((s: string) => setPhase(p => (p.kind === "running" && s !== "done" ? { ...p, stage: later(p.stage, s) } : p)), []);

  const stages = STAGES.filter(s => s !== "done" && (tier === 3 || !s.startsWith("firewall")));

  return (
    <div className="panel stack">
      {!session ? (
        <section aria-labelledby="signin-h" className="stack">
          <h2 id="signin-h">Sign in to attack tier {tier}</h2>
          <p className="muted small">One signature with your NEAR wallet starts a 2 hour session. Entry is free.</p>
          <label className="check">
            <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} />
            <span>
              I accept the <Link href="/rules">rules</Link>, and that my attempts (message, reply and outcome) are published under CC-BY 4.0. My account is stored only as a salted hash.
            </span>
          </label>
          <div className="row">
            {mock ? (
              <button type="button" className="btn" disabled={signing} onClick={() => doSignIn("mock")}>
                Sign in with a demo account
              </button>
            ) : (
              <>
                <button type="button" className="btn" disabled={signing || wallets === null} onClick={() => doSignIn("meteor-wallet")}>
                  Meteor Wallet
                </button>
                <button type="button" className="btn ghost" disabled={signing || wallets === null} onClick={() => doSignIn("my-near-wallet")}>
                  MyNearWallet
                </button>
              </>
            )}
          </div>
          {loginErr && (
            <p className="bad small" role="alert">
              {loginErr}
            </p>
          )}
        </section>
      ) : (
        <div className="row muted small">
          <span>
            Signed in as <span className="mono">{session.accountId}</span>
          </span>
          <button
            type="button"
            className="linkbtn small"
            onClick={() => {
              forgetSession();
              setSession(null);
            }}
          >
            <SignOut size={14} aria-hidden="true" /> Sign out
          </button>
        </div>
      )}

      <form onSubmit={send} className="stack" aria-label={`Attempt on tier ${tier}`}>
        <div className="field">
          <label htmlFor="msg">Your message</label>
          <textarea
            id="msg"
            value={message}
            onChange={e => setMessage(e.target.value)}
            aria-invalid={over}
            aria-describedby="msg-count msg-help"
            disabled={!open || busy}
            spellCheck={false}
          />
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span id="msg-help" className="help">
              One message, no memory between attempts.
            </span>
            <span id="msg-count" className={`counter mono${over ? " over" : ""}`}>
              {len.toLocaleString("en-US")} / {MAX_MESSAGE.toLocaleString("en-US")}
            </span>
          </div>
          <span className="visually-hidden" aria-live="polite">
            {len >= ANNOUNCE_AT ? (over ? `${len - MAX_MESSAGE} characters over the limit` : `${MAX_MESSAGE - len} characters left`) : ""}
          </span>
          {over && <span className="error">Cut the message to {MAX_MESSAGE.toLocaleString("en-US")} characters to send it.</span>}
        </div>

        <div className="field">
          <label htmlFor="payout">Payout address</label>
          <input
            id="payout"
            type="text"
            value={payout}
            onChange={e => setPayout(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={payoutBad}
            aria-describedby="payout-help"
            autoComplete="off"
            spellCheck={false}
            disabled={!open || busy}
            className="mono"
          />
          <span id="payout-help" className="help">
            {chain === "btc"
              ? `Bitcoin, bech32 addresses only (${hrp}1…), for example ${hrp === "tb" ? "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" : "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kxv8f3t4"}.`
              : "USDC on Base, a 0x… address, for example 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed."}{" "}
            You win only if the agent pays exactly this address.
          </span>
          {payoutBad && <span className="error">This is not a valid {chain === "btc" ? `${hrp}1… Bitcoin` : "Base"} address for {network}.</span>}
        </div>

        {session && hadConsent && (
          <p className="small muted">
            Your attempts are published under CC-BY 4.0. <Link href="/rules">Rules</Link>
          </p>
        )}
        <div className="row">
          <button type="submit" className="btn" disabled={!canSend}>
            Send <ArrowRight size={16} weight="bold" aria-hidden="true" />
          </button>
          {!open && <span className="muted small">{closedReason ?? "This tier is not taking attempts right now."}</span>}
          {open && !session && <span className="muted small">Sign in first.</span>}
        </div>
      </form>

      <div aria-live="polite" className="stack">
        {running && (
          <ol className="stages" aria-label="Attempt progress">
            {stages.map(s => {
              const i = STAGES.indexOf(s);
              const cur = STAGES.indexOf(running.stage as never);
              const state = i < cur ? "done" : i === cur ? "current" : "todo";
              return (
                <li key={s} data-state={state}>
                  {state === "done" ? <Check size={16} weight="bold" aria-label="done" /> : state === "current" ? <CaretRight size={16} weight="bold" aria-label="now" /> : <Circle size={10} aria-label="next" />}
                  {state === "current" ? STAGE_COPY[s] : STAGE_COPY[s]!.replace("…", "")}
                </li>
              );
            })}
          </ol>
        )}
        {phase.kind === "sending" && <p className="muted">Sending…</p>}
        {phase.kind === "done" && <Result screen={phase.screen} at={phase.at} demo={mock} />}
      </div>
      {running && convexLive && !mock && <LiveStage id={running.id} onStage={onLiveStage} />}
    </div>
  );
}

const later = (a: string, b: string) => (STAGES.indexOf(b as never) > STAGES.indexOf(a as never) ? b : a);

function Result({ screen, at, demo }: { screen: Screen; at: number; demo: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div ref={ref} tabIndex={-1} className={`result reveal ${screen.tone}`} data-testid="result">
      {demo && (
        <span className="tag" data-testid="demo-tag" title="MOCK_AGENT=1: this result is a fixture, not the arena">
          Demo
        </span>
      )}
      <h3>{screen.title}</h3>
      {screen.lines.map(l => (
        <p key={l}>{l}</p>
      ))}
      {screen.reply ? <UntrustedText text={screen.reply} label="The guard's reply" /> : null}
      {screen.countdown && (
        <p>
          <Countdown until={at + screen.countdown.seconds * 1000} template={screen.countdown.template} />
        </p>
      )}
      {screen.links?.length ? (
        <div className="row">
          {screen.links.map(l => (
            <a key={l.href} href={l.href} className="btn ghost" {...(l.href.startsWith("http") && { target: "_blank", rel: "noopener noreferrer" })}>
              {l.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
