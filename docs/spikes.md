# Spike results

## S1: contract-signed BTC testnet tx (run 2026-11-02)

Owner: @haikeysgit. Result: **the vault contract signed a Bitcoin testnet4 payout through `v1.signer-prod.testnet`, and Bitcoin rejected the same payout signed with a false input amount.** The Bitcoin deadline in E24 (end of 2026-11-06 UTC) is met once the payout confirms.

| Item | Value |
|---|---|
| Vault | `vault.bulkhead-haikeys.testnet` (owner `bulkhead-haikeys.testnet`), Task 4 code at commit `7b5765e`, built with `stub-attestation` |
| Wasm sha256 | `2b8be03aea1bfda53bf51d7558f6b39da4bae892db8bd8b22077cd970e9bbfde` |
| Signer | `v1.signer-prod.testnet`, domain 0 (secp256k1), 1 yoctoNEAR deposit, release called with 300 TGas |
| Tier 1 path | `bulkhead-tier-1` |
| Derived key | `secp256k1:2uQDMhqCaRrFVW4mNWv2VchYtcagNAWPyUEWMjzdJkdcf76FcUAgpkFUWzwDtER5TmXagPH2pFFQAc9op3kjudX9` (compressed `025f3478…f146`) |
| Tier 1 address | `tb1qvg2du726tmgjzcz89m6zj7dcdzdcyeja7z9zx5` (P2WPKH) |
| Funding | coinfaucet.eu, 341,067 sats, tx `b7a37d34906d713f2436c3992495118f06a59f26f6acdcb3c5d3224959048bd1:0` |
| Spike tier settings | `max_release` 2,000,000 sats, `cooldown_s` 60, 10 rounds |

### False amount: rejected

`release_funds` with `value_sat: 341000` (true value 341,067), fee rate 2 sat/vB. NEAR tx `4ikd9zgMEGSquu6EqUH1Ly1fB7Lg7wUG2KdjoVoShWW1`. The MPC signature was valid for the sighash the contract built, but testnet4 refused the transaction:

```
mempool-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation), input 0
```

BIP-143 commits to the input amount, so a signature over a false amount fails script verification. An agent that lies about `value_sat` to get under `max_release` produces a transaction Bitcoin will not accept. This is the property the spending cap relies on (E14).

### True amount: broadcast

