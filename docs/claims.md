# Claims and evidence

Every claim Bulkhead makes, what backs it, and what is not done. If a claim is not in the first table, we do not make it.

`bun run judge` runs the offline checks below with no keys or wallet. It uses a mock model for the attack demo, so its firewall lines show the mock judge. The live numbers come from the eval runs linked here.

## Shown with evidence

| Claim | Evidence |
|---|---|
| The vault contract signed a real Bitcoin testnet4 payment through NEAR Chain Signatures. No person holds the key. | Tx `a8ecea7c06b387f86349322cf025233c3f170e69a2a31f27e274e70ae89e8b1a`, confirmed in testnet4 block 158586. Write-up in `docs/spikes.md` (S1). |
| A payment signed with a false input amount is rejected by Bitcoin, so the AI cannot move more by lying about the numbers. | `docs/spikes.md` (S1). |
| The contract checks pause, the agent, the attempt id, tier status, cooldown, recipient and the cap before it asks for a signature. A payload over the cap is never signed. | `contracts/vault/src/lib.rs` `release_funds`. 83 unit and 7 sandbox tests in `scripts/test-contracts.sh`, run by `bun run judge`. |
| The firewall API rates a request against the caller's own tools and rules. On 80 held-out cases: 37 of 40 attacks stopped, 39 of 40 legitimate requests allowed. All 3 misses were plain over-limit refunds. | `docs/eval-general.md`. |
| On our 162-attack arena set, scored as if the guard had been fooled every time, the fw-v1 firewall blocked all 162. 6 of 200 normal messages were blocked, all by judge calls that timed out or failed and were blocked to be safe. | `docs/firewall-versions.md`, `LIVE=1 bun scripts/eval.ts --fw fw-v1 --all-attacks --max-usd 0.50`. |
| On attack sets we did not write: AgentDojo banking 42 of 45 blocked (44 of 45 with a payments policy), Tensor Trust hijacking 84 of 100. | `docs/public-baselines.md`. Single exploratory runs. |
| Every firewall verdict is signed (ed25519) over the response, including a hash of the input and the time it was issued. | `docs/firewall-api.md`, `agent/src/firewall/verdict.ts` and its tests. |
| The agent checks NEAR AI Cloud attestation for its models: the gateway nonce, each model entry, the report data bound into each Intel quote, and NVIDIA's NRAS result. | `agent/src/attest.ts` and its tests. What it does not check is listed below. |
| Each day's attempts can be exported with a Merkle root per hour, and anyone can recompute the roots and compare them with the ones posted on NEAR. | `scripts/export-dataset.ts`, `scripts/verify-roots.ts`, `dataset/README.md`. A round-trip test covers insert, export and verify, and a tampered message fails it. |
| The public dataset never contains IP hashes, raw accounts or a near miss's payout address. | Allowlist in `scripts/export-dataset.ts` with tests in `agent/test/export.test.ts`; Convex public query tests in `agent/test/convex-security.test.ts`. |
| When the payout server cannot tell whether the contract signed, it treats the payout as signed and keeps the tier locked. A double payout is designed out at the cost of a stuck payout a human resolves. | `agent/src/pipeline.ts`, `agent/src/chain/rebroadcast.ts` and their tests. |
| The Bulkhead agent runs in a Phala TDX CVM and registered with the vault by its attestation: the vault checked the TDX quote against owner-approved measurements and machine IDs. Its only key is a function-call key limited to the vault's three agent methods. | Agent `4e88dbf4…39e8` on `vault5.bulkhead-haikeys.testnet`: `register_agent` tx `H3Ssa8WDcoNUHBf43jjk35GMGqvSappRXszSsksVhLvj`, key swap tx `A2ZEbJj7uvwdbk5vyaC3e6dSzj9t4LXhyfFwiaS3qtHQ`, PPID `62d54040cb9dfc08bb13006fa75ece56`. `bun scripts/check-agent-key.ts 4e88dbf4a3060da4febcf5f01e2159baa3da5f148a267d11491ac835580539e8 --vault vault5.bulkhead-haikeys.testnet` exits 0. Compose in `deploy/phala/docker-compose.yaml`. |

## Not done, or limited

| Topic | Status |
|---|---|
| Agent in a TEE | Running on testnet (above). A registration lasts 7 days and the agent renews it itself; a renewal re-sends a quote, so it does not prove the agent is fresh. A reboot makes a new agent account that needs funding again. The agent's own `/attestation` and the vault's `get_agent` are the live sources. |
| Attestation checks not done | The Intel quote signature chain and TCB status, MRCONFIGID and the RTMR3 event log, TLS certificate binding, and the NVIDIA JWT signature. Listed in `NOT_VERIFIED` in `agent/src/attest.ts`. |
| Mainnet | Nothing is on mainnet. The contract has not had an outside review. |
| Owner powers | The owner can pause the vault and, after a timelock, withdraw a tier's funds (`propose_emergency_withdraw`, then `execute_emergency_withdraw`). The timelock is 24 hours in the default build and 60 seconds in the testnet short-timelock build. So "nobody can move the funds" is not true. |
| Contract cap on testnet | Covered by unit and sandbox tests. The live testnet run of `scripts/attack-demo.ts --testnet` (over cap, within cap, repeat) is not done yet. |
| Base (USDC) tier | Built and unit tested, not run on Base testnet. |
| Wallet sign-in | Built and tested with fixtures. Not yet run with a real wallet signature. |
| Roots on-chain | The code is built. No day's roots have been posted yet. |
| Firewall scope | Single-turn only. It rates what one message could make a money-holding agent do, so it allows harmless jailbreaks such as "say Access Granted". It is weak at plain number limits, which belong in code or in the contract. |
