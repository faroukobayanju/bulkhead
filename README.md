<img src="assets/brand/wordmark.svg" alt="Bulkhead" width="320">

When your AI agent gets tricked, only one compartment floods. Bulkhead is a firewall and contract-enforced spending cap for agents that hold money, proven in **Drain Me**, its live arena. Built for NEAR HACKATHON (Nov 1–14, 2026).

Three AI agents guard real BTC and USDC in a NEAR vault contract. Attackers try to talk them into paying out. Every attack feeds an open dataset and a firewall API with a measured block rate.

**Status:** in development. The repository was created on 2026-10-29, inside the eligible window that HACKATHON.md Q-001 opens on 2026-10-19, so all code here is new work. There is no pre-hackathon baseline.

## Read first
1. `docs/specs/2026-10-29-drain-me-spec.md`: what we are building and why.
2. `docs/superpowers/plans/2026-10-29-drain-me.md`: the task-by-task build plan. **Task 15 (engineering amendments) overrides earlier task text where they conflict.**
3. `HANDOFF.md`: who builds what, and the day-2 interface freeze.
4. `docs/prior-art.md`, `TODOS.md`.

## Run locally (mock model, no keys)
Needs [Bun](https://bun.sh) and a free Convex account. The agent runs against canned model replies, so no NEAR AI key or wallet is involved.
```bash
bun install
bunx convex dev            # creates a dev deployment; note its CONVEX_URL and CONVEX_SITE_URL, leave it running
cp .env.example .env       # then set the lines below; make each secret with: openssl rand -hex 32
bunx convex env set AGENT_SECRET "<the same AGENT_SECRET as in .env>"
MOCK_LLM=1 bun --env-file=.env agent/src/main.ts      # agent on :8787
```
In `.env` mock mode needs only `NEAR_NETWORK=testnet`, `MOCK_LLM=1`, `CONVEX_SITE_URL`, and `AGENT_SECRET`, `PEPPER`, `SESSION_SECRET`, `PROXY_SECRET` (32+ bytes each). `curl -s localhost:8787/health` returns `{"ok":true,"mock":true}`. Every other route except `/v1/check` with an API key is reachable only through the web proxy, so send the header `x-bulkhead-proxy-secret: <PROXY_SECRET>` (and `x-real-ip`) when you call the agent by hand. Mock mode refuses to start on mainnet.
