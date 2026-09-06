use sha2::{Digest, Sha256};

#[test]
fn capability_abi_matches_frozen_lock() {
    let wit = include_bytes!("../../config/plugins/capability-abi/v1/jenny-restricted-host.wit");
    assert_eq!(
        hex::encode(Sha256::digest(wit)),
        "91b7c4c28018ec2f45d60a5473869324a5532e965cbe517de9f7400227a4bae8"
    );
}
