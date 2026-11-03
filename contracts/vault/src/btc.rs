//! One-input, one-output P2WPKH payout. BIP-143 signs the input amount, so the
//! `max_release` cap holds even if the agent lies about `value_sat` (E14).
use crate::{address, Utxo};
use near_sdk::env;
use omni_transaction::bitcoin::types::{Amount, EcdsaSighashType, Hash, LockTime, OutPoint, ScriptBuf, Sequence, Txid, TxIn, TxOut, Version, Witness};
use omni_transaction::bitcoin::BitcoinTransaction;

const MAX_FEE_RATE_SAT_VB: u64 = 200;
const DUST_SAT: u64 = 546;

/// vsize of one P2WPKH input plus one output: 88 + output script length,
/// which is 110 vB for a P2WPKH recipient and 122 vB for P2WSH or P2TR.
fn vsize(out_script_len: usize) -> u64 {
    88 + out_script_len as u64
}

fn script_pubkey(witness_version: u8, program: &[u8]) -> Vec<u8> {
    let version_op = if witness_version == 0 { 0 } else { 0x50 + witness_version };
    [&[version_op, program.len() as u8], program].concat()
}

fn unsigned_tx(utxo: &Utxo, out_script: Vec<u8>, out_sat: u64) -> Result<BitcoinTransaction, &'static str> {
    // Hash::from_hex panics on a wrong length, so check it first.
    if utxo.txid.len() != 64 {
        return Err("ERR_BAD_TXID");
    }
    let txid = Hash::from_hex(&utxo.txid).map_err(|_| "ERR_BAD_TXID")?;
    Ok(BitcoinTransaction {
        version: Version::Two,
        lock_time: LockTime::from_height(0).expect("height 0 is valid"),
        input: vec![TxIn {
            previous_output: OutPoint::new(Txid(txid), utxo.vout),
            script_sig: ScriptBuf::default(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::default(),
        }],
        output: vec![TxOut { value: Amount::from_sat(out_sat), script_pubkey: ScriptBuf(out_script) }],
    })
}

/// BIP-143 digest for input 0, SIGHASH_ALL. omni returns the preimage; the
/// digest is its double SHA-256 (host function, not wasm code).
fn sighash_p2wpkh(tx: &BitcoinTransaction, pubkey_hash: &[u8], value_sat: u64) -> Vec<u8> {
    // The scriptCode of a P2WPKH input is the P2PKH script of the same key hash.
    let script_code = ScriptBuf([&[0x76, 0xa9, 0x14], pubkey_hash, &[0x88, 0xac]].concat());
    let preimage = tx.build_for_signing_segwit(EcdsaSighashType::All, 0, &script_code, value_sat);
    env::sha256(&env::sha256(&preimage))
}

