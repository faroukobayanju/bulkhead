#!/usr/bin/env bash
# The demo's opening shot: attack-demo.ts --testnet against the stub demo vault (vault6), signed by the demo account's key
# from your near-cli legacy keychain. Sends three calls: over the cap (refused), within the cap (pays one real testnet4
# coin), the same again (refused by the cooldown).
#   bash scripts/run-demo.sh [demo-account] [recipient]
# The default recipient is the live arena's tier 3 address on vault5, so the paid coin tops up that pot.
set -euo pipefail
# Bitcoin data comes from blockstream.info's testnet4 Esplora unless MEMPOOL_BASE says otherwise (mempool.space was down on 2026-11-14).
cd "$(dirname "$0")/.."
account=${1:-sharpyak2852.testnet}
recipient=${2:-tb1qwyt0fqlv4v6tasfd8f636e5smz6szv68fk5fnj}
# The key: AGENT_PRIVATE_KEY if you exported it (read -s AGENT_PRIVATE_KEY; export AGENT_PRIVATE_KEY), else the legacy keychain file.
key=${AGENT_PRIVATE_KEY-}
if [[ -z "$key" ]]; then
  creds="$HOME/.near-credentials/testnet/$account.json"
  [[ -f "$creds" ]] || { echo "no key for $account: export AGENT_PRIVATE_KEY (ed25519:...) or save it to $creds" >&2; exit 2; }
  key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["private_key"])' "$creds")
fi
NEAR_NETWORK=testnet NEAR_RPC=https://rpc.testnet.fastnear.com VAULT_ACCOUNT=vault6.bulkhead-haikeys.testnet \
  AGENT_ACCOUNT="$account" AGENT_PRIVATE_KEY="$key" MEMPOOL_BASE="${MEMPOOL_BASE:-https://blockstream.info/testnet4/api}" \
  DEMO_RECIPIENT="$recipient" DEMO_TIER=1 bun scripts/attack-demo.ts --testnet
echo
echo "NEAR txs:    https://testnet.nearblocks.io/address/$account"
echo "Bitcoin tx:  https://blockstream.info/testnet4/address/tb1ql5rtpmhyfflx27ct6a90v2976pcvka2tuwgr99"
