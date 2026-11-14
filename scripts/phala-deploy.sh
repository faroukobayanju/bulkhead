#!/usr/bin/env bash
# Deploy the agent to a Phala Cloud CVM from deploy/phala/docker-compose.yaml (Task 10 step 5).
#
#   PHALA_API_KEY=<key from cloud.phala.network> bash scripts/phala-deploy.sh [--dry-run]
#
# Run it yourself: it reads your .env, and the deploy creates a paid CVM. It sends Phala only the secrets the
# compose file asks for (encrypted by the CLI), never the whole .env. --dry-run prints which keys it would send.
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS=(NEARAI_API_KEY CONVEX_URL CONVEX_SITE_URL AGENT_SECRET PEPPER SESSION_SECRET PROXY_SECRET ALERT_WEBHOOK_URL)
[[ -f .env ]] || { echo "no .env in the repo root" >&2; exit 2; }
[[ -n "${PHALA_API_KEY-}" || "${1-}" == "--dry-run" ]] || { echo "set PHALA_API_KEY (Phala dashboard, API tokens)" >&2; exit 2; }

env_file=$(mktemp)
chmod 600 "$env_file"
trap 'rm -f "$env_file"' EXIT

missing=()
for k in "${KEYS[@]}"; do
  line=$(grep -E "^${k}=" .env | tail -n 1 || true)
  if [[ -z "$line" || "$line" == "${k}=" ]]; then
    [[ "$k" == ALERT_WEBHOOK_URL ]] && { echo "${k}=" >> "$env_file"; continue; } # optional
    missing+=("$k")
  else
    echo "$line" >> "$env_file"
  fi
done
(( ${#missing[@]} == 0 )) || { echo "missing in .env: ${missing[*]}" >&2; exit 2; }

if [[ "${1-}" == "--dry-run" ]]; then
  echo "would send: $(cut -d= -f1 "$env_file" | tr '\n' ' ')"
  exit 0
fi

# dstack 0.5.12 is the version spike S3 verified with the vault's attestation library.
bunx phala@1.2.6 deploy \
  --api-key "$PHALA_API_KEY" \
  --name bulkhead-agent \
  --compose deploy/phala/docker-compose.yaml \
  -e "$env_file" \
  --instance-type tdx.small \
  --image dstack-0.5.12 \
  --kms phala \
  --public-logs
