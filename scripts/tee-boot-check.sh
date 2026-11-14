#!/usr/bin/env bash
# Runs the pinned agent image locally with the same settings as deploy/phala/docker-compose.yaml and your .env secrets,
# and prints why it stops. Outside a TEE it can only get as far as reading the dstack socket, so a run that ends with a
# dstack error means everything before the TEE step (config, Convex, NEAR RPC) works.
#   bash scripts/tee-boot-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
env_file=$(mktemp); chmod 600 "$env_file"; trap 'rm -f "$env_file"' EXIT
for k in NEARAI_API_KEY CONVEX_URL CONVEX_SITE_URL AGENT_SECRET PEPPER SESSION_SECRET PROXY_SECRET ALERT_WEBHOOK_URL; do
  grep -E "^${k}=" .env | tail -n 1 >> "$env_file" || echo "${k}=" >> "$env_file"
done
image=$(grep -E '^\s+image:' deploy/phala/docker-compose.yaml | awk '{print $2}')
timeout 90 docker run --rm --platform linux/amd64 --env-file "$env_file" \
  -e TEE=1 -e NEAR_NETWORK=testnet -e NEAR_RPC=https://rpc.testnet.fastnear.com \
  -e VAULT_ACCOUNT=vault5.bulkhead-haikeys.testnet -e MEMPOOL_BASE=https://mempool.space/testnet4/api \
  -e TIER_ENABLED_1=1 -e TIER_ENABLED_2=0 -e TIER_ENABLED_3=1 -e CODEHASH=sha256:local -e FIREWALL_VERSION=fw-v1 \
  "$image" 2>&1 | tail -n 8 || true
