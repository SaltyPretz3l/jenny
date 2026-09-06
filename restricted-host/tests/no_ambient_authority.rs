#[test]
fn crate_has_no_wasi_dependency_or_ambient_imports() {
    let manifest = include_str!("../Cargo.toml");
    let wit = include_str!("../../config/plugins/capability-abi/v1/jenny-restricted-host.wit");
    assert!(!manifest.contains("wasmtime-wasi"));
    for forbidden in [
        "wasi:",
        "filesystem",
        "environment",
        "random",
        "subprocess",
        "socket",
    ] {
        assert!(
            !wit.contains(forbidden),
            "forbidden ambient ABI word: {forbidden}"
        );
    }
}
