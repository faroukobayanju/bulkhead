# Team handoff

<<<<<<< HEAD
Project name: **Bulkhead**. The live arena keeps the name **Drain Me**.
=======
Project name: **Bulkhead**. The live arena keeps the name **Drain Me**. Docs and paths still say `drain-me` in places; both refer to this project.

Building is allowed now (HACKATHON.md Q-001: eligible work starts 2026-10-19).
>>>>>>> main

| | Person A: chain side (Farouk) | Person B: AI side (@haikeysgit) |
| --- | --- | --- |
| Tasks | 0 (S1, S3), 1, 2, 3, 4, 10, 13 launch, Task 15 E1–E3, E7, E12 contract items, E14 contract part, E19 | 0 (S2), 5, 6, 7, 8, 9, 11, 12, Task 15 E4–E6, E8–E11, E14 agent and web part, E15, E16, E17 |
| Folders | `contracts/`, `scripts/` (chain scripts) | `agent/`, `shared/`, `web/`, `data/`, `db/` |

## Start now
- **Person B, spike S2:** list NEAR AI Cloud models; pick 2 with reliable tool calls (10/10); run 10 identical temperature-0 calls and record whether outputs differ; save the attestation report keys. Record everything in `docs/spikes.md`.
- **Person B:** Task 5 (normalizer, including E11), then 6, 7, 8, 9, then 11 and 12. Test first.
- **Person A:** contract work is on branch `a/vault-contract`. Tasks 1–3 are done there.
- **Person A:** spikes S1 (contract-signed BTC testnet tx, plus a false-amount tx that Bitcoin must reject) and S3 (Shade template boots and registers).
- **Both:** run `npx skills add near/agent-skills` (E18).

## Interface freeze (end of day 2), owned jointly
- Contract call: `release_funds(tier_id, attempt_id, recipient, payload)` (Tasks 3 and 4), authorization by approved codehash (E1), and the cap fields and errors `ERR_OVER_CAP` / `ERR_COOLDOWN` (E14).
- Agent registration and attestation check (Task 10).
- Attempt row schema (`db/schema.sql` + Task 15 E6/E7/E8).
- HTTP contract between web and agent (Task 9 routes + E12 proxy routes).

After the freeze, change any of these only by PR, with both people reviewing.

## Working rules
- Branch per task: `a/task-3-release-funds`, `b/task-7-firewall`. PR into `main`; the other person reviews.
- Secrets only in `.env` (gitignored). Never commit keys.
- Nobody deploys to mainnet, funds addresses, makes the repo public, posts on X or submits without both people agreeing (HACKATHON.md).
- The repo must be public by 2026-11-14 23:59 UTC.
