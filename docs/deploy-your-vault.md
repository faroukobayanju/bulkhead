# Deploy your own vault (testnet)

One command deploys the Bulkhead vault contract on NEAR testnet with your own spending cap, cooldown and number of rounds, and prints the Bitcoin testnet4 address the vault controls.

The vault only signs a Bitcoin payout when an approved agent calls `release_funds`, and never more than your cap per round. The contract enforces this whatever the agent or its model says.

## Before you start

You need a Linux or macOS shell (on Windows, use WSL) with:

- Rust from https://rustup.rs. The repo pins the version in `rust-toolchain.toml`.
- `cargo install --locked cargo-near`
- clang (`sudo apt install clang` on Ubuntu). The TEE attestation check uses `ring`, which needs clang to build for wasm.
- `cargo install --locked near-cli-rs`
- Bun from https://bun.sh, then run `bun install` in the repo root.

You also need a NEAR testnet account with at least 10 NEAR. A new faucet account has exactly that:

```bash
near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

The key is saved in `~/.near-credentials`. It never goes into the repo.

## Deploy

```bash
bun scripts/deploy-vault.ts --owner <you>.testnet --max-sats 100000 --cooldown 3600 --rounds 5
```

| Flag | Meaning |
|---|---|
| `--owner` | Your testnet account. It pays 9 NEAR to create the vault and owns it. Most of it is storage for the ~800 KB contract. |
| `--max-sats` | Spending cap: the most one release can move, in sats. |
| `--cooldown` | Seconds between two releases, at most 30 days. |
| `--rounds` | How many releases the tier allows before it is drained, 1 to 255. |
| `--vault` | Optional. Default `vault.<you>.testnet`. It must be a new sub-account of the owner. |
| `--tier` | Optional, 0 to 3. Default 1. The derivation path is `bulkhead-tier-<tier>`. |
| `--agent` | Optional. The account allowed to call `release_funds`. Default: the owner. |

The script:
1. builds the contract;
2. creates the vault account;
3. deploys it with `v1.signer-prod.testnet` as the signer;
4. asks the signer for the tier key and turns it into a P2WPKH address;
5. configures the tier and registers your agent.

It stops at the first error.

## After the deploy

1. Send testnet4 coins to the printed address, one coin of at most `--max-sats` per round. A faucet such as https://coinfaucet.eu/en/btc-testnet4/ works.
2. Have your agent call `release_funds` with 300 TGas, never max gas. `scripts/spike-s1/release.sh` shows the whole path: call, assemble the signed transaction, broadcast.

## With a TEE agent (`--tee`)

`--tee` builds the vault without `register_agent_stub` and with a 60 s timelock (testnet only; mainnet keeps 24 h). The agent then registers itself:

1. Boot the agent in a Phala CVM and send its implicit account 0.6 NEAR. Registering needs about 0.31 NEAR free.
2. Its first `register_agent` call fails, because nothing is approved yet. The call's arguments hold its attestation: read the measurements (`mrtd`, `rtmr0`–`rtmr2`, the `key-provider` event digest, `compose_hash`) and the PPID from it, as in spike S3 (`docs/spikes.md`).
3. As owner, call `propose_measurements` and `propose_ppids`, wait 60 s, then `approve_measurements` and `approve_ppids`. The agent's next attempt registers.
4. Check with `get_agent` and `bun scripts/check-agent-key.ts <agent> --vault <vault>`.

## Limits

- **Testnet only.** The script refuses `.near` accounts.
- **Stub agent registration.** Without `--tee`, the build includes the dev-only `register_agent_stub`, so the owner can register any agent. Real agents call `register_agent` from inside their TEE with a Phala attestation, which the vault checks against owner-approved measurements and PPIDs. Mainnet builds never include the stub.
- **A registration lasts 7 days.** The agent renews it with `register_agent`. A renewal re-sends the same quote, so the 7 days bound how long an approval holds; they do not prove the quote is fresh. A stub registration also lasts 7 days and cannot renew itself: re-run `register_agent_stub` before it runs out.
- **The agent's gas allowance cannot be topped up.** Once the agent has deleted its full-access key, nobody can add allowance to its function-call key. If the allowance runs out, start a new agent: new implicit account, new registration.
- **Every reboot is a new agent.** A TEE agent derives a fresh implicit account at each boot, which needs funding and registration again. Its measurements and PPID stay approved, so it registers on its first try.
- **Bitcoin tiers only.** Base (USDC) tiers need `evm` settings in `configure_tier` and are not covered by this script yet.
