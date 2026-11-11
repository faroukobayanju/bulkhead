# Testnet fallback launch (E25)

**Why:** as of 2026-11-11 nothing from S3 (Shade template on Phala) or Task 10 (TEE deploy, real registration) is on `main`. Submission closes 2026-11-14 23:59 UTC. Without Task 10 the agent cannot run in a TEE, and the mainnet wasm has no way to register an agent.

**Decision point:** 2026-11-12 12:00 UTC. If Task 10 is not running on testnet by then, we launch this way. If it lands later, we switch the agent to the TEE and keep everything else.

## What changes

- **Network:** testnet only. Tiers hold Bitcoin testnet4 coins. No mainnet, no real money. Every page and post says "testnet".
- **Tiers:** 1 and 3 on Bitcoin testnet4, following the go/no-go rule. Tier 2 (Base) is off (`TIER_2_ENABLED=0` or the config equivalent) unless a Base testnet run is green by the decision point.
- **Agent registration:** the testnet vault is built with `stub-attestation`, and the owner calls `register_agent_stub(agent, "testnet-stub")`. `scripts/deploy-vault.ts` already does this.
- **Agent host:** an ordinary server, not a TEE. The agent signs with a function-call key limited to `release_funds` and `log_attempt_roots` on the vault.
- **Claims:** `/verify` and `docs/claims.md` say the agent is not in a TEE and its codehash is the stub. The NEAR AI model checks that `attest.ts` really verifies stay labeled verified. Nothing says "TEE verified".

What stays the same: the contract cap, cooldown and rounds; the firewall on tier 3; the dataset and roots; the website.

## Steps

| # | Step | Owner | By |
|---|---|---|---|
| 1 | Deploy one testnet vault with tiers 1 and 3 (`scripts/deploy-vault.ts`, plus `configure_tier` for the second tier if the script does one tier per vault). Small cap, cooldown of at least 60 s, 5 rounds. | Friend (A) | Nov 12 |
| 2 | Create the agent account and its function-call key (`release_funds`, `log_attempt_roots`), register it with `register_agent_stub`. Key goes only into the agent host's env. | Friend (A) | Nov 12 |
| 3 | Fund both tier addresses from a testnet4 faucet. | Either | Nov 12 |
| 4 | Run `scripts/attack-demo.ts --testnet` step 4: over the cap gives `ERR_OVER_CAP`, within the cap pays, a repeat gives `ERR_COOLDOWN`. Record the tx links. This is the demo's opening shot. | Both | Nov 12 |
| 5 | Convex production deployment (`bunx convex deploy`), `AGENT_SECRET` set there. | Me (B) | Nov 12 |
| 6 | Host the agent (Fly.io, Railway or Render; user picks and creates the account). Env from `.env.example`, `NEAR_NETWORK=testnet`, NEAR AI key with a spend limit set on the NEAR AI dashboard. | Me (B) | Nov 12 |
| 7 | Deploy the website on Vercel with `AGENT_URL`, `PROXY_SECRET`, `NEXT_PUBLIC_CONVEX_URL`, `VAULT_ACCOUNT`. | Me (B) | Nov 13 |
| 8 | Testnet end to end: sign in with a real wallet, one attempt per tier, one forced payout on tier 1 through the demo path, export and `verify-roots` for one day. | Both | Nov 13 |
| 9 | Invite the 20 to 30 attackers; post the launch. | User | Nov 13 |
| 10 | `docs/claims.md`, README, demo video (contract moment in the first 30 s), submission JSON shown to both before sending. | Both | Nov 14 |

Every deploy, funding, post and the submission still needs both people's explicit OK (HACKATHON.md).
