//! The built binary: its version line, its usage exit and one `--serve` session over real pipes.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::io::Write;
use std::process::{Command, Stdio};

const HELPER: &str = env!("CARGO_BIN_EXE_jenny-computer");

#[test]
fn version_prints_the_exact_line() {
    let out = Command::new(HELPER).arg("--version").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        "jenny-computer protocol 1\n"
    );
}

#[test]
fn unknown_arguments_exit_125() {
    let out = Command::new(HELPER).arg("--nope").output().unwrap();
    assert_eq!(out.status.code(), Some(125));
    assert!(out.stdout.is_empty());
}

#[test]
fn serve_answers_over_pipes_and_exits_on_shutdown() {
    let mut child = Command::new(HELPER)
        .arg("--serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    {
        let stdin = child.stdin.as_mut().unwrap();
        stdin
            .write_all(b"{\"id\":1,\"op\":\"hello\"}\n{\"id\":2,\"op\":\"input.click\"}\n{\"id\":3,\"op\":\"shutdown\"}\n")
            .unwrap();
    }
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let text = String::from_utf8(out.stdout).unwrap();
    let lines: Vec<serde_json::Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["result"]["available"], cfg!(windows));
    // With the input feature the bare click is refused for its missing guard, before any input.
    let expected = if !cfg!(windows) {
        "not_available"
    } else if cfg!(feature = "input") {
        "bad_request"
    } else {
        "not_built"
    };
    assert_eq!(lines[1]["error"]["code"], expected);
    assert_eq!(lines[2]["id"], 3);
}
