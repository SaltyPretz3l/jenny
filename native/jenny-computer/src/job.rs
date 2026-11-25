//! Runs: a program started suspended in a kill-on-close job, its window followed by events,
//! stopped by close-then-end. Built by lane H1 (row 197).

// Pure logic, tested on every platform; only the Windows build calls it.
#[cfg_attr(not(windows), allow(dead_code))]
mod cmdline;
#[cfg_attr(not(windows), allow(dead_code))]
mod window_events;

#[cfg(windows)]
mod handle;
#[cfg(windows)]
mod hook;
#[cfg(windows)]
mod jobobject;
#[cfg(windows)]
mod monitor;
#[cfg(windows)]
mod run;
#[cfg(windows)]
mod runs;
#[cfg(windows)]
mod spawn;

#[cfg(windows)]
pub use runs::Runs;

pub const BUILT: bool = true;

/// Off Windows nothing runs: every operation is answered `not_available` before it gets here.
#[cfg(not(windows))]
pub use other::Runs;

#[cfg(not(windows))]
mod other {
    use serde_json::Value;

    use crate::events::Emitter;
    use crate::protocol::{ProtoError, Request};

    pub struct Runs {
        _emitter: Emitter,
    }

    impl Runs {
        pub fn new(emitter: Emitter) -> Self {
            Self { _emitter: emitter }
        }

        pub fn job_pids(&self, _run_id: &str) -> Result<Vec<u32>, ProtoError> {
            Err(ProtoError::not_available())
        }

        pub fn start(&mut self, _req: &Request) -> Result<Value, ProtoError> {
            Err(ProtoError::not_available())
        }

        pub fn start_monitors(&mut self) {}

        pub fn stop(&mut self, _req: &Request) -> Result<Value, ProtoError> {
            Err(ProtoError::not_available())
        }

        pub fn close(&mut self, _req: &Request) -> Result<Value, ProtoError> {
            Err(ProtoError::not_available())
        }

        pub fn output(&mut self, _req: &Request) -> Result<Value, ProtoError> {
            Err(ProtoError::not_available())
        }

        pub fn list(&mut self) -> Result<Value, ProtoError> {
            Err(ProtoError::not_available())
        }

        pub fn shutdown_all(&mut self) {}

        pub fn end_all_now(&mut self) {}
    }
}
