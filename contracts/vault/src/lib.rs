use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, IterableSet};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

pub mod address;

#[cfg(feature = "testnet-short-timelock")]
const TIMELOCK_NS: u64 = 60_000_000_000;
#[cfg(not(feature = "testnet-short-timelock"))]
const TIMELOCK_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Chain {
    Bitcoin,
    Base,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum TierStatus {
    Open,
    Releasing { attempt_id: String, since_ns: u64 },
    Drained { attempt_id: String },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Tier {
    pub id: u8,
    pub chain: Chain,
    pub derivation_path: String,
    pub address: String,
    pub status: TierStatus,
    /// Spending cap per release: sats for Bitcoin, USDC base units for Base.
    pub max_release: U128,
    pub cooldown_s: u64,
    pub rounds_left: u8,
    pub cooldown_until_ns: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub enum PendingAction {
    Codehash { codehash: String, ready_at_ns: u64 },
    EmergencyWithdraw { tier_id: u8, to: String, ready_at_ns: u64 },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Utxo {
    pub txid: String,
    pub vout: u32,
    pub value_sat: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub enum ReleasePayload {
    Bitcoin { utxos: Vec<Utxo>, fee_rate_sat_vb: u64 },
    Base { nonce: u64, max_fee_per_gas: U128, max_priority_fee_per_gas: U128, gas_limit: u64, usdc_amount: U128 },
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub payload: Vec<u8>,
    pub path: String,
    pub key_version: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignatureResponse {
    pub big_r: near_sdk::serde_json::Value,
    pub s: near_sdk::serde_json::Value,
    pub recovery_id: u8,
}

#[ext_contract(ext_signer)]
pub trait MpcSigner {
    fn sign(&mut self, request: SignRequest) -> SignatureResponse;
}

#[ext_contract(ext_self)]
pub trait SelfCallback {
    fn on_signed(&mut self, tier_id: u8, attempt_id: String) -> Option<SignatureResponse>;
}

const SIGN_GAS: Gas = Gas::from_tgas(250);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
// Paid from the vault balance: function-call keys cannot attach deposits (E2).
// Replace with the signer fee recorded in spike S1.
const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [json])]
pub struct Config {
    pub timelock_ns: u64,
    pub mainnet: bool,
    pub stub_attestation: bool,
    pub locked: bool,
    pub paused: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    mpc_contract: AccountId,
    mainnet: bool,
    tiers: IterableMap<u8, Tier>,
    approved_codehashes: IterableSet<String>,
    pending_codehashes: IterableMap<String, u64>,
    pending_withdraws: IterableMap<u8, (String, u64)>,
    agents: IterableMap<AccountId, String>,
    roots: IterableMap<u32, Vec<(u8, String)>>,
    locked: bool,
    paused: bool,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, mpc_contract: AccountId, mainnet: bool) -> Self {
        Self {
            owner_id,
            mpc_contract,
            mainnet,
            tiers: IterableMap::new(b"t"),
            approved_codehashes: IterableSet::new(b"a"),
            pending_codehashes: IterableMap::new(b"p"),
            pending_withdraws: IterableMap::new(b"w"),
            agents: IterableMap::new(b"g"),
            roots: IterableMap::new(b"r"),
            locked: false,
            paused: false,
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "ERR_NOT_OWNER");
    }

    fn validate_recipient(&self, chain: &Chain, addr: &str) {
        match chain {
            Chain::Bitcoin => address::validate_btc(addr, self.mainnet),
            Chain::Base => address::validate_evm(addr),
        }
        .unwrap_or_else(|e| env::panic_str(e));
    }

    /// Any registered agent whose codehash is approved may act (E1), so a TEE
    /// reboot or new codehash needs no change to the frozen tiers.
    fn assert_approved_agent(&self) {
        let caller = env::predecessor_account_id();
        let approved = self.agents.get(&caller).is_some_and(|c| self.approved_codehashes.contains(c));
        require!(approved, "ERR_NOT_TIER_AGENT");
    }

    /// Dev stand-in for the Shade `register_agent` merged in Task 10. Mainnet
    /// builds omit this feature; `check-mainnet-wasm` verifies that.
    #[cfg(feature = "stub-attestation")]
    pub fn register_agent_stub(&mut self, account: AccountId, codehash: String) {
        self.assert_owner();
        self.approved_codehashes.insert(codehash.clone());
        self.agents.insert(account, codehash);
    }

    /// Spending cap, cooldown and status are enforced here, whatever the LLM
    /// or the agent says. Not payable (E2).
    pub fn release_funds(&mut self, tier_id: u8, attempt_id: String, recipient: String, payload: ReleasePayload) -> Promise {
        require!(!self.paused, "ERR_PAUSED");
        self.assert_approved_agent();
        let mut tier = self.get_tier(tier_id);
        require!(tier.status == TierStatus::Open, "ERR_TIER_NOT_OPEN");
        require!(env::block_timestamp() >= tier.cooldown_until_ns, "ERR_COOLDOWN");
        self.validate_recipient(&tier.chain, &recipient);
        match (&tier.chain, &payload) {
            (Chain::Bitcoin, ReleasePayload::Bitcoin { utxos, .. }) => {
                // BIP-143 signs the input amount, so a false value_sat yields a
                // transaction Bitcoin rejects. The cap holds against a bad agent.
                require!(utxos.len() == 1, "ERR_NOT_SINGLE_INPUT");
                require!(u128::from(utxos[0].value_sat) <= tier.max_release.0, "ERR_OVER_CAP");
            }
            (Chain::Base, ReleasePayload::Base { usdc_amount, .. }) => {
                require!(usdc_amount.0 <= tier.max_release.0, "ERR_OVER_CAP");
            }
            _ => env::panic_str("ERR_PAYLOAD_CHAIN"),
        }
        // ponytail: replaced by the real Bitcoin/EVM sighash in Task 4. Never deployed like this.
        let sighash = env::sha256(&near_sdk::borsh::to_vec(&(&recipient, &payload)).unwrap());
        tier.status = TierStatus::Releasing { attempt_id: attempt_id.clone(), since_ns: env::block_timestamp() };
        let path = tier.derivation_path.clone();
        self.tiers.insert(tier_id, tier);
        env::log_str(&format!("EVENT_JSON:{{\"event\":\"release_requested\",\"tier\":{tier_id},\"attempt_id\":\"{attempt_id}\"}}"));
        ext_signer::ext(self.mpc_contract.clone())
            .with_attached_deposit(SIGN_DEPOSIT)
            .with_static_gas(SIGN_GAS)
            .sign(SignRequest { payload: sighash, path, key_version: 0 })
            .then(ext_self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_signed(tier_id, attempt_id))
    }

    #[private]
    pub fn on_signed(
        &mut self,
        tier_id: u8,
        attempt_id: String,
        #[callback_result] result: Result<SignatureResponse, PromiseError>,
    ) -> Option<SignatureResponse> {
        let mut tier = self.get_tier(tier_id);
        let (event, sig) = match result {
            Ok(sig) => {
                tier.rounds_left = tier.rounds_left.saturating_sub(1);
                tier.cooldown_until_ns = env::block_timestamp() + tier.cooldown_s * 1_000_000_000;
                tier.status = if tier.rounds_left == 0 {
                    TierStatus::Drained { attempt_id: attempt_id.clone() }
                } else {
                    TierStatus::Open
                };
                ("release_signed", Some(sig))
            }
            Err(_) => {
                tier.status = TierStatus::Open;
                ("release_failed", None)
            }
        };
        self.tiers.insert(tier_id, tier);
        env::log_str(&format!("EVENT_JSON:{{\"event\":\"{event}\",\"tier\":{tier_id},\"attempt_id\":\"{attempt_id}\"}}"));
        sig
    }

    /// Recovery for a tier stuck in `Releasing` (callback out of gas).
    pub fn reset_releasing(&mut self, tier_id: u8) {
        self.assert_owner();
        let mut tier = self.get_tier(tier_id);
        match tier.status {
            TierStatus::Releasing { since_ns, .. } => require!(env::block_timestamp() >= since_ns + TIMELOCK_NS, "ERR_TIMELOCK"),
            _ => env::panic_str("ERR_TIER_NOT_RELEASING"),
        }
        tier.status = TierStatus::Open;
        self.tiers.insert(tier_id, tier);
    }

    /// One call per day keeps the agent's gas allowance alive for months (E7).
    pub fn log_attempt_roots(&mut self, day: u32, roots: Vec<(u8, String)>) {
        self.assert_approved_agent();
        require!(!self.roots.contains_key(&day), "ERR_ROOTS_EXIST");
        self.roots.insert(day, roots);
    }

    pub fn get_roots(&self, day: u32) -> Vec<(u8, String)> {
        self.roots.get(&day).cloned().unwrap_or_default()
    }

    pub fn propose_codehash(&mut self, codehash: String) {
        self.assert_owner();
        self.pending_codehashes.insert(codehash, env::block_timestamp() + TIMELOCK_NS);
    }

    pub fn cancel_codehash_proposal(&mut self, codehash: String) {
        self.assert_owner();
        self.pending_codehashes.remove(&codehash);
    }

    pub fn approve_codehash(&mut self, codehash: String) {
        self.assert_owner();
        let ready = *self.pending_codehashes.get(&codehash).unwrap_or_else(|| env::panic_str("ERR_NO_PROPOSAL"));
        require!(env::block_timestamp() >= ready, "ERR_TIMELOCK");
        self.pending_codehashes.remove(&codehash);
        self.approved_codehashes.insert(codehash);
    }

    pub fn is_codehash_approved(&self, codehash: String) -> bool {
        self.approved_codehashes.contains(&codehash)
    }

    pub fn configure_tier(
        &mut self,
        id: u8,
        chain: Chain,
        derivation_path: String,
        address: String,
        max_release: U128,
        cooldown_s: u64,
        rounds: u8,
    ) {
        self.assert_owner();
        require!(!self.locked, "ERR_LOCKED");
        require!(id <= 3, "ERR_BAD_TIER"); // 0 is the private mainnet canary
        self.tiers.insert(
            id,
            Tier {
                id,
                chain,
                derivation_path,
                address,
                status: TierStatus::Open,
                max_release,
                cooldown_s,
                rounds_left: rounds,
                cooldown_until_ns: 0,
            },
        );
    }

    pub fn launch_lock(&mut self) {
        self.assert_owner();
        self.locked = true;
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
    }

    pub fn propose_emergency_withdraw(&mut self, tier_id: u8, to: String) {
        self.assert_owner();
        let chain = self.get_tier(tier_id).chain;
        self.validate_recipient(&chain, &to);
        self.pending_withdraws.insert(tier_id, (to, env::block_timestamp() + TIMELOCK_NS));
    }

    pub fn cancel_emergency_withdraw(&mut self, tier_id: u8) {
        self.assert_owner();
        self.pending_withdraws.remove(&tier_id);
    }

    /// Signing the withdrawal is wired in Task 4; it starts with this check.
    fn assert_withdraw_ready(&self, tier_id: u8) -> String {
        let (to, ready) = self
            .pending_withdraws
            .get(&tier_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("ERR_NO_PROPOSAL"));
        require!(env::block_timestamp() >= ready, "ERR_TIMELOCK");
        to
    }

    pub fn get_tier(&self, id: u8) -> Tier {
        self.tiers.get(&id).cloned().unwrap_or_else(|| env::panic_str("ERR_BAD_TIER"))
    }

    pub fn pending_owner_actions(&self) -> Vec<PendingAction> {
        let mut v: Vec<PendingAction> = self
            .pending_codehashes
            .iter()
            .map(|(c, t)| PendingAction::Codehash { codehash: c.clone(), ready_at_ns: *t })
            .collect();
        v.extend(self.pending_withdraws.iter().map(|(id, (to, t))| PendingAction::EmergencyWithdraw {
            tier_id: *id,
            to: to.clone(),
            ready_at_ns: *t,
        }));
        v
    }

    pub fn get_config(&self) -> Config {
        Config {
            timelock_ns: TIMELOCK_NS,
            mainnet: self.mainnet,
            stub_attestation: cfg!(feature = "stub-attestation"),
            locked: self.locked,
            paused: self.paused,
        }
    }
}

#[cfg(test)]
impl Contract {
    fn register_agent_unapproved_for_test(&mut self, account: AccountId, codehash: String) {
        self.agents.insert(account, codehash);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult};

    const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

    fn ctx(pred: &str, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(pred.parse().unwrap())
            .block_timestamp(ts)
            .build());
    }

    fn setup() -> Contract {
        ctx("owner.testnet", 0);
        Contract::new("owner.testnet".parse().unwrap(), "v1.signer-prod.testnet".parse().unwrap(), false)
    }

    fn tier(c: &mut Contract, id: u8) {
        c.configure_tier(id, Chain::Bitcoin, "drainme-tier".into(), "tb1qexample".into(), U128(100_000), 3600, 5);
    }

    #[test]
    #[should_panic(expected = "ERR_TIMELOCK")]
    fn approve_codehash_before_24h_panics() {
        let mut c = setup();
        c.propose_codehash("abc".into());
        ctx("owner.testnet", DAY_NS - 1);
        c.approve_codehash("abc".into());
    }

    #[test]
    fn approve_codehash_after_24h_works() {
        let mut c = setup();
        c.propose_codehash("abc".into());
        ctx("owner.testnet", DAY_NS);
        c.approve_codehash("abc".into());
        assert!(c.is_codehash_approved("abc".into()));
    }

    #[test]
    #[should_panic(expected = "ERR_NO_PROPOSAL")]
    fn cancelled_codehash_cannot_be_approved() {
        let mut c = setup();
        c.propose_codehash("abc".into());
        c.cancel_codehash_proposal("abc".into());
        ctx("owner.testnet", DAY_NS);
        c.approve_codehash("abc".into());
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn non_owner_cannot_propose() {
        let mut c = setup();
        ctx("mallory.testnet", 0);
        c.propose_codehash("abc".into());
    }

    #[test]
    #[should_panic(expected = "ERR_LOCKED")]
    fn configure_after_launch_lock_panics() {
        let mut c = setup();
        c.launch_lock();
        tier(&mut c, 1);
    }

    #[test]
    #[should_panic(expected = "ERR_TIMELOCK")]
    fn emergency_withdraw_before_24h_panics() {
        let mut c = setup();
        tier(&mut c, 1);
        c.propose_emergency_withdraw(1, "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".into());
        ctx("owner.testnet", DAY_NS - 1);
        c.assert_withdraw_ready(1);
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_BTC_ADDR")]
    fn emergency_withdraw_address_checked_at_propose() {
        let mut c = setup();
        tier(&mut c, 1);
        c.propose_emergency_withdraw(1, "0x52908400098527886E0F7030069857D2E4169EE7".into());
    }

    #[test]
    fn pending_actions_listed_then_cancelled() {
        let mut c = setup();
        tier(&mut c, 1);
        c.propose_codehash("abc".into());
        c.propose_emergency_withdraw(1, "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".into());
        assert_eq!(c.pending_owner_actions().len(), 2);
        c.cancel_emergency_withdraw(1);
        assert_eq!(c.pending_owner_actions().len(), 1);
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_TIER")]
    fn tier_four_rejected() {
        let mut c = setup();
        tier(&mut c, 4);
    }

    #[test]
    fn tier_zero_canary_allowed_and_keeps_cap_fields() {
        let mut c = setup();
        tier(&mut c, 0);
        let t = c.get_tier(0);
        assert_eq!(t.max_release, U128(100_000));
        assert_eq!(t.cooldown_s, 3600);
        assert_eq!(t.rounds_left, 5);
        assert_eq!(t.cooldown_until_ns, 0);
        assert_eq!(t.status, TierStatus::Open);
    }

    #[test]
    fn config_reports_timelock() {
        let c = setup();
        let cfg = c.get_config();
        assert_eq!(cfg.timelock_ns, DAY_NS);
        assert!(!cfg.mainnet);
    }

    // ---- release_funds (Task 3, E1, E2, E7, E14) ----

    const AGENT: &str = "agent.testnet";
    const BTC_TO: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

    fn ready() -> Contract {
        let mut c = setup();
        tier(&mut c, 1);
        c.register_agent_stub(AGENT.parse().unwrap(), "abc".into());
        ctx(AGENT, 1_000);
        c
    }

    fn btc(value: u64) -> ReleasePayload {
        ReleasePayload::Bitcoin {
            utxos: vec![Utxo { txid: "aa".repeat(32), vout: 0, value_sat: value }],
            fee_rate_sat_vb: 5,
        }
    }

    fn signed(c: &mut Contract, ts: u64, ok: bool) -> Option<SignatureResponse> {
        let result = if ok { PromiseResult::Successful(b"{\"big_r\":{},\"s\":{},\"recovery_id\":0}".to_vec()) } else { PromiseResult::Failed };
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("vault.testnet".parse().unwrap())
                .predecessor_account_id("vault.testnet".parse().unwrap())
                .block_timestamp(ts)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
        let r = match ok {
            true => Ok(SignatureResponse { big_r: Default::default(), s: Default::default(), recovery_id: 0 }),
            false => Err(near_sdk::PromiseError::Failed),
        };
        c.on_signed(1, "a1".into(), r)
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_TIER_AGENT")]
    fn stranger_cannot_release() {
        let mut c = ready();
        ctx("mallory.testnet", 1_000);
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_TIER_AGENT")]
    fn registered_agent_with_unapproved_codehash_rejected() {
        let mut c = ready();
        ctx("owner.testnet", 1_000);
        c.register_agent_unapproved_for_test("other.testnet".parse().unwrap(), "nope".into());
        ctx("other.testnet", 1_000);
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
    }

    #[test]
    fn second_approved_agent_can_release() {
        let mut c = ready();
        ctx("owner.testnet", 1_000);
        c.register_agent_stub("agent2.testnet".parse().unwrap(), "abc".into());
        ctx("agent2.testnet", 1_000);
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        assert!(matches!(c.get_tier(1).status, TierStatus::Releasing { .. }));
    }

    #[test]
    #[should_panic(expected = "ERR_PAUSED")]
    fn paused_blocks_release() {
        let mut c = ready();
        ctx("owner.testnet", 1_000);
        c.pause();
        ctx(AGENT, 1_000);
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_BTC_ADDR")]
    fn wrong_chain_recipient_rejected() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), "0x52908400098527886E0F7030069857D2E4169EE7".into(), btc(50_000));
    }

    #[test]
    #[should_panic(expected = "ERR_PAYLOAD_CHAIN")]
    fn payload_chain_mismatch_rejected() {
        let mut c = ready();
        let p = ReleasePayload::Base { nonce: 0, max_fee_per_gas: U128(1), max_priority_fee_per_gas: U128(1), gas_limit: 80_000, usdc_amount: U128(1) };
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), p);
    }

    #[test]
    #[should_panic(expected = "ERR_OVER_CAP")]
    fn over_cap_rejected() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(100_001));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_SINGLE_INPUT")]
    fn two_inputs_rejected() {
        let mut c = ready();
        let p = ReleasePayload::Bitcoin {
            utxos: vec![
                Utxo { txid: "aa".repeat(32), vout: 0, value_sat: 50_000 },
                Utxo { txid: "bb".repeat(32), vout: 0, value_sat: 50_000 },
            ],
            fee_rate_sat_vb: 5,
        };
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), p);
    }

    #[test]
    #[should_panic(expected = "ERR_TIER_NOT_OPEN")]
    fn release_while_releasing_rejected() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        let _ = c.release_funds(1, "a2".into(), BTC_TO.into(), btc(50_000));
    }

    #[test]
    fn success_spends_round_and_starts_cooldown() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        assert!(signed(&mut c, 2_000, true).is_some());
        let t = c.get_tier(1);
        assert_eq!(t.status, TierStatus::Open);
        assert_eq!(t.rounds_left, 4);
        assert_eq!(t.cooldown_until_ns, 2_000 + 3600 * 1_000_000_000);
    }

    #[test]
    #[should_panic(expected = "ERR_COOLDOWN")]
    fn cooldown_blocks_second_round() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        signed(&mut c, 2_000, true);
        ctx(AGENT, 2_001);
        let _ = c.release_funds(1, "a2".into(), BTC_TO.into(), btc(50_000));
    }

    #[test]
    fn release_allowed_after_cooldown() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        signed(&mut c, 2_000, true);
        ctx(AGENT, 2_000 + 3600 * 1_000_000_000);
        let _ = c.release_funds(1, "a2".into(), BTC_TO.into(), btc(50_000));
        assert!(matches!(c.get_tier(1).status, TierStatus::Releasing { .. }));
    }

    #[test]
    fn last_round_drains() {
        let mut c = setup();
        c.configure_tier(1, Chain::Bitcoin, "p".into(), "tb1qexample".into(), U128(100_000), 3600, 1);
        c.register_agent_stub(AGENT.parse().unwrap(), "abc".into());
        ctx(AGENT, 1_000);
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        signed(&mut c, 2_000, true);
        assert_eq!(c.get_tier(1).status, TierStatus::Drained { attempt_id: "a1".into() });
    }

    #[test]
    fn signer_failure_keeps_round_and_reopens() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        assert!(signed(&mut c, 2_000, false).is_none());
        let t = c.get_tier(1);
        assert_eq!(t.status, TierStatus::Open);
        assert_eq!(t.rounds_left, 5);
        assert_eq!(t.cooldown_until_ns, 0);
    }

    #[test]
    #[should_panic(expected = "ERR_TIMELOCK")]
    fn reset_releasing_needs_24h() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        ctx("owner.testnet", 1_000 + DAY_NS - 1);
        c.reset_releasing(1);
    }

    #[test]
    fn reset_releasing_after_24h() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        ctx("owner.testnet", 1_000 + DAY_NS);
        c.reset_releasing(1);
        assert_eq!(c.get_tier(1).status, TierStatus::Open);
    }

    #[test]
    fn roots_written_once_per_day() {
        let mut c = ready();
        c.log_attempt_roots(20_000, vec![(1, "r1".into()), (2, "r2".into())]);
        assert_eq!(c.get_roots(20_000).len(), 2);
    }

    #[test]
    #[should_panic(expected = "ERR_ROOTS_EXIST")]
    fn roots_cannot_be_rewritten() {
        let mut c = ready();
        c.log_attempt_roots(20_000, vec![(1, "r1".into())]);
        c.log_attempt_roots(20_000, vec![(1, "evil".into())]);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_TIER_AGENT")]
    fn stranger_cannot_write_roots() {
        let mut c = ready();
        ctx("mallory.testnet", 1_000);
        c.log_attempt_roots(20_000, vec![(1, "r1".into())]);
    }
}
