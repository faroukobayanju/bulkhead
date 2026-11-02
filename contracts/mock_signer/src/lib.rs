//! Test double for v1.signer: checks the request the way the real contract
//! does, records it, and returns a fixed signature or panics on demand.
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, NearToken};

#[near(contract_state)]
#[derive(Default)]
pub struct Mock {
    fail: bool,
    last: Option<String>,
}

#[near]
impl Mock {
    pub fn fail_next(&mut self) {
        self.fail = true;
    }

    /// Wire format from the near/mpc contract README: 1 yoctoNEAR deposit,
    /// `payload_v2: {"Ecdsa": <32 bytes hex>}`, domain 0 for secp256k1.
    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "MOCK_NO_DEPOSIT");
        let payload = request["payload_v2"]["Ecdsa"].as_str().unwrap_or_default();
        require!(payload.len() == 64 && payload.bytes().all(|b| b.is_ascii_hexdigit()), "MOCK_BAD_PAYLOAD");
        require!(request["domain_id"] == 0 && request["path"].is_string(), "MOCK_BAD_REQUEST");
        if self.fail {
            env::panic_str("MOCK_FAIL");
        }
        self.last = Some(request.to_string());
        json!({
            "scheme": "Secp256k1",
            "big_r": {"affine_point": format!("02{}", "aa".repeat(32))},
            "s": {"scalar": "bb".repeat(32)},
            "recovery_id": 0
        })
    }

    pub fn last_request(&self) -> Option<String> {
        self.last.clone()
    }
}
