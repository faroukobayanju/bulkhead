# Team handoff

Project name: **Bulkhead**. The live arena keeps the name **Drain Me**. Docs and paths still say `drain-me` in places; both refer to this project.

Building is allowed now (HACKATHON.md Q-001: eligible work starts 2026-10-19).

| | Person A: chain side (@haikeysgit) | Person B: AI side (Farouk) |
| --- | --- | --- |
| Tasks | 0 (S1, S3), 1, 2, 3, 4, 10, 13 launch, Task 15 E1–E3, E7, E12 contract items, E14 contract part, E19 | 0 (S2), 5, 6, 7, 8, 9, 11, 12, Task 15 E4–E6, E8–E11, E14 agent and web part, E15, E16, E17 |
| Folders | `contracts/`, `scripts/` (chain scripts) | `agent/`, `shared/`, `web/`, `data/`, `convex/` |

## Start now
- **Person B, spike S2:** done. Results and model choices are in `docs/spikes.md`.
- **Person B:** Tasks 5 and 6 in progress on `b/` branches, then 7, 8, 9, then 11 and 12. Test first.
- **Database:** Convex replaces Postgres and Neon (Task 15 E20). Person B owns `convex/` and the Convex account. The contract does not touch Convex, so Person A needs no Convex account or setup. The attempt row schema in the interface freeze below is the only shared part. Ignore `DATABASE_URL`, `db/schema.sql` and Docker Postgres wherever earlier plan text mentions them.
- **Person A:** continue on branch `a/vault-contract` (see Contract status below).
- **Person A:** spikes S1 (contract-signed BTC testnet tx, plus a false-amount tx that Bitcoin must reject) and S3 (Shade template boots and registers).
- **Both:** run `npx skills add near/agent-skills` (E18).

## Contract status (branch `a/vault-contract`)
- **Done, tested, 59 unit + 5 sandbox tests pass (`scripts/test-contracts.sh`):** Tasks 1–3 with Task 15 E1, E2, E7 and E14: tiers, spending cap, cooldown, rounds, codehash auth, timelocks, roots. Tasks 1–3 passed tests but have had no reviewer.
- **Partial, unreviewed:** Task 4. `btc.rs` and `evm.rs` exist and are cross-checked against the `bitcoin` and `alloy` crates, but are **not wired into `release_funds`**.
- **Do not deploy:** `release_funds` still signs a placeholder hash (marked `ponytail:`).
- **Next:** wire the builders into `release_funds` and emergency withdraw, the `release_signed` hex event, the 290 TGas test, then spikes S1 and S3, then Task 10.
- **Check in S1:** the real `v1.signer` request shape and fee (`SignRequest`, `SIGN_DEPOSIT` are placeholders). Agents attach 300 TGas, never max gas (E14b).
- **Choices already made:** Rust pinned to 1.96 because near-sdk 5.30 needs a newer compiler. `ReleasePayload` was added in Task 3, ahead of Task 4.

## Interface freeze (end of day 2), owned jointly
- Contract call: `release_funds(tier_id, attempt_id, recipient, payload)` (Tasks 3 and 4), authorization by approved codehash (E1), and the cap fields and errors `ERR_OVER_CAP` / `ERR_COOLDOWN` (E14).
- Agent registration and attestation check (Task 10).
- Attempt row schema (`convex/schema.ts`; Task 15 E6/E7/E8/E20).
- HTTP contract between web and agent (Task 9 routes + E12 proxy routes).

After the freeze, change any of these only by PR, with both people reviewing.

## Working rules
- Branch per task: `a/task-3-release-funds`, `b/task-7-firewall`. PR into `main`; the other person reviews.
- Secrets only in `.env` (gitignored). Never commit keys.
- Nobody deploys to mainnet, funds addresses, makes the repo public, posts on X or submits without both people agreeing (HACKATHON.md).
- The repo must be public by 2026-11-14 23:59 UTC.
