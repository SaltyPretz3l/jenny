//! Helpers every test file shares. What needs Windows is in `win.rs`.
#![allow(dead_code, unused_imports)] // Each test file uses its own part.

use std::io::Write;

use serde_json::Value;

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::*;

pub const ABI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/abi.json");

pub fn read_json(path: &str) -> Value {
    let text = std::fs::read_to_string(path).expect("the file is readable");
    serde_json::from_str(&text).expect("the file is JSON")
}

pub fn units_of(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// One line straight to standard error, which the test harness does not
/// capture: `SKIPPED <test>: <why>` for a test that did not run its body.
pub fn note(kind: &str, subject: &str, text: &str) {
    let _ = writeln!(std::io::stderr(), "{kind} {subject}: {text}");
}

pub fn skipped(test: &str, reason: &str) {
    note("SKIPPED", test, reason);
}
