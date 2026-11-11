# Run the agent in a Phala TEE (Task 10 step 5)

The agent registers itself with the vault from inside a Phala Cloud CVM. Nobody holds its key: it is made in memory at boot, and the agent swaps it for a function-call key limited to the vault before it serves. This guide takes a testnet vault from `docs/deploy-your-vault.md` to a registered TEE agent.

Testnet only. Every step that spends or deploys needs both people's OK (HACKATHON.md).

## 1. Build and push the image

Phala runs `linux/amd64`. From the repo root:

```bash
docker buildx build --platform linux/amd64 -t docker.io/<docker-user>/bulkhead-agent:task10 --push .
docker buildx imagetools inspect docker.io/<docker-user>/bulkhead-agent:task10
```

Copy the `Digest: sha256:...` line.

## 2. Fill in the compose file

Open `deploy/phala/docker-compose.yaml` and replace:

- `REPLACE_USER` and both `REPLACE_DIGEST` with your Docker user and the digest from step 1;
- `REPLACE_VAULT` with the vault account.

Everything in this file is measured, so any later edit means new measurements and another 24 hour approval. Secrets are not in the file; they are set in step 3.

## 3. Deploy on Phala Cloud

In the Phala dashboard, create a CVM:

- Instance `tdx.small`, OS image **dstack 0.5.12**, KMS **Phala**, public logs **on**.
- Paste the compose file.
- Set the encrypted env values: `NEARAI_API_KEY`, `CONVEX_URL`, `CONVEX_SITE_URL`, `AGENT_SECRET`, `PEPPER`, `SESSION_SECRET`, `PROXY_SECRET`, `ALERT_WEBHOOK_URL` (may be empty). They must match Convex and the web deploy.

The Shade CLI cannot deploy to dstack 0.5.12 (see `docs/spikes.md`, S3), so use the dashboard.

## 4. Approve the CVM's measurements (owner, 24 h timelock)

On boot the agent logs one line with its measurements and then waits. It spends nothing while it waits:

```
{"event":"tee_measurements","measurements":{"rtmrs":{...},"key_provider_event_digest":"...","app_compose_hash_payload":"..."}}
```

The owner proposes them, and Phala's machine IDs (PPIDs) if the vault does not have them yet. The PPID list is the 23 valid 16-byte entries from S3 (`docs/spikes.md`):

```bash
near contract call-function as-transaction <vault> propose_measurements json-args '{"measurements":<the measurements object>}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <owner> network-config testnet sign-with-legacy-keychain send
near contract call-function as-transaction <vault> propose_ppids json-args '{"ppids":[...]}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <owner> network-config testnet sign-with-legacy-keychain send
```

After the timelock (24 h in the default build, 60 s in a `testnet-short-timelock` build), call `approve_measurements` and `approve_ppids` with the same arguments. `pending_owner_actions` and the `/verify` page list them while they wait.

## 5. Fund the agent

Once the measurements are approved, the agent logs its account, a 64-hex implicit account made in this boot:

```
{"event":"tee_fund_me","account":"<64 hex>"}
```

Send it 0.6 NEAR from any testnet account (registering needs about 0.31 NEAR free):

```bash
near tokens <funder>.testnet send-near <64 hex> '0.6 NEAR' network-config testnet sign-with-legacy-keychain send
```

The agent then registers, adds its scoped key, deletes its full-access key, checks itself with `keysAreScoped` and starts serving.

## 6. Check it

```bash
bun scripts/check-agent-key.ts <64 hex> --vault <vault>
near contract call-function as-read-only <vault> get_agent json-args '{"account_id":"<64 hex>"}' network-config testnet now
```

The first must exit 0. The second shows the measurements, the PPID and `valid_until_ms`, 7 days ahead. Then point the web deploy's `AGENT_URL` at the CVM's public URL for port 8787, and `/verify` shows "Agent runs in a TEE: checked by the vault contract".

## Limits

- **A reboot is a new account.** Its key lives only in memory, so every boot logs a new `tee_fund_me` account that needs 0.6 NEAR. The measurements stay approved.
- **The scoped key's 1 NEAR allowance is its lifetime gas budget.** Each 300 TGas call (payout, renewal) uses about 0.03 NEAR of it, and the daily roots post about 0.003. The agent alerts `tee_low_funds` below 0.2 NEAR; the fix is a reboot.
- **Renewal re-sends a quote.** The 7-day registration does not prove the agent is fresh, only that this account was registered from an approved CVM.
