<img src="assets/brand/wordmark.svg" alt="Bulkhead" width="320">

When your AI agent gets tricked, only one compartment floods. Bulkhead is a firewall and contract-enforced spending cap for agents that hold money, proven in **Drain Me**, its live arena. Built for NEAR HACKATHON (Nov 1–14, 2026).

Three AI agents guard real BTC and USDC in a NEAR vault contract. Attackers try to talk them into paying out. Every attack feeds an open dataset and a firewall API with a measured block rate.

**Status:** in development. The repository was created on 2026-10-29, inside the eligible window that HACKATHON.md Q-001 opens on 2026-10-19, so all code here is new work. There is no pre-hackathon baseline.

## The vault: why a tricked agent can only lose a little

The money sits in a NEAR contract, not with the agent. Each tier's Bitcoin or Base address is controlled through NEAR Chain Signatures, so no person and no agent holds its private key. The agent can only ask the vault to pay, and the vault decides:

- **One payout is capped.** On Bitcoin a payout spends exactly one coin, and that coin must be worth at most the tier's cap. The vault builds the transaction itself. If the agent lies about a coin's value, Bitcoin rejects the signed transaction (we tested this on testnet4).
- **Then the tier waits.** A cooldown starts after each payout, and each tier has a fixed number of rounds.
- **Only a verified agent can ask.** The agent registers from inside a Phala TDX machine. The vault checks the attestation against code and machines the owner approved, with a 24 h delay on every new approval.
- **Nobody can change the rules after launch,** us included. After `launch_lock` the tier settings are fixed, and we delete every key on the vault account, so the contract code can never change.

Proof so far: the vault signed Bitcoin testnet4 payout [`a8ecea7c…8b1a`](https://mempool.space/testnet4/tx/a8ecea7c06b387f86349322cf025233c3f170e69a2a31f27e274e70ae89e8b1a) with no person holding the key, and an agent registered on testnet from a real Phala TEE. Details: `docs/vault.md`.

### What the agent's key can and cannot do

The agent's NEAR account has one key: a function-call key. `bun scripts/check-agent-key.ts <agent> --vault <vault>` checks it.

- It can call only the vault, and only `release_funds`, `log_attempt_roots` and `register_agent`.
- It cannot attach NEAR or transfer anything.
- Its allowance (at most 1 NEAR) pays for gas. It does not limit money. The money limit is the vault's cap.

The other way to do this is the policy controls an agent framework offers, such as the Shade Agent API's. We put the limit in our own contract instead, on native BTC, so it holds even if everything around the agent is compromised. In front of the contract sits a firewall that screens each message and each payout request, with a block rate we measure and publish.

Left out on purpose: a recipient allowlist (in Drain Me the attacker names their own address), recipient scoring, reputation, and a general policy engine.

## Read first
1. `docs/specs/2026-10-29-drain-me-spec.md`: what we are building and why.
2. `docs/superpowers/plans/2026-10-29-drain-me.md`: the task-by-task build plan. **Task 15 (engineering amendments) overrides earlier task text where they conflict.**
3. `HANDOFF.md`: who builds what, and the day-2 interface freeze.
4. `docs/prior-art.md`, `TODOS.md`.
5. `docs/vault.md` (the contract), `docs/deploy-your-vault.md` (deploy your own on testnet), `docs/launch-checklist.md` (every launch step and who signs it off).
