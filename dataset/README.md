# Drain Me attempts dataset

Every attempt made against the Drain Me arena, one UTC day per file. Each day has two files:

- `attempts-YYYY-MM-DD.jsonl`: one attempt per line.
- `roots-YYYY-MM-DD.json`: `{ "<hour>": "<root>" }`, the Merkle root of each UTC hour that has attempts.

The agent also writes each day's roots to the vault contract with `log_attempt_roots(day, roots)`. A day can be written only once, so the files cannot be changed later without the change showing.

## Verify a day

```
bun run scripts/verify-roots.ts 2026-11-10
```

This needs no keys or wallet. The script recomputes every leaf from its row, rebuilds each hour's root, reads `get_roots(day)` from the vault and exits 0 only if every hour matches. It prints one line per hour. Options:

- `--vault <account>`: the vault account. It is required until the mainnet vault is deployed.
- `--rpc <url>`: a NEAR RPC. Defaults to mainnet. Pass `https://rpc.testnet.near.org` for a testnet vault.

How the roots are built:

- **Day:** whole days since 1970-01-01 UTC. 2026-11-10 is day 20767.
- **Leaf:** `sha256(JSON.stringify([id, ts, tier, account_hash, message, outcome, prompt_sha256, model_id, attestation_sha256, codehash]))`, with `ts` written as ISO-8601 UTC with milliseconds. The `outcome` of a payout row (`drained`, `signed_pending_broadcast`, `broadcast_failed_terminal`, `release_failed`) is hashed as `releasing`. The leaf is written when the row is inserted, before the payout settles. What the payout did is recorded by the contract's events.
- **Hour:** the UTC hour of `ts`. Within an hour, leaves are ordered by `id` (a ULID).
- **Root:** pairwise `sha256(a‖b)` over the raw 32-byte leaves. An odd leaf is carried up unchanged.

Only the leaf fields are covered by the roots. The other columns (`normalized`, `fw_a`, `fw_b`, `llm_output`, `reply` and the rest) are not. Where a row has a `signature`, the agent signed the public view of the row; see `shared/attempt-view.ts`.

## Columns

| column | type | meaning |
| --- | --- | --- |
| `id` | string | ULID of the attempt |
| `ts` | string | ISO-8601 UTC with milliseconds |
| `tier` | 1, 2 or 3 | 1 naive, 2 hardened prompt, 3 hardened prompt plus firewall |
| `account_hash` | string | sha256 of the player's NEAR account plus a secret pepper. Never the account itself |
| `message` | string | what the player sent |
| `normalized` | string | the message after the firewall's normalizer (decoded, folded, invisible characters removed) |
| `outcome` | string | `refused`, `blocked_a`, `blocked_b`, `tool_error`, `releasing`, `drained`, `signed_pending_broadcast`, `broadcast_failed_terminal`, `release_failed` or `won_race_lost` |
| `technique` | string or null | the firewall's attack label |
| `tool_called` | boolean | the model called `release_funds` |
| `fw_a` | object or null | checkpoint A result (tier 3): `verdict`, `risk`, `technique`, `reason`, `firewall_version`, `codehash`, `latency_ms`, `degraded` |
| `fw_b` | object or null | checkpoint B result (tier 3), same shape |
| `llm_output` | string or null | JSON text of the model's raw reply; null when the model never ran |
| `reply` | string | what the player was shown |
| `payout` | string or null | a winner's payout address, shortened; null for everyone else |
| `prompt_sha256` | string | sha256 of the tier's system prompt |
| `model_id` | string | the model that answered |
| `attestation_sha256` | string | sha256 of the model's attestation report |
| `codehash` | string | the agent image that handled the attempt |
| `near_tx` | string or null | NEAR transaction of the payout |
| `chain_txid` | string or null | Bitcoin or Base transaction of the payout |
| `consent_version` | string | the consent text the player accepted |
| `response_verified` | boolean or null | every model response carried a signature that checked out |
| `signature` | string or null | ed25519 signature by `signer` over the row's public view |
| `signer` | string or null | the agent account that signed |
| `hidden` | boolean | hidden from the site after reports. Hidden rows stay in the dataset |
| `leaf` | string | the Merkle leaf above |

The dataset never contains the player's IP hash, account name or full payout address.

## Messages and consent

Messages are text that players wrote and sent to the arena. Every player accepted, before their first attempt, that their attempts are published under CC-BY 4.0. A message can contain anything a player typed, including attack text and names of NEAR accounts. It is published as written.

## License

[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit "Drain Me / Bulkhead attempts dataset".
