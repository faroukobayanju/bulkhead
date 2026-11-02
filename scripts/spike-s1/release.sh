#!/usr/bin/env bash
# Spike S1: ask the vault to sign a one-input Bitcoin payout, assemble it and
# broadcast it to testnet4. Testnet only. Uses near-cli-rs and the signer's
# legacy keychain in ~/.near-credentials.
#
# Usage: release.sh <signer account> <vault account> <tier id> <tier path> <utxo txid> <vout> <value_sat> <fee_rate> <recipient> <attempt_id>
# <tier path> must be the derivation_path configured for <tier id>.
# <value_sat> is the amount the agent claims; a false one should be rejected by Bitcoin.
set -euo pipefail
SIGNER=$1 VAULT=$2 TIER=$3 TIER_PATH=$4 TXID=$5 VOUT=$6 VALUE=$7 FEE=$8 TO=$9 ATTEMPT=${10}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)

KEY=$(near contract call-function as-read-only v1.signer-prod.testnet derived_public_key \
  json-args "{\"path\":\"$TIER_PATH\",\"predecessor\":\"$VAULT\",\"domain_id\":0}" network-config testnet now 2>&1 |
  grep -o 'secp256k1:[1-9A-HJ-NP-Za-km-z]*' | head -1)

ARGS="{\"tier_id\":$TIER,\"attempt_id\":\"$ATTEMPT\",\"recipient\":\"$TO\",\"payload\":{\"Bitcoin\":{\"utxos\":[{\"txid\":\"$TXID\",\"vout\":$VOUT,\"value_sat\":$VALUE}],\"fee_rate_sat_vb\":$FEE}}}"
near contract call-function as-transaction "$VAULT" release_funds json-args "$ARGS" prepaid-gas '300 Tgas' \
  attached-deposit '0 NEAR' sign-as "$SIGNER" network-config testnet sign-with-legacy-keychain send > "$OUT/near.log" 2>&1
grep -E 'Transaction ID|Error|Failure|panicked' "$OUT/near.log" | head -5
grep -o 'EVENT_JSON:.*' "$OUT/near.log" | sed 's/^EVENT_JSON://; s/\x1b\[[0-9;]*m//g' > "$OUT/events"

HEX=$(python3 -I - "$OUT/events" "$HERE" "$KEY" <<'PY'
import json, sys
events = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
sys.path.insert(0, sys.argv[2])
import btc
req = next(e for e in events if e["event"] == "release_requested")["data"]
sig = next(e for e in events if e["event"] == "release_signed")["data"]
s = sig["signature"]
print(btc.assemble(sig["unsigned_tx_hex"], s["big_r"]["affine_point"], s["s"]["scalar"], sys.argv[3], req["payload"]))
PY
)
echo "signed tx: $HEX"
# mempool.space needs a text/plain body; the default form encoding gives "TX decode failed".
curl -s -X POST -H 'Content-Type: text/plain' --data "$HEX" https://mempool.space/testnet4/api/tx
echo
