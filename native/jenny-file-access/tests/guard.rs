//! A panic inside an export body returns `internal` and does not unwind across
//! the boundary; the backend then stays off for the rest of the process.
//!
//! No export-reachable hook can panic, so the tests run the export guard with
//! a body that does. Two tests use a latch of their own. One test trips the
//! process's latch and then calls the real exports; it is the only test in
//! this file that touches that latch.

use std::sync::atomic::AtomicBool;

use jenny_file_access::abi::Status;
use jenny_file_access::ffi::{guard, guard_value, guard_with, latched};

#[test]
fn a_panic_becomes_internal_and_later_bodies_never_run() {
    let latch = AtomicBool::new(false);
    // Before any panic a body's status passes through.
    assert_eq!(guard_with(&latch, || Status::Ok), Status::Ok.code());
    assert_eq!(
        guard_with(&latch, || Status::PathRefused),
        Status::PathRefused.code()
    );

    // The call returns: the panic did not unwind out of the guard.
    let status = guard_with(&latch, || panic!("a panic inside an export body"));
    assert_eq!(status, Status::Internal.code());

    let mut ran = false;
    let later = guard_with(&latch, || {
        ran = true;
        Status::Ok
    });
    assert_eq!(later, Status::Internal.code());
    assert!(!ran, "a body ran after the latch");
}

/// A poisoned table lock reaches the guard as the `internal` status, and
/// latches the backend off exactly as a panic does.
#[test]
fn a_body_that_reports_internal_latches_too() {
    let latch = AtomicBool::new(false);
    assert_eq!(
        guard_with(&latch, || Status::InvalidArgument),
        Status::InvalidArgument.code()
    );
    assert_eq!(
        guard_with(&latch, || Status::Internal),
        Status::Internal.code()
    );
    assert_eq!(
        guard_with(&latch, || Status::Ok),
        Status::Internal.code(),
        "latched"
    );
}

/// Tests always unwind, so nothing above sees the release profile. The guard
/// catches nothing in a library built to abort, and both sibling crates are.
#[test]
fn the_release_profile_unwinds() {
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    let text = std::fs::read_to_string(manifest).expect("Cargo.toml is readable");
    let release: Vec<&str> = text
        .lines()
        .map(str::trim)
        .skip_while(|&line| line != "[profile.release]")
        .skip(1)
        .take_while(|line| !line.starts_with('['))
        .filter(|line| line.starts_with("panic"))
        .collect();
    assert_eq!(release, [r#"panic = "unwind""#]);
}

#[test]
fn the_exports_fail_closed_after_a_panic_in_this_process() {
    assert!(!latched());
    assert_eq!(guard_value(|| 7), 7);
    // Before the panic: Windows refuses the token, the stub refuses the platform.
    let before = if cfg!(windows) {
        Status::InvalidArgument
    } else {
        Status::PlatformUnsupported
    };
    assert_eq!(jenny_file_access::jfa_pin_close(0), before.code());

    assert_eq!(
        guard(|| panic!("a panic inside an export body")),
        Status::Internal.code()
    );
    assert!(latched());

    // The real exports answer `internal` now, whatever they are given.
    assert_eq!(jenny_file_access::jfa_pin_close(0), Status::Internal.code());
    assert_eq!(
        jenny_file_access::jfa_file_check(0),
        Status::Internal.code()
    );

    // A panic in a number-returning export gives a value no caller accepts.
    assert_eq!(
        guard_value(|| panic!("a panic inside a number-returning export")),
        u32::MAX
    );
    assert_eq!(
        jenny_file_access::jfa_abi_version(),
        1,
        "the version is still readable"
    );
}
