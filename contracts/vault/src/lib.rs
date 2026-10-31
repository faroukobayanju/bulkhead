use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, IterableSet};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

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
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

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
}