/// Returns `(sighash for input 0, unsigned tx bytes)`. The unsigned bytes use
/// the legacy layout; the agent adds the witness `[sig || 0x01, pubkey]`.
pub fn build_payout(utxos: &[Utxo], tier_address: &str, recipient: &str, fee_rate: u64) -> Result<(Vec<u8>, Vec<u8>), &'static str> {
    let [utxo] = utxos else {
        return Err(if utxos.is_empty() { "ERR_NO_UTXOS" } else { "ERR_NOT_SINGLE_INPUT" });
    };
    if fee_rate > MAX_FEE_RATE_SAT_VB {
        return Err("ERR_FEE_TOO_HIGH");
    }
    let (version, program) = address::segwit_program(recipient)?;
    let out_script = script_pubkey(version, &program);
    let pubkey_hash = address::p2wpkh_hash(tier_address)?;
    let fee = vsize(out_script.len()) * fee_rate;
    if fee * 10 > utxo.value_sat {
        return Err("ERR_FEE_TOO_HIGH");
    }
    let out_sat = utxo.value_sat - fee;
    if out_sat < DUST_SAT {
        return Err("ERR_DUST_OUTPUT");
    }
    let tx = unsigned_tx(utxo, out_script, out_sat)?;
    Ok((sighash_p2wpkh(&tx, &pubkey_hash, utxo.value_sat), tx.serialize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::consensus::{deserialize, serialize};
    use bitcoin::hashes::Hash as _;
    use bitcoin::sighash::{EcdsaSighashType, SighashCache};
    use bitcoin::{absolute::LockTime, transaction::Version, Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};
    use std::str::FromStr;

    // BIP-173 / BIP-350 vectors: P2WPKH, P2WSH, P2TR on testnet.
    const FROM: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    const TO_WSH: &str = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
    const TO_TR: &str = "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c";
    // Not a palindrome, so a wrong txid byte order changes the sighash.
    const TXID: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn u(v: u64) -> Utxo {
        Utxo { txid: "aa".repeat(32), vout: 0, value_sat: v }
    }

    fn decode_outputs(tx: &[u8]) -> Vec<(String, u64)> {
        let tx: Transaction = deserialize(tx).unwrap();
        tx.output.iter().map(|o| (Address::from_script(&o.script_pubkey, Network::Testnet).unwrap().to_string(), o.value.to_sat())).collect()
    }

    fn spk(addr: &str) -> ScriptBuf {
        Address::from_str(addr).unwrap().assume_checked().script_pubkey()
    }

    /// The same transaction built by rust-bitcoin, never by our code.
    fn oracle_tx(utxo: &Utxo, to: &str, out_sat: u64) -> Transaction {
        Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint { txid: Txid::from_str(&utxo.txid).unwrap(), vout: utxo.vout },
                script_sig: ScriptBuf::new(),
                sequence: Sequence(0xffff_fffd),
                witness: Witness::new(),
            }],
            output: vec![TxOut { value: Amount::from_sat(out_sat), script_pubkey: spk(to) }],
        }
    }

    fn oracle_sighash(tx: &Transaction, value: u64) -> Vec<u8> {
        SighashCache::new(tx).p2wpkh_signature_hash(0, &spk(FROM), Amount::from_sat(value), EcdsaSighashType::All).unwrap().to_byte_array().to_vec()
    }

    #[test]
    fn one_output_to_recipient() {
        let (_, tx) = build_payout(&[u(100_000)], FROM, TO_WSH, 10).unwrap();
        let outs = decode_outputs(&tx);
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].0, TO_WSH);
        assert_eq!(outs[0].1, 100_000 - 122 * 10);
    }

    #[test]
    fn fee_covers_the_real_vsize_for_each_recipient_type() {
        for (to, vsize) in [(FROM, 110), (TO_WSH, 122), (TO_TR, 122)] {
            let (_, bytes) = build_payout(&[u(100_000)], FROM, to, 10).unwrap();
            assert_eq!(decode_outputs(&bytes)[0].1, 100_000 - vsize * 10, "{to}");
            // Worst-case signature: 72-byte DER + sighash byte, 33-byte key.
            let mut tx: Transaction = deserialize(&bytes).unwrap();
            tx.input[0].witness = Witness::from_slice(&[vec![0u8; 73], vec![0u8; 33]]);
            assert!(tx.vsize() as u64 <= vsize, "{to}: real vsize {} > estimate {vsize}", tx.vsize());
        }
    }

    #[test]
    fn tx_bytes_and_sighash_match_rust_bitcoin() {
        for (to, vout, value) in [(FROM, 0, 100_000), (TO_WSH, 1, 50_000), (TO_TR, 7, 1_234_567)] {
            let utxo = Utxo { txid: TXID.into(), vout, value_sat: value };
            let (sighash, bytes) = build_payout(&[utxo.clone()], FROM, to, 5).unwrap();
            let out_sat = decode_outputs(&bytes)[0].1;
            let oracle = oracle_tx(&utxo, to, out_sat);
            assert_eq!(bytes, serialize(&oracle), "tx bytes for {to}");
            assert_eq!(sighash, oracle_sighash(&oracle, value), "sighash for {to}");
            assert_eq!(sighash.len(), 32);
        }
    }

    #[test]
    fn sighash_commits_to_input_value() {
        // Same transaction, different claimed input amount: BIP-143 must change the digest.
        let (_, pkh) = address::segwit_program(FROM).unwrap();
        let tx = unsigned_tx(&u(100_000), spk(TO_WSH).into_bytes(), 99_000).unwrap();
        let ours = |v: u64| sighash_p2wpkh(&tx, &pkh, v);
        assert_ne!(ours(100_000), ours(100_001));
        // rust-bitcoin agrees on the very same tx, and also sees the amount change the digest.
        let oracle: Transaction = deserialize(&tx.serialize()).unwrap();
        assert_eq!(ours(100_000), oracle_sighash(&oracle, 100_000));
        assert_ne!(oracle_sighash(&oracle, 100_000), oracle_sighash(&oracle, 100_001));
    }

    #[test]
    fn fee_rate_cap() {
        assert_eq!(build_payout(&[u(100_000)], FROM, TO_WSH, 201).unwrap_err(), "ERR_FEE_TOO_HIGH");
        assert!(build_payout(&[u(1_000_000)], FROM, TO_WSH, 200).is_ok());
    }

    #[test]
    fn fee_share_cap() {
        assert_eq!(build_payout(&[u(1_500)], FROM, TO_WSH, 20).unwrap_err(), "ERR_FEE_TOO_HIGH");
    }

    #[test]
    fn dust_output_rejected() {
        assert_eq!(build_payout(&[u(545)], FROM, TO_WSH, 0).unwrap_err(), "ERR_DUST_OUTPUT");
    }

    #[test]
    fn needs_single_utxo() {
        assert_eq!(build_payout(&[u(1), u(2)], FROM, TO_WSH, 1).unwrap_err(), "ERR_NOT_SINGLE_INPUT");
    }

    #[test]
    fn empty_rejected() {
        assert_eq!(build_payout(&[], FROM, TO_WSH, 1).unwrap_err(), "ERR_NO_UTXOS");
    }

    #[test]
    fn tier_address_must_be_p2wpkh() {
        for bad in [TO_WSH, TO_TR] {
            assert_eq!(build_payout(&[u(100_000)], bad, FROM, 5).unwrap_err(), "ERR_TIER_NOT_P2WPKH");
        }
    }

    #[test]
    fn bad_inputs_are_errors_not_panics() {
        let bad_txid = |t: &str| Utxo { txid: t.into(), vout: 0, value_sat: 100_000 };
        for t in ["aa", "", &"zz".repeat(32), &"aa".repeat(33)] {
            assert_eq!(build_payout(&[bad_txid(t)], FROM, TO_WSH, 5).unwrap_err(), "ERR_BAD_TXID", "{t}");
        }
        assert_eq!(build_payout(&[u(100_000)], FROM, "0x52908400098527886E0F7030069857D2E4169EE7", 5).unwrap_err(), "ERR_BAD_BTC_ADDR");
    }
}
