//! Test double for v1.signer: returns a fixed signature, or panics on demand.
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near};

#[near(contract_state)]
#[derive(Default)]
pub struct Mock {
    fail: bool,
}

#[near]
impl Mock {
    pub fn fail_next(&mut self) {
        self.fail = true;
    }

    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        let _ = request;
        if self.fail {
            env::panic_str("MOCK_FAIL");
        }
        json!({"big_r": {"affine_point": "02aa"}, "s": {"scalar": "bb"}, "recovery_id": 0})
    }
}