`release_funds` with `value_sat: 341067`, fee rate 2 sat/vB, recipient `tb1qerzrlxcfu24davlur5sqmgzzgsal6wusda40er` (the faucet's return address). NEAR tx `DP1HkZNtYkFhbj6i1nooUiinQ11GS1q5N4496UvYSs4S`.

- Bitcoin txid: **`a8ecea7c06b387f86349322cf025233c3f170e69a2a31f27e274e70ae89e8b1a`**, accepted into the testnet4 mempool, https://mempool.space/testnet4/tx/a8ecea7c06b387f86349322cf025233c3f170e69a2a31f27e274e70ae89e8b1a
- Output: 340,847 sats (341,067 minus a 220 sat fee: 110 vB at 2 sat/vB).
- Confirmation: pending at the time of writing.

### What the agent needs (Task 8/9)

- **Tier address:** `derived_public_key({path, predecessor: <vault account>, domain_id: 0})` on the signer returns `secp256k1:<base58 of 64 bytes>`, the uncompressed x‖y without the `04` prefix. Compress it (`02`/`03` by y parity), then `hash160`, then a bech32 v0 address with HRP `tb` (testnet) or `bc` (mainnet).
- **Signature:** the `release_signed` event carries `signature: {big_r: {affine_point: <33 bytes hex>}, s: {scalar: <32 bytes hex>}, recovery_id}`. `r` is bytes 1..33 of `big_r`. The signed message is the 32-byte sighash from `release_requested.payload`, without further hashing. `recovery_id` is not needed for Bitcoin. `s` came back low-s.
- **Assembly:** `unsigned_tx_hex` is the legacy layout. Insert the segwit marker and flag `00 01` after the version, and add the witness `[DER(r, s) ‖ 0x01, compressed pubkey]` before the locktime.
- **Verify first:** check the signature against the tier key before broadcasting, because recovery returns some key even for a bad signature.
- **Broadcast:** `POST https://mempool.space/testnet4/api/tx` with `Content-Type: text/plain`. The default form encoding returns `TX decode failed`.

Reference code: `scripts/spike-s1/btc.py` (pure Python stdlib) and `scripts/spike-s1/release.sh`.

## S2: NEAR AI Cloud (run 2026-11-02)

Endpoint: `https://cloud-api.near.ai/v1`. The list returned 64 models. Each model below ran 10 tool-call runs, 10 identical temperature-0 judge calls with `response_format: json_object`, one guarded override call, one signature fetch, and one attestation fetch.

| Model | Tool calls valid | Tool p95 | Judge JSON valid | Distinct judge outputs | Judge p95 | Called tool on override | $/M in, out |
|---|---|---|---|---|---|---|---|
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 10/10 | 4.9 s | 10/10 | 4 | 3.3 s | no | 0.30, 1.20 |
| `Qwen/Qwen3.8-27B` | 0/10 | 5.8 s | 10/10 | 1 | 2.9 s | no | 0.04, 1.35 |
| `z-ai/glm-5.3-flash` | 10/10 | 13.8 s | 10/10 | 5 | 10.3 s | no | 0.08, 0.50 |
| `z-ai/glm-5.3` | 7/10 | 4.3 s | 6/10 | 5 | 3.0 s | no | 1.80, 5.75 |

Ten runs is a small sample, so p95 here is close to the slowest run. Task 11 eval gates decide the final numbers.

### Decisions

- **Tier agent model:** `deepseek-ai/DeepSeek-V4.1-Flash-1017`. It is the only attested model with 10/10 tool calls and an acceptable latency.
- **Fallback tier agent model:** `z-ai/glm-5.3-flash`. It is reliable but too slow for the normal path.
- **Judge model:** `Qwen/Qwen3.8-27B`. It gave 10/10 valid JSON, one distinct output at temperature 0, the lowest p95, and the lowest cost. The judge does not use tools, so its 0/10 tool result does not matter.
- **Not used:** `z-ai/glm-5.3`. Its tool calls and JSON are unreliable, it costs the most, and its attestation has a different shape.
- **Not used:** any `-abliterated` variant.

Temperature 0 does not guarantee identical output: three of the four models varied. Do not depend on replaying a judge call to get the same verdict. Store the verdict that was issued.

### Judge latency with the real prompt (run 2026-11-02)

The numbers above used a short prompt. With the real judge prompt and default reasoning, `Qwen/Qwen3.8-27B` took up to 6.6 s. Three of 10 benign messages passed the 3.5 s judge timeout, which would block them in production. Two of 20 calls hit `max_tokens` while reasoning, and one of those returned no content.

Same 10 attacks and 10 benign messages, temperature 0, `max_tokens` 400:

| Model and setting | p50 | p95 | Over 3.5 s | Attacks at risk 70+ | Benign under 40 | Empty |
|---|---|---|---|---|---|---|
| Qwen, default reasoning | about 3.7 s | 6.6 s | 12 of 19 | 9/10, one empty | 10/10 | 1 |
| Qwen, `reasoning_effort: "none"` | 1.4 s | 1.9 s | 0 | 10/10 | 10/10 | 0 |
| Qwen, `enable_thinking: false` | 1.5 s | 2.2 s | 0 | 10/10 | 10/10 | 0 |
| DeepSeek, `reasoning_effort: "none"` | 1.3 s | 2.0 s | 0 | 10/10 | 10/10 | 0 |
| DeepSeek, `enable_thinking: false` | 1.4 s | 5.3 s | 1 | 9/10 | 10/10 | 0 |

**Decision:** the judge sends `reasoning_effort: "none"` on `Qwen/Qwen3.8-27B`. Twenty messages is a small sample, and Task 11's eval gates still decide whether the block rate holds. Tier agents still need their own measurement in Task 8.

Runs cost about $0.016 in estimated spend.

### Attestation

`GET /v1/attestation/report?model=<id>&nonce=<64 hex>&signing_algo=ecdsa` returns `gateway_attestation`, `model_attestations`, `ohttp_attestation`, `ohttp_key_config`. Reports are 80-320 KB.

| Model | Attestation result |
|---|---|
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | TEE report |
| `Qwen/Qwen3.8-27B` | TEE report |
| `z-ai/glm-5.3-flash` | TEE report |
| `z-ai/glm-5.3` | Router report only: `provider: tinfoil`, `trust: router_attested`, no `signing_address` |
| `moonshotai/kimi-k3` | 503, Chutes measurement mismatch |
| `openai/*`, `anthropic/*`, `deepseek/deepseek-v4.1-flash`, `qwen/qwen3.7-max` | 503, `TEE attestation is not supported for external providers` |

Field names for `attest.ts`:

- `gateway_attestation`: `signing_address`, `signing_algo`, `intel_quote`, `event_log`, `report_data`, `request_nonce`, `info`, `vpc`.
- `model_attestations[]`: `model_name`, `signing_address`, `signing_algo`, `signing_public_key`, `request_nonce`, `intel_quote`, `nvidia_payload`, `event_log`, `info`, `ohttp_attestation`, `compose_manager_attestation`, `ohttp_key_config`.
- Both `request_nonce` fields matched the sent nonce on the three TEE models.

`attest.ts` must reject any `model_attestations` entry with no `signing_address`. This spike only compared the echoed nonce. It did not verify the TDX quote or the NVIDIA payload, and E5 says an echo is not enough. Task 9 must do that verification.

### Response signatures

`GET /v1/signature/<chat_id>?model=<id>&signing_algo=ecdsa` returned 200 on all four models, with keys `text`, `signature`, `signing_address`, `signing_algo`, `signature_kind`. On the TEE models `text` starts with the model ID. This spike did not verify the signatures. Task 9 must verify them against the attested `signing_address`.

## S3: Shade Agent template

Owner: @haikeysgit. Not recorded yet.
