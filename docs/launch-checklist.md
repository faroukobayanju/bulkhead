# Launch checklist

Every box below needs a person to tick it. Steps marked **both** need explicit agreement from both team members before anyone starts them: nothing goes to mainnet, gets funded, or becomes public on one person's say-so (HACKATHON.md). An agent may prepare commands and drafts, never run a **both** step.

## 0. Decide: mainnet or testnet

- [ ] **Both:** mainnet launch, or testnet only? Testnet entries are eligible (HACKATHON.md Q-010). Mainnet costs real money: about 9 NEAR for the vault's storage, gas for the agent, the prize pots, and about $5 of ETH for gas at the Base tier address. A working testnet demo beats a broken mainnet one.
- [ ] Whatever we pick, the README says which network every link points to.

## 1. Testnet run (Task 13 step 1)

On a testnet vault deployed with `bun scripts/deploy-vault.ts ... --tee`, with the real agent running in its Phala CVM:

- [ ] The agent registered from its TEE: `get_agent <agent>` shows it, valid.
- [ ] `bun scripts/check-agent-key.ts <agent> --vault <vault>` exits 0.
- [ ] A tier 1 drain produces a Bitcoin testnet4 txid that confirms.
- [ ] Tier 2 refuses.
- [ ] Tier 3 blocks a known attack at checkpoint A.
- [ ] A payout over the cap fails with `ERR_OVER_CAP`, and a second payout inside the cooldown fails with `ERR_COOLDOWN`. Record the NEAR tx links: they open the demo.
- [ ] `/verify` is green.
- [ ] `bun run scripts/verify-roots.ts <date>` exits 0.
- [ ] The `ALERT_WEBHOOK_URL` alert fires on a testnet drain.

If this is not green by the go/no-go, launch Bitcoin tiers 1 and 3 only and leave Base (tier 2) off.

## 2. Mainnet build and deploy (both)

- [ ] **Both:** agree to deploy.
- [ ] Build with `cargo near build reproducible-wasm` in `contracts/vault`, with no features: no `stub-attestation`, no `testnet-short-timelock`. Record the wasm's sha256.
- [ ] Deploy to `vault.<team>.near` and initialise with `mainnet: true`.
- [ ] `bun scripts/check-mainnet-wasm.ts <wasm> --vault vault.<team>.near` exits 0: no stub, 24 h timelock, mainnet flag set, on-chain code hash equals the local build.
- [ ] Configure tiers 1 to 3 (and the private tier 0 canary) with `configure_tier`. Check each with `get_tier`.

## 3. Agent approval (24 h before launch)

- [ ] Deploy the agent image to Phala on mainnet. Its first `register_agent` fails; read its measurements and PPID from that call (see "With a TEE agent" in `docs/deploy-your-vault.md`).
- [ ] `propose_measurements` and `propose_ppids` at least 24 h before launch. Both show in `pending_owner_actions` and on `/verify`.
- [ ] After 24 h: `approve_measurements`, `approve_ppids`. The agent registers on its next attempt.
- [ ] `bun scripts/check-agent-key.ts <agent> --vault vault.<team>.near --rpc https://free.rpc.fastnear.com` exits 0.

## 4. Canary (both)

- [ ] **Both:** fund tier 0 with about $5. The agent never funds addresses; a person does.
- [ ] Drain tier 0 once through the real agent, broadcast, confirm.
- [ ] Empty and close tier 0.

## 5. Lock (both)

- [ ] **Both:** agree to lock.
- [ ] Publish a `/rules` page: who may enter, no entries from sanctioned jurisdictions, one message per attempt, the CC-BY dataset notice, and our right to withhold a payout to a sanctioned address.
- [ ] Call `launch_lock`. Tier settings can no longer change.
- [ ] Delete every access key on the vault account (`near account delete-keys`). After this nobody, including us, can change the contract code.
- [ ] `bun scripts/check-mainnet-wasm.ts <wasm> --vault vault.<team>.near --expect-locked` exits 0: locked, 0 access keys.
- [ ] `/verify` shows "vault account has 0 access keys" and the code hash with the build command.

## 6. Fund (both)

- [ ] **Both:** fund the tiers. Tier 1 about $150 in BTC, tier 2 about $200 in USDC on Base, tier 3 about $250 in BTC. Send each Bitcoin tier coins of at most its cap: a payout spends exactly one coin.
- [ ] Record every funding txid in the README.

## 7. Go public (both)

- [ ] **Both:** make the repository public. It must be public by 2026-11-14 23:59 UTC.
- [ ] **Both:** publish the announcement. The agent drafts; the people post.
- [ ] **Both:** submit, with the payload from HACKATHON.md, after an explicit yes from both.

## If something goes wrong

- `pause` stops all payouts at once. It cannot move funds.
- `remove_measurements` or `remove_ppids` stops a misbehaving agent at once.
- `propose_emergency_withdraw`, then `execute_emergency_withdraw` after 24 h, moves a tier's coins out. The proposal shows on `/verify` for the whole 24 h.
