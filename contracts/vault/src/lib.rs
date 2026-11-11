use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, IterableSet};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use shade_attestation::attestation::DstackAttestation;
use shade_attestation::measurements::{FullMeasurements, FullMeasurementsHex};
use shade_attestation::report_data::ReportData;
use shade_attestation::tcb_info::HexBytes;
#[cfg(any(feature = "stub-attestation", test))]
use shade_attestation::measurements::create_mock_full_measurements_hex;

pub mod address;
pub mod btc;
pub mod evm;

#[cfg(feature = "testnet-short-timelock")]
const TIMELOCK_NS: u64 = 60_000_000_000;
#[cfg(not(feature = "testnet-short-timelock"))]
const TIMELOCK_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

/// How long one TEE attestation lets an agent act; it renews before this runs out.
pub const ATTESTATION_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Platform ID of the TDX machine the agent runs on.
pub type Ppid = HexBytes<16>;

/// What a registered agent proved: its TEE measurements, its machine, and until when.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AgentView {
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: U64,
}

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
    /// Base tiers only: fixed at configure time, never taken from the agent.
    pub evm: Option<EvmTier>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct EvmTier {
    pub chain_id: u64,
    pub usdc: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub enum PendingAction {
    Measurements { measurements: FullMeasurementsHex, ready_at_ns: u64 },
    Ppid { ppid: Ppid, ready_at_ns: u64 },
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
pub enum SignPayload {
    Ecdsa(String),
}

/// Argument of `v1.signer` `sign`, as documented in the near/mpc contract
/// README. Domain 0 is the secp256k1 key used for Bitcoin and EVM.
#[near(serializers = [json])]
pub struct SignRequest {
    pub payload_v2: SignPayload,
    pub path: String,
    pub domain_id: u64,
}

impl SignRequest {
    pub fn ecdsa(hash: &[u8], path: String) -> Self {
        Self { payload_v2: SignPayload::Ecdsa(hex::encode(hash)), path, domain_id: 0 }
    }
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
    fn on_withdraw_signed(&mut self, withdraw_id: String) -> Option<SignatureResponse>;
}

const SIGN_GAS: Gas = Gas::from_tgas(250);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
// Paid from the vault balance: function-call keys cannot attach deposits (E2).
// v1.signer requires at least 1 yoctoNEAR and refunds any excess.
const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
const MAX_COOLDOWN_S: u64 = 30 * 24 * 60 * 60;

/// NEP-297 event. Built with serde so agent-supplied strings cannot break the JSON.
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let e = near_sdk::serde_json::json!({"standard": "bulkhead", "version": "1.0.0", "event": event, "data": data});
    env::log_str(&format!("EVENT_JSON:{e}"));
}

/// ULIDs fit easily; the bound keeps storage per attempt small.
fn validate_attempt_id(id: &str) {
    let ok = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    require!(ok, "ERR_BAD_ATTEMPT_ID");
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
    approved_measurements: IterableSet<FullMeasurementsHex>,
    pending_measurements: IterableMap<FullMeasurementsHex, u64>,
    approved_ppids: IterableSet<Ppid>,
    pending_ppids: IterableMap<Ppid, u64>,
    pending_withdraws: IterableMap<u8, (String, u64)>,
    agents: IterableMap<AccountId, Agent>,
    roots: IterableMap<u32, Vec<(u8, String)>>,
    /// attempt or withdraw id -> unsigned tx hex, kept after signing so a payout
    /// can be rebuilt and rebroadcast from contract state alone (E6).
    pending_tx: IterableMap<String, String>,
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
            approved_measurements: IterableSet::new(b"a"),
            pending_measurements: IterableMap::new(b"p"),
            approved_ppids: IterableSet::new(b"d"),
            pending_ppids: IterableMap::new(b"e"),
            pending_withdraws: IterableMap::new(b"w"),
            agents: IterableMap::new(b"g"),
            roots: IterableMap::new(b"r"),
            pending_tx: IterableMap::new(b"x"),
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

    /// Any registered agent may act while its attestation is fresh and its
    /// measurements and machine are still approved (E1), so a TEE reboot or a
    /// new image needs no change to the frozen tiers. Removing either approval
    /// stops the agent at once.
    fn assert_approved_agent(&self) {
        let caller = env::predecessor_account_id();
        let approved = self.agents.get(&caller).is_some_and(|a| {
            env::block_timestamp_ms() <= a.valid_until_ms
                && self.approved_measurements.contains(&a.measurements)
                && self.approved_ppids.contains(&a.ppid)
        });
        require!(approved, "ERR_NOT_TIER_AGENT");
    }

    /// `(sighash, unsigned tx)` for the tier's chain. Callers apply the cap.
    fn build_tx(&self, tier: &Tier, to: &str, payload: &ReleasePayload) -> (Vec<u8>, Vec<u8>) {
        let built = match (&tier.chain, payload) {
            (Chain::Bitcoin, ReleasePayload::Bitcoin { utxos, fee_rate_sat_vb }) => {
                btc::build_payout(utxos, &tier.address, to, *fee_rate_sat_vb)
            }
            (Chain::Base, ReleasePayload::Base { nonce, max_fee_per_gas, max_priority_fee_per_gas, gas_limit, usdc_amount }) => {
                let evm = tier.evm.as_ref().unwrap_or_else(|| env::panic_str("ERR_EVM_CONFIG"));
                evm::build_usdc_transfer(
                    evm.chain_id,
                    *nonce,
                    max_fee_per_gas.0,
                    max_priority_fee_per_gas.0,
                    *gas_limit,
                    &evm.usdc,
                    to,
                    usdc_amount.0,
                )
            }
            _ => env::panic_str("ERR_PAYLOAD_CHAIN"),
        };
        built.unwrap_or_else(|e| env::panic_str(e))
    }

    fn request_signature(&self, path: String, sighash: &[u8]) -> Promise {
        ext_signer::ext(self.mpc_contract.clone())
            .with_attached_deposit(SIGN_DEPOSIT)
            .with_static_gas(SIGN_GAS)
            .sign(SignRequest::ecdsa(sighash, path))
    }

    /// Dev stand-in for `register_agent` when there is no TEE: approves the
    /// all-zero mock measurements and PPID without the timelock. Mainnet builds
    /// omit this feature; `check-mainnet-wasm` verifies that.
    #[cfg(feature = "stub-attestation")]
    pub fn register_agent_stub(&mut self, account: AccountId) {
        self.assert_owner();
        let measurements = create_mock_full_measurements_hex();
        self.approved_measurements.insert(measurements.clone());
        self.approved_ppids.insert(Ppid::default());
        let valid_until_ms = env::block_timestamp_ms() + ATTESTATION_TTL_MS;
        self.agents.insert(account, Agent { measurements, ppid: Ppid::default(), valid_until_ms });
    }

    /// Called by the agent from inside its TEE. The quote must bind the
    /// caller's implicit account, pass Intel's checks, and match approved
    /// measurements and an approved PPID. A first registration pays for its
    /// storage; a renewal pays nothing, because the agent renews with its
    /// function-call key, which cannot attach a deposit.
    #[payable]
    pub fn register_agent(&mut self, attestation: DstackAttestation) {
        let caller = env::predecessor_account_id();
        let id = caller.as_str();
        require!(id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "ERR_NOT_IMPLICIT_ACCOUNT");
        let mut report_data = [0u8; 64];
        report_data[..32].copy_from_slice(&hex::decode(id).unwrap_or_else(|_| env::panic_str("ERR_NOT_IMPLICIT_ACCOUNT")));

        let accepted_measurements: Vec<FullMeasurements> = self.approved_measurements.iter().cloned().map(Into::into).collect();
        let accepted_ppids: Vec<Ppid> = self.approved_ppids.iter().cloned().collect();
        let accepted = attestation
            .verify(ReportData::from(report_data), env::block_timestamp_ms() / 1000, &accepted_measurements, &accepted_ppids)
            .unwrap_or_else(|e| env::panic_str(&format!("ERR_ATTESTATION: {e}")));

        let renewal = self.agents.contains_key(&caller);
        let storage_before = env::storage_usage();
        let agent = Agent {
            measurements: accepted.measurements.into(),
            ppid: accepted.ppid,
            valid_until_ms: env::block_timestamp_ms() + ATTESTATION_TTL_MS,
        };
        emit(
            "agent_registered",
            near_sdk::serde_json::json!({"account_id": id, "ppid": agent.ppid, "valid_until_ms": U64(agent.valid_until_ms), "renewal": renewal}),
        );
        self.agents.insert(caller, agent);
        self.agents.flush();
        if !renewal {
            let added = env::storage_usage().saturating_sub(storage_before);
            let cost = env::storage_byte_cost().saturating_mul(added.into());
            require!(env::attached_deposit() >= cost, "ERR_STORAGE_DEPOSIT");
        }
    }

    pub fn get_agent(&self, account_id: AccountId) -> Option<AgentView> {
        self.agents.get(&account_id).map(|a| AgentView {
            measurements: a.measurements.clone(),
            ppid: a.ppid.clone(),
            valid_until_ms: U64(a.valid_until_ms),
        })
    }

    /// Spending cap, cooldown and status are enforced here, whatever the LLM
    /// or the agent says. Not payable (E2).
    pub fn release_funds(&mut self, tier_id: u8, attempt_id: String, recipient: String, payload: ReleasePayload) -> Promise {
        require!(!self.paused, "ERR_PAUSED");
        self.assert_approved_agent();
        validate_attempt_id(&attempt_id);
        require!(!self.pending_tx.contains_key(&attempt_id), "ERR_DUP_ATTEMPT");
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
        let (sighash, tx) = self.build_tx(&tier, &recipient, &payload);
        tier.status = TierStatus::Releasing { attempt_id: attempt_id.clone(), since_ns: env::block_timestamp() };
        let path = tier.derivation_path.clone();
        self.tiers.insert(tier_id, tier);
        self.pending_tx.insert(attempt_id.clone(), hex::encode(tx));
        emit(
            "release_requested",
            near_sdk::serde_json::json!({"tier": tier_id, "attempt_id": attempt_id, "payload": hex::encode(&sighash)}),
        );
        self.request_signature(path, &sighash)
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
        let sig = match result {
            Ok(sig) => {
                tier.rounds_left = tier.rounds_left.saturating_sub(1);
                tier.cooldown_until_ns = env::block_timestamp() + tier.cooldown_s * 1_000_000_000;
                tier.status = if tier.rounds_left == 0 {
                    TierStatus::Drained { attempt_id: attempt_id.clone() }
                } else {
                    TierStatus::Open
                };
                let data = near_sdk::serde_json::json!({
                    "tier": tier_id,
                    "attempt_id": attempt_id,
                    "unsigned_tx_hex": self.pending_tx.get(&attempt_id),
                    "signature": sig,
                });
                emit("release_signed", data);
                Some(sig)
            }
            Err(_) => {
                tier.status = TierStatus::Open;
                self.pending_tx.remove(&attempt_id);
                emit("release_failed", near_sdk::serde_json::json!({"tier": tier_id, "attempt_id": attempt_id}));
                None
            }
        };
        self.tiers.insert(tier_id, tier);
        sig
    }

    #[private]
    pub fn on_withdraw_signed(
        &mut self,
        withdraw_id: String,
        #[callback_result] result: Result<SignatureResponse, PromiseError>,
    ) -> Option<SignatureResponse> {
        match result {
            Ok(sig) => {
                let data = near_sdk::serde_json::json!({
                    "withdraw_id": withdraw_id,
                    "unsigned_tx_hex": self.pending_tx.get(&withdraw_id),
                    "signature": sig,
                });
                emit("withdraw_signed", data);
                Some(sig)
            }
            Err(_) => {
                self.pending_tx.remove(&withdraw_id);
                emit("withdraw_failed", near_sdk::serde_json::json!({"withdraw_id": withdraw_id}));
                None
            }
        }
    }

    pub fn get_pending_tx(&self, id: String) -> Option<String> {
        self.pending_tx.get(&id).cloned()
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

    // Approving is timelocked because it lets new code or new machines act;
    // removing takes effect at once because it can only stop agents.

    pub fn propose_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.assert_owner();
        self.pending_measurements.insert(measurements, env::block_timestamp() + TIMELOCK_NS);
    }

    pub fn cancel_measurements_proposal(&mut self, measurements: FullMeasurementsHex) {
        self.assert_owner();
        self.pending_measurements.remove(&measurements);
    }

    pub fn approve_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.assert_owner();
        let ready = *self.pending_measurements.get(&measurements).unwrap_or_else(|| env::panic_str("ERR_NO_PROPOSAL"));
        require!(env::block_timestamp() >= ready, "ERR_TIMELOCK");
        self.pending_measurements.remove(&measurements);
        self.approved_measurements.insert(measurements);
    }

    pub fn remove_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.assert_owner();
        self.approved_measurements.remove(&measurements);
    }

    pub fn get_approved_measurements(&self) -> Vec<FullMeasurementsHex> {
        self.approved_measurements.iter().cloned().collect()
    }

    pub fn propose_ppids(&mut self, ppids: Vec<Ppid>) {
        self.assert_owner();
        let ready = env::block_timestamp() + TIMELOCK_NS;
        for p in ppids {
            self.pending_ppids.insert(p, ready);
        }
    }

    pub fn cancel_ppids_proposal(&mut self, ppids: Vec<Ppid>) {
        self.assert_owner();
        for p in ppids {
            self.pending_ppids.remove(&p);
        }
    }

    pub fn approve_ppids(&mut self, ppids: Vec<Ppid>) {
        self.assert_owner();
        for p in ppids {
            let ready = *self.pending_ppids.get(&p).unwrap_or_else(|| env::panic_str("ERR_NO_PROPOSAL"));
            require!(env::block_timestamp() >= ready, "ERR_TIMELOCK");
            self.pending_ppids.remove(&p);
            self.approved_ppids.insert(p);
        }
    }

    pub fn remove_ppids(&mut self, ppids: Vec<Ppid>) {
        self.assert_owner();
        for p in ppids {
            self.approved_ppids.remove(&p);
        }
    }

    pub fn get_approved_ppids(&self) -> Vec<Ppid> {
        self.approved_ppids.iter().cloned().collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn configure_tier(
        &mut self,
        id: u8,
        chain: Chain,
        derivation_path: String,
        address: String,
        max_release: U128,
        cooldown_s: u64,
        rounds: u8,
        evm: Option<EvmTier>,
    ) {
        self.assert_owner();
        require!(!self.locked, "ERR_LOCKED");
        require!(id <= 3, "ERR_BAD_TIER"); // 0 is the private mainnet canary
        require!(rounds >= 1, "ERR_BAD_ROUNDS");
        // Keeps cooldown_s * 1e9 far from u64 overflow in on_signed.
        require!(cooldown_s <= MAX_COOLDOWN_S, "ERR_BAD_COOLDOWN");
        if let Some(t) = self.tiers.get(&id) {
            // A reconfigure must not reopen a tier whose signature is in flight.
            require!(!matches!(t.status, TierStatus::Releasing { .. }), "ERR_TIER_NOT_OPEN");
        }
        match (&chain, &evm) {
            // Only P2WPKH makes BIP-143 commit to the input amount, so the cap holds (E14).
            (Chain::Bitcoin, None) => address::validate_btc_p2wpkh(&address, self.mainnet),
            (Chain::Base, Some(e)) => {
                require!(e.chain_id == if self.mainnet { 8453 } else { 84532 }, "ERR_BAD_CHAIN_ID");
                address::validate_evm(&address).and(address::validate_evm(&e.usdc))
            }
            _ => Err("ERR_EVM_CONFIG"),
        }
        .unwrap_or_else(|e| env::panic_str(e));
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
                evm,
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

    /// Moves one UTXO (or one USDC amount) to the proposed address. It ignores
    /// the cap but needs the 24 h timelock, and the proposal stays valid until
    /// cancelled so it can be called once per UTXO (E14). Works while paused.
    pub fn execute_emergency_withdraw(&mut self, tier_id: u8, payload: ReleasePayload) -> Promise {
        self.assert_owner();
        let to = self.assert_withdraw_ready(tier_id);
        let tier = self.get_tier(tier_id);
        let (sighash, tx) = self.build_tx(&tier, &to, &payload);
        // ':' is not allowed in an attempt_id, so an agent cannot pre-empt this id.
        let withdraw_id = format!("withdraw:{tier_id}:{}", env::block_height());
        require!(!self.pending_tx.contains_key(&withdraw_id), "ERR_DUP_ATTEMPT");
        self.pending_tx.insert(withdraw_id.clone(), hex::encode(tx));
        emit(
            "withdraw_requested",
            near_sdk::serde_json::json!({"tier": tier_id, "withdraw_id": withdraw_id, "to": to, "payload": hex::encode(&sighash)}),
        );
        self.request_signature(tier.derivation_path, &sighash)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_withdraw_signed(withdraw_id))
    }

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
            .pending_measurements
            .iter()
            .map(|(m, t)| PendingAction::Measurements { measurements: m.clone(), ready_at_ns: *t })
            .collect();
        v.extend(self.pending_ppids.iter().map(|(p, t)| PendingAction::Ppid { ppid: p.clone(), ready_at_ns: *t }));
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
    /// An agent whose all-ones measurements were never approved.
    fn register_agent_unapproved_for_test(&mut self, account: AccountId) {
        let mut measurements = create_mock_full_measurements_hex();
        measurements.app_compose_hash_payload = [1u8; 32].into();
        let valid_until_ms = env::block_timestamp_ms() + ATTESTATION_TTL_MS;
        self.agents.insert(account, Agent { measurements, ppid: Ppid::default(), valid_until_ms });
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

    /// P2WPKH vector from BIP-173; the tier's own address.
    const TIER_ADDR: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    const TXID: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const USDC_SEPOLIA: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const EVM_TO: &str = "0x52908400098527886E0F7030069857D2E4169EE7";

    fn tier(c: &mut Contract, id: u8) {
        c.configure_tier(id, Chain::Bitcoin, "bulkhead-tier".into(), TIER_ADDR.into(), U128(100_000), 3600, 5, None);
    }

    fn base_tier(c: &mut Contract, id: u8) {
        let evm = EvmTier { chain_id: 84532, usdc: USDC_SEPOLIA.into() };
        c.configure_tier(id, Chain::Base, "bulkhead-tier-2".into(), EVM_TO.into(), U128(50_000_000), 3600, 4, Some(evm));
    }

    // ---- agent approval: measurements and PPIDs behind the timelock (Task 10, E1) ----

    fn mock() -> FullMeasurementsHex {
        create_mock_full_measurements_hex()
    }

    #[test]
    #[should_panic(expected = "ERR_TIMELOCK")]
    fn approve_measurements_before_24h_panics() {
        let mut c = setup();
        c.propose_measurements(mock());
        ctx("owner.testnet", DAY_NS - 1);
        c.approve_measurements(mock());
    }

    #[test]
    fn approve_measurements_after_24h_works() {
        let mut c = setup();
        c.propose_measurements(mock());
        ctx("owner.testnet", DAY_NS);
        c.approve_measurements(mock());
        assert_eq!(c.get_approved_measurements(), vec![mock()]);
        assert!(c.pending_owner_actions().is_empty());
    }

    #[test]
    #[should_panic(expected = "ERR_NO_PROPOSAL")]
    fn cancelled_measurements_cannot_be_approved() {
        let mut c = setup();
        c.propose_measurements(mock());
        c.cancel_measurements_proposal(mock());
        ctx("owner.testnet", DAY_NS);
        c.approve_measurements(mock());
    }

    #[test]
    #[should_panic(expected = "ERR_TIMELOCK")]
    fn approve_ppids_before_24h_panics() {
        let mut c = setup();
        c.propose_ppids(vec![Ppid::default()]);
        ctx("owner.testnet", DAY_NS - 1);
        c.approve_ppids(vec![Ppid::default()]);
    }

    #[test]
    fn approve_ppids_after_24h_works() {
        let mut c = setup();
        c.propose_ppids(vec![Ppid::default()]);
        ctx("owner.testnet", DAY_NS);
        c.approve_ppids(vec![Ppid::default()]);
        assert_eq!(c.get_approved_ppids(), vec![Ppid::default()]);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn non_owner_cannot_propose() {
        let mut c = setup();
        ctx("mallory.testnet", 0);
        c.propose_measurements(mock());
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn non_owner_cannot_propose_ppids() {
        let mut c = setup();
        ctx("mallory.testnet", 0);
        c.propose_ppids(vec![Ppid::default()]);
    }

    // ---- register_agent with a real Phala TDX attestation (Task 10 step 3) ----

    /// The attestation the S3 agent sent from a Phala CVM (dstack 0.5.12),
    /// read from its register_agent call on testnet.
    const S3_ATTESTATION: &str = include_str!("../tests/fixtures/s3-attestation.json");
    const S3_AGENT: &str = "29dfb11751d74844bcd05306e6387ef264541f8be6d938925207a1f0af9749a1";
    /// Block time of that call; the quote's collateral is valid then.
    const S3_TS_NS: u64 = 1_794_386_972_287_526_154;
    const DEPOSIT: NearToken = NearToken::from_millinear(10);

    fn s3_measurements() -> FullMeasurementsHex {
        near_sdk::serde_json::from_value(near_sdk::serde_json::json!({
            "rtmrs": {
                "mrtd": "7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173",
                "rtmr0": "68102e7b524af310f7b7d426ce75481e36c40f5d513a9009c046e9d37e31551f0134d954b496a3357fd61d03f07ffe96",
                "rtmr1": "4ae609807c765916a31d724786ed74bcb97e168a9d937b04936aeef2015c907eba5ac352c6bcd749c246fd62ffb659ec",
                "rtmr2": "764489f277a8540189761e72b4238ba36d4d647e11bd958d8ab5522af2a4867b0ff63e06b0c4967f1857236244040a5d"
            },
            "key_provider_event_digest": "1de9cfa982eab350c1c6719fed6f35f9be554d202c26d354e498b0b9e6ad2e6e1e02df3abfa85bd8113c9ea219c16deb",
            "app_compose_hash_payload": "b4e628a4eb5c3fb110c32b15efa4769e7fd58e74665ad2120841233b02a0620f"
        }))
        .unwrap()
    }

    fn s3_ppid() -> Ppid {
        near_sdk::serde_json::from_value(near_sdk::serde_json::json!("62d54040cb9dfc08bb13006fa75ece56")).unwrap()
    }

    fn s3_attestation() -> DstackAttestation {
        near_sdk::serde_json::from_str(S3_ATTESTATION).unwrap()
    }

    fn call(pred: &str, ts: u64, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(pred.parse().unwrap())
            .block_timestamp(ts)
            .attached_deposit(deposit)
            .build());
    }

    /// Owner proposes a day before the S3 call and approves just before it.
    fn approve_s3(c: &mut Contract, measurements: bool, ppid: bool) {
        let proposed = S3_TS_NS - DAY_NS - 60_000_000_000;
        ctx("owner.testnet", proposed);
        if measurements {
            c.propose_measurements(s3_measurements());
        }
        if ppid {
            c.propose_ppids(vec![s3_ppid()]);
        }
        ctx("owner.testnet", proposed + DAY_NS);
        if measurements {
            c.approve_measurements(s3_measurements());
        }
        if ppid {
            c.approve_ppids(vec![s3_ppid()]);
        }
    }

    fn registered_s3() -> Contract {
        let mut c = setup();
        approve_s3(&mut c, true, true);
        call(S3_AGENT, S3_TS_NS, DEPOSIT);
        c.register_agent(s3_attestation());
        c
    }

    #[test]
    fn real_tee_agent_registers_and_can_act() {
        let mut c = registered_s3();
        let a = c.get_agent(S3_AGENT.parse().unwrap()).expect("registered");
        assert_eq!(a.measurements, s3_measurements());
        assert_eq!(a.ppid, s3_ppid());
        assert_eq!(a.valid_until_ms.0, S3_TS_NS / 1_000_000 + ATTESTATION_TTL_MS);
        event("agent_registered");
        call(S3_AGENT, S3_TS_NS + 1_000, NearToken::from_yoctonear(0));
        c.log_attempt_roots(1, vec![(0, "root".into())]);
        assert_eq!(c.get_roots(1).len(), 1);
    }

    #[test]
    #[should_panic(expected = "ERR_ATTESTATION")]
    fn register_rejects_unapproved_measurements() {
        let mut c = setup();
        approve_s3(&mut c, false, true);
        call(S3_AGENT, S3_TS_NS, DEPOSIT);
        c.register_agent(s3_attestation());
    }

    #[test]
    #[should_panic(expected = "ERR_ATTESTATION")]
    fn register_rejects_unapproved_ppid() {
        let mut c = setup();
        approve_s3(&mut c, true, false);
        call(S3_AGENT, S3_TS_NS, DEPOSIT);
        c.register_agent(s3_attestation());
    }

    #[test]
    #[should_panic(expected = "ERR_ATTESTATION")]
    fn attestation_cannot_be_reused_by_another_account() {
        let mut c = setup();
        approve_s3(&mut c, true, true);
        // The quote binds the S3 agent's account in its report data.
        call(&"ab".repeat(32), S3_TS_NS, DEPOSIT);
        c.register_agent(s3_attestation());
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_IMPLICIT_ACCOUNT")]
    fn named_account_cannot_register() {
        let mut c = setup();
        approve_s3(&mut c, true, true);
        call("agent.testnet", S3_TS_NS, DEPOSIT);
        c.register_agent(s3_attestation());
    }

    #[test]
    #[should_panic(expected = "ERR_STORAGE_DEPOSIT")]
    fn first_registration_needs_storage_deposit() {
        let mut c = setup();
        approve_s3(&mut c, true, true);
        call(S3_AGENT, S3_TS_NS, NearToken::from_yoctonear(0));
        c.register_agent(s3_attestation());
    }

    #[test]
    fn renewal_needs_no_deposit() {
        // A function-call key cannot attach a deposit, and the agent renews with one.
        let mut c = registered_s3();
        call(S3_AGENT, S3_TS_NS + 1_000_000_000, NearToken::from_yoctonear(0));
        c.register_agent(s3_attestation());
        let a = c.get_agent(S3_AGENT.parse().unwrap()).unwrap();
        assert_eq!(a.valid_until_ms.0, (S3_TS_NS + 1_000_000_000) / 1_000_000 + ATTESTATION_TTL_MS);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_TIER_AGENT")]
    fn expired_registration_cannot_act() {
        let mut c = registered_s3();
        call(S3_AGENT, S3_TS_NS + (ATTESTATION_TTL_MS + 1) * 1_000_000, NearToken::from_yoctonear(0));
        c.log_attempt_roots(1, vec![]);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_TIER_AGENT")]
    fn removing_measurements_revokes_agent_at_once() {
        let mut c = registered_s3();
        ctx("owner.testnet", S3_TS_NS + 1_000);
        c.remove_measurements(s3_measurements());
        call(S3_AGENT, S3_TS_NS + 2_000, NearToken::from_yoctonear(0));
        c.log_attempt_roots(1, vec![]);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_TIER_AGENT")]
    fn removing_ppid_revokes_agent_at_once() {
        let mut c = registered_s3();
        ctx("owner.testnet", S3_TS_NS + 1_000);
        c.remove_ppids(vec![s3_ppid()]);
        call(S3_AGENT, S3_TS_NS + 2_000, NearToken::from_yoctonear(0));
        c.log_attempt_roots(1, vec![]);
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
        c.propose_measurements(mock());
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
        c.register_agent_stub(AGENT.parse().unwrap());
        ctx(AGENT, 1_000);
        c
    }

    fn utxo(value: u64) -> Utxo {
        Utxo { txid: TXID.into(), vout: 0, value_sat: value }
    }

    fn btc(value: u64) -> ReleasePayload {
        ReleasePayload::Bitcoin { utxos: vec![utxo(value)], fee_rate_sat_vb: 5 }
    }

    fn base(amount: u128) -> ReleasePayload {
        ReleasePayload::Base {
            nonce: 3,
            max_fee_per_gas: U128(1_000_000_000),
            max_priority_fee_per_gas: U128(1_000_000),
            gas_limit: 80_000,
            usdc_amount: U128(amount),
        }
    }

    /// The last EVENT_JSON log with this event name, parsed.
    fn event(name: &str) -> near_sdk::serde_json::Value {
        near_sdk::test_utils::get_logs()
            .iter()
            .rev()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
            .find(|v| v["event"] == name)
            .unwrap_or_else(|| panic!("no {name} event"))
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
    fn registered_agent_with_unapproved_measurements_rejected() {
        let mut c = ready();
        ctx("owner.testnet", 1_000);
        c.register_agent_unapproved_for_test("other.testnet".parse().unwrap());
        ctx("other.testnet", 1_000);
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
    }

    #[test]
    fn second_approved_agent_can_release() {
        let mut c = ready();
        ctx("owner.testnet", 1_000);
        c.register_agent_stub("agent2.testnet".parse().unwrap());
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
        c.configure_tier(1, Chain::Bitcoin, "p".into(), TIER_ADDR.into(), U128(100_000), 3600, 1, None);
        c.register_agent_stub(AGENT.parse().unwrap());
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

    // ---- payout transactions (Task 4) ----

    #[test]
    fn sign_request_matches_mpc_wire_format() {
        // Shape from the v1.signer README: payload_v2 tagged Ecdsa, hex, domain 0 = secp256k1.
        let r = SignRequest::ecdsa(&[0x52; 32], "bulkhead-tier-1".into());
        let want = near_sdk::serde_json::json!({
            "payload_v2": {"Ecdsa": "52".repeat(32)},
            "path": "bulkhead-tier-1",
            "domain_id": 0
        });
        assert_eq!(near_sdk::serde_json::to_value(&r).unwrap(), want);
    }

    #[test]
    fn release_stores_the_real_bitcoin_payout() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        let (_, tx) = btc::build_payout(&[utxo(50_000)], TIER_ADDR, BTC_TO, 5).unwrap();
        assert_eq!(c.get_pending_tx("a1".into()), Some(hex::encode(tx)));
    }

    #[test]
    fn release_signs_the_bitcoin_sighash() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        let (sighash, _) = btc::build_payout(&[utxo(50_000)], TIER_ADDR, BTC_TO, 5).unwrap();
        assert_eq!(event("release_requested")["data"]["payload"], hex::encode(sighash));
    }

    #[test]
    #[should_panic(expected = "ERR_FEE_TOO_HIGH")]
    fn builder_error_rejects_release() {
        let mut c = ready();
        let p = ReleasePayload::Bitcoin { utxos: vec![utxo(50_000)], fee_rate_sat_vb: 201 };
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), p);
    }

    #[test]
    fn release_signed_event_carries_unsigned_tx_and_signature() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        let hex_tx = c.get_pending_tx("a1".into()).unwrap();
        signed(&mut c, 2_000, true);
        let e = event("release_signed");
        assert_eq!(e["standard"], "bulkhead");
        assert_eq!(e["data"]["attempt_id"], "a1");
        assert_eq!(e["data"]["unsigned_tx_hex"], hex_tx);
        assert_eq!(e["data"]["signature"]["recovery_id"], 0);
    }

    #[test]
    fn signer_failure_clears_pending_tx() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        signed(&mut c, 2_000, false);
        assert_eq!(c.get_pending_tx("a1".into()), None);
    }

    #[test]
    #[should_panic(expected = "ERR_DUP_ATTEMPT")]
    fn signed_attempt_id_cannot_be_reused() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        signed(&mut c, 2_000, true);
        ctx(AGENT, 2_000 + 3600 * 1_000_000_000);
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_ATTEMPT_ID")]
    fn attempt_id_cannot_inject_event_json() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1\",\"event\":\"drained".into(), BTC_TO.into(), btc(50_000));
    }

    #[test]
    #[should_panic(expected = "ERR_TIER_NOT_P2WPKH")]
    fn bitcoin_tier_address_must_be_p2wpkh() {
        let mut c = setup();
        let p2wsh = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
        c.configure_tier(1, Chain::Bitcoin, "p".into(), p2wsh.into(), U128(1), 1, 1, None);
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_BTC_ADDR")]
    fn bitcoin_tier_address_must_match_network() {
        let mut c = setup();
        c.configure_tier(1, Chain::Bitcoin, "p".into(), "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq".into(), U128(1), 1, 1, None);
    }

    #[test]
    #[should_panic(expected = "ERR_EVM_CONFIG")]
    fn base_tier_needs_evm_config() {
        let mut c = setup();
        c.configure_tier(2, Chain::Base, "p".into(), EVM_TO.into(), U128(1), 1, 1, None);
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_CHAIN_ID")]
    fn base_mainnet_chain_id_rejected_on_testnet_vault() {
        let mut c = setup();
        let evm = EvmTier { chain_id: 8453, usdc: USDC_SEPOLIA.into() };
        c.configure_tier(2, Chain::Base, "p".into(), EVM_TO.into(), U128(1), 1, 1, Some(evm));
    }

    #[test]
    fn release_stores_the_real_base_usdc_transfer() {
        let mut c = setup();
        base_tier(&mut c, 2);
        c.register_agent_stub(AGENT.parse().unwrap());
        ctx(AGENT, 1_000);
        let _ = c.release_funds(2, "b1".into(), EVM_TO.into(), base(20_000_000));
        let (sighash, tx) =
            evm::build_usdc_transfer(84532, 3, 1_000_000_000, 1_000_000, 80_000, USDC_SEPOLIA, EVM_TO, 20_000_000).unwrap();
        assert_eq!(c.get_pending_tx("b1".into()), Some(hex::encode(tx)));
        assert_eq!(event("release_requested")["data"]["payload"], hex::encode(sighash));
    }

    #[test]
    #[should_panic(expected = "ERR_OVER_CAP")]
    fn base_over_cap_rejected() {
        let mut c = setup();
        base_tier(&mut c, 2);
        c.register_agent_stub(AGENT.parse().unwrap());
        ctx(AGENT, 1_000);
        let _ = c.release_funds(2, "b1".into(), EVM_TO.into(), base(50_000_001));
    }

    // ---- emergency withdraw (Task 4, E14) ----

    const WITHDRAW_TO: &str = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";

    fn withdraw_ready() -> Contract {
        let mut c = setup();
        tier(&mut c, 1);
        c.propose_emergency_withdraw(1, WITHDRAW_TO.into());
        ctx("owner.testnet", DAY_NS);
        c
    }

    #[test]
    fn emergency_withdraw_signs_one_utxo_ignoring_cap() {
        let mut c = withdraw_ready();
        // Above max_release (100_000): the cap binds the agent, not the timelocked owner.
        let _ = c.execute_emergency_withdraw(1, btc(5_000_000));
        let id = event("withdraw_requested")["data"]["withdraw_id"].as_str().unwrap().to_string();
        let (sighash, tx) = btc::build_payout(&[utxo(5_000_000)], TIER_ADDR, WITHDRAW_TO, 5).unwrap();
        assert_eq!(c.get_pending_tx(id), Some(hex::encode(tx)));
        assert_eq!(event("withdraw_requested")["data"]["payload"], hex::encode(sighash));
    }

    #[test]
    fn emergency_withdraw_proposal_stays_for_the_next_utxo() {
        let mut c = withdraw_ready();
        let _ = c.execute_emergency_withdraw(1, btc(5_000_000));
        assert_eq!(c.pending_owner_actions().len(), 1);
    }

    #[test]
    #[should_panic(expected = "ERR_TIMELOCK")]
    fn emergency_withdraw_execute_before_24h_panics() {
        let mut c = setup();
        tier(&mut c, 1);
        c.propose_emergency_withdraw(1, WITHDRAW_TO.into());
        ctx("owner.testnet", DAY_NS - 1);
        let _ = c.execute_emergency_withdraw(1, btc(5_000_000));
    }

    #[test]
    fn withdraw_id_is_never_a_valid_attempt_id() {
        let mut c = withdraw_ready();
        let _ = c.execute_emergency_withdraw(1, btc(5_000_000));
        let id = event("withdraw_requested")["data"]["withdraw_id"].as_str().unwrap().to_string();
        assert_eq!(id, "withdraw:1:0");
    }

    fn withdraw_signed(c: &mut Contract, id: &str, ok: bool) -> Option<SignatureResponse> {
        ctx("vault.testnet", DAY_NS);
        let r = match ok {
            true => Ok(SignatureResponse { big_r: Default::default(), s: Default::default(), recovery_id: 0 }),
            false => Err(near_sdk::PromiseError::Failed),
        };
        c.on_withdraw_signed(id.into(), r)
    }

    #[test]
    fn withdraw_signed_event_carries_unsigned_tx() {
        let mut c = withdraw_ready();
        let _ = c.execute_emergency_withdraw(1, btc(5_000_000));
        let hex_tx = c.get_pending_tx("withdraw:1:0".into()).unwrap();
        assert!(withdraw_signed(&mut c, "withdraw:1:0", true).is_some());
        let e = event("withdraw_signed");
        assert_eq!(e["data"]["withdraw_id"], "withdraw:1:0");
        assert_eq!(e["data"]["unsigned_tx_hex"], hex_tx);
    }

    #[test]
    fn withdraw_signer_failure_clears_pending_tx() {
        let mut c = withdraw_ready();
        let _ = c.execute_emergency_withdraw(1, btc(5_000_000));
        assert!(withdraw_signed(&mut c, "withdraw:1:0", false).is_none());
        assert_eq!(c.get_pending_tx("withdraw:1:0".into()), None);
        assert_eq!(event("withdraw_failed")["data"]["withdraw_id"], "withdraw:1:0");
    }

    // ---- configure_tier guards (code review) ----

    #[test]
    #[should_panic(expected = "ERR_BAD_ROUNDS")]
    fn zero_rounds_rejected() {
        let mut c = setup();
        c.configure_tier(1, Chain::Bitcoin, "p".into(), TIER_ADDR.into(), U128(1), 1, 0, None);
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_COOLDOWN")]
    fn cooldown_over_30_days_rejected() {
        let mut c = setup();
        c.configure_tier(1, Chain::Bitcoin, "p".into(), TIER_ADDR.into(), U128(1), 30 * 24 * 3600 + 1, 1, None);
    }

    #[test]
    #[should_panic(expected = "ERR_TIER_NOT_OPEN")]
    fn releasing_tier_cannot_be_reconfigured() {
        let mut c = ready();
        let _ = c.release_funds(1, "a1".into(), BTC_TO.into(), btc(50_000));
        ctx("owner.testnet", 2_000);
        tier(&mut c, 1);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn agent_cannot_execute_emergency_withdraw() {
        let mut c = withdraw_ready();
        c.register_agent_stub(AGENT.parse().unwrap());
        ctx(AGENT, DAY_NS);
        let _ = c.execute_emergency_withdraw(1, btc(5_000_000));
    }
}
