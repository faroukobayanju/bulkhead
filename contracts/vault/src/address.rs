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

/// (witness version, witness program) of a segwit address.
pub fn segwit_program(addr: &str) -> Result<(u8, Vec<u8>), &'static str> {
    let p = SegwitHrpstring::new(addr).map_err(|_| "ERR_BAD_BTC_ADDR")?;
    Ok((p.witness_version().to_u8(), p.byte_iter().collect()))
}

/// Tier addresses must be P2WPKH: only then does BIP-143 commit to the input
/// amount, which is what makes the spending cap hold (E14).
pub fn validate_btc_p2wpkh(addr: &str, mainnet: bool) -> Result<(), &'static str> {
    validate_btc(addr, mainnet)?;
    p2wpkh_hash(addr).map(|_| ())
}

/// The 20-byte key hash of a P2WPKH address.
pub fn p2wpkh_hash(addr: &str) -> Result<Vec<u8>, &'static str> {
    match segwit_program(addr)? {
        (0, program) if program.len() == 20 => Ok(program),
        _ => Err("ERR_TIER_NOT_P2WPKH"),
    }
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
    #[test] fn circle_usdc_addresses_are_valid_eip55() {
        assert!(validate_evm("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").is_ok()); // Base
        assert!(validate_evm("0x036CbD53842c5426634e7929541eC2318f3dCF7e").is_ok()); // Base Sepolia
    }
    #[test] fn segwit_program_versions_and_lengths() {
        let (v, p) = segwit_program("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx").unwrap();
        assert_eq!((v, p.len()), (0, 20));
        assert_eq!(hex::encode(p), "751e76e8199196d454941c45d1b3a323f1433bd6");
        let (v, p) = segwit_program("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7").unwrap();
        assert_eq!((v, p.len()), (0, 32));
        let (v, p) = segwit_program("tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c").unwrap();
        assert_eq!((v, p.len()), (1, 32));
        assert!(segwit_program("0x52908400098527886E0F7030069857D2E4169EE7").is_err());
    }
    #[test] fn p2wpkh_only_for_tier_addresses() {
        assert!(validate_btc_p2wpkh("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", false).is_ok());
        assert!(validate_btc_p2wpkh("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", true).is_ok());
        for bad in ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c"] {
            assert_eq!(validate_btc_p2wpkh(bad, false), Err("ERR_TIER_NOT_P2WPKH"));
        }
        assert_eq!(validate_btc_p2wpkh("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", false), Err("ERR_BAD_BTC_ADDR"));
    }
}
