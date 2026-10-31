use bech32::{primitives::decode::SegwitHrpstring, Hrp};
use sha3::{Digest, Keccak256};

pub fn validate_btc(addr: &str, mainnet: bool) -> Result<(), &'static str> {
    let parsed = SegwitHrpstring::new(addr).map_err(|_| "ERR_BAD_BTC_ADDR")?;
    let want = Hrp::parse(if mainnet { "bc" } else { "tb" }).map_err(|_| "ERR_BAD_BTC_ADDR")?;
    if parsed.hrp() != want {
        return Err("ERR_BAD_BTC_ADDR");
    }
    Ok(())
}

/// EIP-55. Agents normalize with viem `getAddress` before calling the contract.
pub fn validate_evm(addr: &str) -> Result<(), &'static str> {
    let body = addr.strip_prefix("0x").ok_or("ERR_BAD_EVM_ADDR")?;
    if body.len() != 40 || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("ERR_BAD_EVM_ADDR");
    }
    let hash = Keccak256::digest(body.to_ascii_lowercase().as_bytes());
    for (i, c) in body.chars().enumerate() {
        if c.is_ascii_alphabetic() {
            let nibble = (hash[i / 2] >> if i % 2 == 0 { 4 } else { 0 }) & 0x0f;
            if (nibble >= 8) != c.is_ascii_uppercase() {
                return Err("ERR_BAD_EVM_ADDR");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn btc_mainnet_p2wpkh_ok() { assert!(validate_btc("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", true).is_ok()); }
    #[test] fn btc_mainnet_taproot_ok() { assert!(validate_btc("bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297", true).is_ok()); }
    #[test] fn btc_testnet_ok_on_testnet() { assert!(validate_btc("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", false).is_ok()); }
    #[test] fn btc_testnet_on_mainnet_rejected() { assert!(validate_btc("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", true).is_err()); }
    #[test] fn btc_bad_checksum_rejected() { assert!(validate_btc("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx", true).is_err()); }
    #[test] fn btc_evm_string_rejected() { assert!(validate_btc("0x52908400098527886E0F7030069857D2E4169EE7", true).is_err()); }
    #[test] fn evm_checksummed_ok() { assert!(validate_evm("0x52908400098527886E0F7030069857D2E4169EE7").is_ok()); }
    #[test] fn evm_wrong_case_rejected() { assert!(validate_evm("0x52908400098527886e0F7030069857D2E4169EE7").is_err()); }
    #[test] fn evm_short_rejected() { assert!(validate_evm("0x1234").is_err()); }
}
