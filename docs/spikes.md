# Spike results

## S1: contract-signed BTC testnet tx

Owner: @haikeysgit. Not recorded yet.

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
