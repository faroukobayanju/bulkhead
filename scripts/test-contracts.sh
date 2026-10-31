#!/usr/bin/env bash
# Builds test wasm (stub attestation, never for mainnet) and runs every contract test.
set -euo pipefail
cd "$(dirname "$0")/../contracts"
(cd mock_signer && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near/mock_signer)
(cd vault && cargo near build non-reproducible-wasm --no-abi --features stub-attestation --out-dir ../target/near/drainme_vault)
cd vault && cargo test --features stub-attestation "$@"
