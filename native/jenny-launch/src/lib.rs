//! `jenny-launch`: the native owned-process bootstrap child.
//!
//! The Jenny sidecar creates a Job Object, starts this program inside it, and
//! only then writes one framed request to its stdin. This program validates
//! the request, starts the real target (which is therefore born inside the
//! Job), waits, and exits with the target's exit code. The wire contract is
//! defined by `sidecar/_owned_process_bootstrap.py`.

#![deny(unsafe_op_in_unsafe_fn)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

pub mod cmdline;
pub mod payload;

#[cfg(windows)]
mod handles;
#[cfg(windows)]
mod spawn;

use std::ffi::OsString;
use std::io::Write;

/// Exit code for a bad command line or a rejected control payload.
pub const EXIT_REJECTED: i32 = 125;
/// Exit code when the target could not be started or fed its input.
pub const EXIT_LAUNCH_FAILED: i32 = 126;

pub const MSG_REJECTED: &str = "owned process bootstrap rejected control payload";
pub const MSG_LAUNCH_FAILED: &str = "owned process bootstrap target launch failed";
pub const MSG_INPUT_FAILED: &str = "owned process bootstrap target input failed";

const VERSION_LINE: &str = "jenny-launch protocol 1\n";
const BOOTSTRAP_FLAG: &str = "--owned-process-bootstrap";

/// Write one diagnostic line (message plus CRLF, matching the Python child)
/// to stderr. A closed or broken stderr is ignored.
pub fn write_error_line(message: &str) {
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(message.as_bytes());
    let _ = stderr.write_all(b"\r\n");
    let _ = stderr.flush();
}

/// Run the program for the given arguments (program name first) and return
/// the process exit code.
pub fn run_cli<I>(args: I) -> i32
where
    I: IntoIterator<Item = OsString>,
{
    let rest: Vec<OsString> = args.into_iter().skip(1).collect();
    match rest.as_slice() {
        [flag] if flag == "--version" => {
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(VERSION_LINE.as_bytes());
            let _ = stdout.flush();
            0
        }
        [flag] if flag == BOOTSTRAP_FLAG => bootstrap(),
        _ => {
            write_error_line("usage: jenny-launch --owned-process-bootstrap | --version");
            EXIT_REJECTED
        }
    }
}

#[cfg(windows)]
fn bootstrap() -> i32 {
    match payload::read_request(&mut std::io::stdin().lock()) {
        Ok(request) => spawn::run(&request),
        Err(payload::Rejected) => {
            write_error_line(MSG_REJECTED);
            EXIT_REJECTED
        }
    }
}

#[cfg(not(windows))]
fn bootstrap() -> i32 {
    write_error_line("owned process bootstrap is only supported on Windows");
    EXIT_REJECTED
}
