//! Base USDC `transfer(address,uint256)` as an EIP-1559 transaction. Chain id,
//! token address and calldata are fixed here, never taken from the agent.

use near_sdk::env;
use omni_transaction::evm::EVMTransaction;

pub const MAX_FEE_PER_GAS: u128 = 50_000_000_000; // 50 gwei
pub const MAX_GAS_LIMIT: u64 = 120_000;
const TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb]; // transfer(address,uint256)

fn parse_address(s: &str) -> Result<[u8; 20], &'static str> {
    let body = s.strip_prefix("0x").ok_or("ERR_BAD_EVM_ADDR")?;
    hex::decode(body).ok().and_then(|b| b.try_into().ok()).ok_or("ERR_BAD_EVM_ADDR")
}

/// Returns `(keccak256 signing hash, 0x02 || rlp(unsigned fields))`. The agent
/// appends `[y_parity, r, s]` to the same RLP list to get the broadcastable tx.
#[allow(clippy::too_many_arguments)]
pub fn build_usdc_transfer(
    chain_id: u64,
    nonce: u64,
    max_fee_per_gas: u128,
    max_priority_fee_per_gas: u128,
    gas_limit: u64,
    usdc: &str,
    recipient: &str,
    amount: u128,
) -> Result<(Vec<u8>, Vec<u8>), &'static str> {
    if max_fee_per_gas > MAX_FEE_PER_GAS {
        return Err("ERR_FEE_TOO_HIGH");
    }
    if gas_limit > MAX_GAS_LIMIT {
        return Err("ERR_GAS_LIMIT_TOO_HIGH");
    }
    let usdc = parse_address(usdc)?;
    let recipient = parse_address(recipient)?;
    // selector || address left-padded to 32 bytes || amount as 32-byte big-endian
    let input = [&TRANSFER_SELECTOR[..], &[0; 12], &recipient, &[0; 16], &amount.to_be_bytes()].concat();
    let tx = EVMTransaction {
        chain_id,
        nonce,
        to: Some(usdc),
        value: 0,
        input,
        gas_limit: gas_limit.into(),
        max_fee_per_gas,
        max_priority_fee_per_gas,
        access_list: vec![],
    };
    let unsigned = tx.build_for_signing();
    Ok((env::keccak256(&unsigned), unsigned))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_consensus::{SignableTransaction, TxEip1559};
    use alloy_primitives::{Address, Bytes, TxKind, U256};
    use sha3::{Digest, Keccak256};

    const USDC_BASE: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const USDC_SEPOLIA: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const TO: &str = "0x52908400098527886E0F7030069857D2E4169EE7";

    /// ERC-20 transfer calldata, assembled in the test from the signature string.
    fn calldata(to: &str, amount: U256) -> Bytes {
        let mut d = Keccak256::digest(b"transfer(address,uint256)")[..4].to_vec();
        d.extend_from_slice(&[0u8; 12]);
        d.extend_from_slice(to.parse::<Address>().unwrap().as_slice());
        d.extend_from_slice(&amount.to_be_bytes::<32>());
        d.into()
    }

    #[allow(clippy::too_many_arguments)]
    fn oracle(chain_id: u64, nonce: u64, max_fee: u128, prio: u128, gas: u64, usdc: &str, to: &str, amount: u128) -> TxEip1559 {
        TxEip1559 {
            chain_id,
            nonce,
            gas_limit: gas,
            max_fee_per_gas: max_fee,
            max_priority_fee_per_gas: prio,
            to: TxKind::Call(usdc.parse().unwrap()),
            value: U256::ZERO,
            access_list: Default::default(),
            input: calldata(to, U256::from(amount)),
        }
    }

    #[test]
    fn calldata_is_erc20_transfer() {
        let (_, tx) = build_usdc_transfer(8453, 0, 1_000_000_000, 100_000_000, 80_000, USDC_BASE, TO, 200_000_000).unwrap();
        let hex = hex::encode(&tx);
        assert!(hex.contains("a9059cbb")); // transfer(address,uint256) selector
        assert!(hex.contains("52908400098527886e0f7030069857d2e4169ee7"));
    }

    #[test]
    fn matches_alloy_signature_hash_and_signing_bytes() {
        let cases = [
            (8453, 0, 1_000_000_000, 100_000_000, 80_000, USDC_BASE, 200_000_000u128),
            (84532, 7, 50_000_000_000, 0, 120_000, USDC_SEPOLIA, 1),
            (8453, 300, 3_000_000_000, 3_000_000_000, 65_000, USDC_BASE, u128::MAX),
            (8453, u64::MAX, 1, 1, 21_000, USDC_BASE, 1u128 << 100),
        ];
        for (chain, nonce, max_fee, prio, gas, usdc, amount) in cases {
            let (sighash, bytes) = build_usdc_transfer(chain, nonce, max_fee, prio, gas, usdc, TO, amount).unwrap();
            let o = oracle(chain, nonce, max_fee, prio, gas, usdc, TO, amount);
            assert_eq!(bytes, o.encoded_for_signing(), "signing bytes {chain} {nonce}");
            assert_eq!(sighash, o.signature_hash().to_vec(), "sighash {chain} {nonce}");
            assert_eq!(bytes[0], 0x02);
        }
    }

    #[test]
    fn sighash_commits_to_chain_and_amount() {
        let h = |chain, amount| build_usdc_transfer(chain, 0, 1, 1, 65_000, USDC_BASE, TO, amount).unwrap().0;
        assert_ne!(h(8453, 1), h(84532, 1));
        assert_ne!(h(8453, 1), h(8453, 2));
    }

    #[test]
    fn caps_are_inclusive() {
        assert!(build_usdc_transfer(8453, 0, MAX_FEE_PER_GAS, 1, MAX_GAS_LIMIT, USDC_BASE, TO, 1).is_ok());
        assert_eq!(build_usdc_transfer(8453, 0, MAX_FEE_PER_GAS + 1, 1, 80_000, USDC_BASE, TO, 1).unwrap_err(), "ERR_FEE_TOO_HIGH");
        assert_eq!(build_usdc_transfer(8453, 0, 1, 1, MAX_GAS_LIMIT + 1, USDC_BASE, TO, 1).unwrap_err(), "ERR_GAS_LIMIT_TOO_HIGH");
    }

    #[test]
    fn gas_cap() {
        assert!(build_usdc_transfer(8453, 0, 1_000_000_000_000, 1, 80_000, USDC_BASE, TO, 1).is_err());
    }

    #[test]
    fn bad_addresses_are_errors_not_panics() {
        for bad in ["", "0x1234", "52908400098527886E0F7030069857D2E4169EE7", "0xZZ908400098527886E0F7030069857D2E4169EE7"] {
            assert_eq!(build_usdc_transfer(8453, 0, 1, 1, 65_000, USDC_BASE, bad, 1).unwrap_err(), "ERR_BAD_EVM_ADDR", "{bad}");
            assert_eq!(build_usdc_transfer(8453, 0, 1, 1, 65_000, bad, TO, 1).unwrap_err(), "ERR_BAD_EVM_ADDR", "{bad}");
        }
    }
}
