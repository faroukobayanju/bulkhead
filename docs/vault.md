# The vault contract

`contracts/vault` is a NEAR contract in Rust (near-sdk 5.30). It holds the keys to the prize money and decides, on its own, how much of it an agent may move. Nothing in the agent, its model or its firewall can change those limits.

## Where the money is

Each tier has its own Bitcoin or Base address. Nobody holds the private key for it. The address is derived through NEAR Chain Signatures (`v1.signer`) from the vault's account and a path such as `bulkhead-tier-1`, so only the vault can ask the signer to sign for it.

## How a payout happens

An approved agent calls:

```
release_funds(tier_id, attempt_id, recipient, payload)
```

The vault then, in one call:

1. Checks the caller is a registered agent whose attestation is fresh and whose measurements and machine are still approved. Anyone else gets `ERR_NOT_TIER_AGENT`.
2. Checks the vault is not paused and the tier is open (not mid-payout, and not drained: a tier with no rounds left is `Drained`) and not cooling down (`ERR_COOLDOWN`).
3. Checks the amount against the tier's cap. On Bitcoin a payout spends exactly one coin, and the coin's value must be at most `max_release` (`ERR_OVER_CAP`). On Base the USDC amount must be at most the cap.
4. Builds the whole transaction itself. Bitcoin: a P2WPKH spend to the recipient. Base: a USDC `transfer` with the chain ID and token address fixed when the tier was configured, never taken from the agent.
5. Marks the tier as paying out and asks `v1.signer` to sign the transaction hash. When the signature comes back, the tier uses up a round and its cooldown starts. If signing fails, the tier opens again and nothing is spent.

The agent only gets back a signature for a transaction the vault built. It broadcasts it; it cannot change it.

The cap holds even against a lying agent. BIP-143 signatures commit to the input amount, so if an agent claims a coin is worth less than it is, Bitcoin rejects the signed transaction. Spike S1 checked this on testnet4 (`docs/spikes.md`).

## Which agents may call it

Agents prove where they run. The agent calls `register_agent(attestation)` from inside a Phala TDX machine. The vault verifies:

- the TDX quote with Intel's collateral;
- that the quote names the caller's own NEAR account, so nobody can reuse another agent's attestation;
- that the machine's measurements (the code and settings it booted) and its PPID (which physical machine) are on the owner's approved lists.

A registration lasts 7 days, and the agent renews it. A renewal re-sends the same quote, so the 7 days bound how long an approval holds; they are not a freshness proof.

## What the owner can and cannot do

- **Approve new measurements or machines:** propose, then approve 24 h later. Proposals are public (`pending_owner_actions`).
- **Stop an agent:** `remove_measurements` or `remove_ppids`, effective at once.
- **Pause:** `pause` stops all payouts at once and moves nothing.
- **Emergency withdraw:** propose, then execute 24 h later, one coin at a time.
- **Change tiers:** only until `launch_lock`. After that, cap, cooldown and rounds are fixed.
- **Change the code:** never after launch. The contract has no upgrade method, and after `launch_lock` we delete every access key on the vault account. `bun scripts/check-mainnet-wasm.ts <wasm> --vault <account> --expect-locked` shows that the account has no keys and runs exactly the published build.

## Proof so far

- **The vault signed a real Bitcoin payment.** Bitcoin testnet4 tx [`a8ecea7c…8b1a`](https://mempool.space/testnet4/tx/a8ecea7c06b387f86349322cf025233c3f170e69a2a31f27e274e70ae89e8b1a), signed through `v1.signer-prod.testnet`. The same payout signed with a false input amount was rejected by Bitcoin (spike S1).
- **An agent registered from a real TEE.** The Shade template agent registered on testnet from a Phala TDX CVM, and the vault's unit tests verify that same real attestation (spike S3, `contracts/vault/tests/fixtures`).

## Build and test

You need Rust (pinned in `rust-toolchain.toml`), `cargo-near`, and clang (the attestation check uses `ring`, which needs clang for wasm).

```bash
scripts/test-contracts.sh
```

That builds the test wasm and runs every unit and sandbox test. To deploy your own vault on testnet, see `docs/deploy-your-vault.md`.

## Rebuild the mainnet wasm yourself

The mainnet vault is built inside a pinned Docker image (`sourcescan/cargo-near:0.21.1-rust-1.96.0`, set in `contracts/vault/Cargo.toml`), with no features: no stub, 24 h timelock. You need Docker and `cargo-near`, but not clang.

```bash
cd contracts/vault
cargo near build reproducible-wasm
```

The build records the git commit it came from inside the wasm (`git+https://github.com/faroukobayanju/bulkhead?rev=<commit>`), so each commit gives its own hash, and the same commit always gives the same bytes. To check a deployed vault, build the commit named in its wasm, then run `bun scripts/check-mainnet-wasm.ts <wasm> --vault <account>`: it compares your build's hash with the vault's on-chain `code_hash`.
