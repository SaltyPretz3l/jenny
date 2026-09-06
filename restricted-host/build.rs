use std::{env, fs, path::PathBuf};

fn main() {
    println!(
        "cargo:rerun-if-changed=../config/plugins/capability-abi/v1/jenny-restricted-host.wit"
    );
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let wit = fs::read("../config/plugins/capability-abi/v1/jenny-restricted-host.wit")
        .expect("read frozen capability ABI");
    fs::write(out.join("capability-abi.wit"), wit).expect("copy frozen capability ABI");
}
