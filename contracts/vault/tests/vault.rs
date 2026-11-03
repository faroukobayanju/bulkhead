//! Needs prebuilt wasm: run scripts/test-contracts.sh.
use near_workspaces::types::{AccessKey, Gas, NearToken, SecretKey};
use serde_json::json;

// Agents must attach this, not max_gas: prepaid gas is reserved against the key allowance
// up front, and max_gas reserves more than the 1 NEAR allowance.
const AGENT_GAS: Gas = Gas::from_tgas(300);
const VAULT: &str = "../target/near/bulkhead_vault/bulkhead_vault.wasm";
const SIGNER: &str = "../target/near/mock_signer/mock_signer.wasm";
const BTC_TO: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const TXID: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

fn release(attempt: &str, value: u64) -> serde_json::Value {
    json!({"tier_id":1,"attempt_id":attempt,"recipient":BTC_TO,
           "payload":{"Bitcoin":{"utxos":[{"txid":TXID,"vout":0,"value_sat":value}],"fee_rate_sat_vb":5}}})
}

fn utxo(value: u64) -> bulkhead_vault::Utxo {
    bulkhead_vault::Utxo { txid: TXID.into(), vout: 0, value_sat: value }
}

/// Returns (worker, vault, signer, agent). The agent holds only a function-call
/// key scoped to the vault, exactly as in production.
async fn setup() -> anyhow::Result<(
    near_workspaces::Worker<near_workspaces::network::Sandbox>,
    near_workspaces::Contract,
    near_workspaces::Contract,
    near_workspaces::Account,
)> {
    let w = near_workspaces::sandbox().await?;
    let signer = w.dev_deploy(&std::fs::read(SIGNER)?).await?;
    let vault = w.dev_deploy(&std::fs::read(VAULT)?).await?;
    let owner = w.dev_create_account().await?;
    let full = w.dev_create_account().await?;
    vault.call("new").args_json(json!({"owner_id":owner.id(),"mpc_contract":signer.id(),"mainnet":false})).transact().await?.into_result()?;
    owner.call(vault.id(),"configure_tier")
        .args_json(json!({"id":1,"chain":"Bitcoin","derivation_path":"bulkhead-tier-1","address":BTC_TO,"max_release":"100000","cooldown_s":3600,"rounds":2}))
        .transact().await?.into_result()?;
    owner.call(vault.id(),"register_agent_stub").args_json(json!({"account":full.id(),"codehash":"abc"})).transact().await?.into_result()?;

    let sk = SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    full.batch(full.id())
        .add_key(sk.public_key(), AccessKey::function_call_access(vault.id(), &["release_funds","log_attempt_roots"], Some(NearToken::from_near(1))))
        .transact().await?.into_result()?;
    let agent = near_workspaces::Account::from_secret_key(full.id().clone(), sk, &w);
    Ok((w, vault, signer, agent))
}

#[tokio::test]
async fn function_call_key_releases_with_zero_deposit_then_cooldown_blocks() -> anyhow::Result<()> {
    let (_w, vault, _s, agent) = setup().await?;
    let r = agent.call(vault.id(),"release_funds").args_json(release("a1",50_000)).gas(AGENT_GAS).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let tier: serde_json::Value = vault.view("get_tier").args_json(json!({"id":1})).await?.json()?;
    assert_eq!(tier["status"], "Open");
    assert_eq!(tier["rounds_left"], 1);
    let again = agent.call(vault.id(),"release_funds").args_json(release("a2",50_000)).gas(AGENT_GAS).transact().await?;
    assert!(format!("{:?}", again.failures()).contains("ERR_COOLDOWN"));
    Ok(())
}

#[tokio::test]
async fn scoped_key_cannot_call_other_methods() -> anyhow::Result<()> {
    let (_w, vault, _s, agent) = setup().await?;
    let r = agent.call(vault.id(),"pause").transact().await;
    assert!(r.is_err() || !r.unwrap().is_success());
    Ok(())
}

#[tokio::test]
async fn over_cap_rejected_on_chain() -> anyhow::Result<()> {
    let (_w, vault, _s, agent) = setup().await?;
    let r = agent.call(vault.id(),"release_funds").args_json(release("a1",100_001)).gas(AGENT_GAS).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("ERR_OVER_CAP"));
    Ok(())
}

#[tokio::test]
async fn concurrent_releases_only_one_wins() -> anyhow::Result<()> {
    let (_w, vault, _s, agent) = setup().await?;
    let a = agent.call(vault.id(),"release_funds").args_json(release("a1",50_000)).gas(AGENT_GAS).transact_async().await?;
    let b = agent.call(vault.id(),"release_funds").args_json(release("a2",50_000)).gas(AGENT_GAS).transact_async().await?;
    let (ra, rb) = (a.await?, b.await?);
    assert_eq!([ra.is_success(), rb.is_success()].iter().filter(|x| **x).count(), 1);
    Ok(())
}

#[tokio::test]
async fn signer_failure_reopens_tier_and_keeps_round() -> anyhow::Result<()> {
    let (_w, vault, signer, agent) = setup().await?;
    signer.call("fail_next").transact().await?.into_result()?;
    let _ = agent.call(vault.id(),"release_funds").args_json(release("a1",50_000)).gas(AGENT_GAS).transact().await?;
    let tier: serde_json::Value = vault.view("get_tier").args_json(json!({"id":1})).await?.json()?;
    assert_eq!(tier["status"], "Open");
    assert_eq!(tier["rounds_left"], 2);
    Ok(())
}

#[tokio::test]
async fn signer_gets_mpc_shaped_request_with_the_bitcoin_sighash() -> anyhow::Result<()> {
    let (_w, vault, signer, agent) = setup().await?;
    let r = agent.call(vault.id(),"release_funds").args_json(release("a1",50_000)).gas(AGENT_GAS).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let last: Option<String> = signer.view("last_request").await?.json()?;
    let req: serde_json::Value = serde_json::from_str(&last.expect("signer saw no request"))?;
    let (sighash, _) = bulkhead_vault::btc::build_payout(&[utxo(50_000)], BTC_TO, BTC_TO, 5).unwrap();
    assert_eq!(req, json!({"payload_v2":{"Ecdsa":hex::encode(sighash)},"path":"bulkhead-tier-1","domain_id":0}));
    Ok(())
}

#[tokio::test]
async fn release_and_callback_fit_in_agent_gas() -> anyhow::Result<()> {
    let (_w, vault, _s, agent) = setup().await?;
    let r = agent.call(vault.id(),"release_funds").args_json(release("a1",50_000)).gas(AGENT_GAS).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(r.receipt_failures().is_empty(), "{:?}", r.receipt_failures());
    let burnt = r.total_gas_burnt.as_gas();
    assert!(burnt < Gas::from_tgas(290).as_gas(), "burnt {} TGas", burnt / 1_000_000_000_000);
    let signed = r.logs().into_iter().find(|l| l.contains("\"release_signed\"")).expect("no release_signed event");
    let e: serde_json::Value = serde_json::from_str(signed.strip_prefix("EVENT_JSON:").unwrap())?;
    let pending: Option<String> = vault.view("get_pending_tx").args_json(json!({"id":"a1"})).await?.json()?;
    assert_eq!(e["data"]["unsigned_tx_hex"], json!(pending.expect("pending tx kept")));
    assert!(e["data"]["signature"]["big_r"]["affine_point"].is_string(), "{e}");
    Ok(())
}

