//! jenny-file-access: confined file access for a Jenny team host on Windows.
//!
//! The Python sidecar loads this library and calls the `jfa_` exports. The
//! interface is frozen in `abi.json` beside the crate; the design and its
//! boundary rules are in `docs/plans/TEAM_WINDOWS_FILE_ACCESS_SPEC.md`.
//!
//! The library reads no environment variable, writes nothing to standard
//! output and formats no name or path into a message. The lints below keep a
//! panic's line on standard error to a source location.
//!
//! `unsafe` appears only in `ffi.rs` and the `win::sys` module (`win/sys.rs`
//! and its child `win/sys/file.rs`); every other module that can forbids it.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::unreachable,
    clippy::todo,
    clippy::unimplemented
)]

pub mod abi;
pub mod ffi;
pub mod listing;
pub mod names;
pub mod pins;

#[cfg(not(windows))]
pub mod stub;

#[cfg(windows)]
pub mod win {
    pub mod dir;
    pub mod policy;
    pub mod root;
    pub mod sys;
    pub mod walk;
    pub mod write;
}

#[cfg(windows)]
pub use ffi::exports::*;
#[cfg(not(windows))]
pub use stub::*;
