#!/usr/bin/env bash
# Deploy the website to Vercel (production), pointed at the TEE agent on Phala and the testnet vault5.
#   bash scripts/vercel-deploy.sh
# Run it yourself: it reads PROXY_SECRET and CONVEX_URL from your .env and stores them as Vercel env vars.
# The site imports ../shared and ../agent, so it is built locally (vercel build) and the output uploaded (--prebuilt).
set -euo pipefail
cd "$(dirname "$0")/.."
val() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2-; }
PROXY_SECRET=$(val PROXY_SECRET); CONVEX_URL=$(val CONVEX_URL)
[[ -n "$PROXY_SECRET" && -n "$CONVEX_URL" ]] || { echo "PROXY_SECRET or CONVEX_URL missing in .env" >&2; exit 2; }

cd web
vercel link --yes --project bulkhead >/dev/null
put() { vercel env rm "$1" production --yes >/dev/null 2>&1 || true; printf %s "$2" | vercel env add "$1" production >/dev/null; echo "set $1"; }
put AGENT_URL "https://8d9444ffca5e49147919faf500e93ccecf46f264-8787.dstack-pha1-prod9.phala.network"
put PROXY_SECRET "$PROXY_SECRET"
put NEXT_PUBLIC_NETWORK testnet
put NEXT_PUBLIC_CONVEX_URL "$CONVEX_URL"
put VAULT_ACCOUNT vault5.bulkhead-haikeys.testnet
put TIER_ENABLED_1 1
put TIER_ENABLED_2 0
put TIER_ENABLED_3 1

vercel pull --yes --environment=production >/dev/null
vercel build --prod
vercel deploy --prebuilt --prod
