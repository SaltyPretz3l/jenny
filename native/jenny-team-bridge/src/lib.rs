//! Jenny's team transport bridge: iroh host and member modes behind a line-JSON control
//! channel on standard input and output. The control channel, lifecycle and limits are
//! specified in `docs/plans/TEAM_MEMBERSHIP_SPEC.md`, section "1d-R slice spec".

use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncBufRead;
use tokio::sync::mpsc;

mod accept;
pub mod admission;
mod bulk;
pub mod control;
mod host;
mod host_conn;
mod key_share;
mod member;
mod member_dial;
pub mod messages;
mod pipe;
pub mod portmap;
pub mod preamble;
mod relay;

pub use host::run_host_with;
pub use member::run_member_with;

/// What `--version` prints.
pub const VERSION_LINE: &str = "jenny-team-bridge protocol 1";

/// How long the first line (`start`) may take.
pub const START_TIMEOUT: Duration = Duration::from_secs(10);

/// Process-level options that are not part of the control channel.
#[derive(Clone, Debug)]
pub struct RunOptions {
    /// How long `start` may take to arrive.
    pub start_timeout: Duration,
    /// Bind every socket to loopback only. A test seam: in-process tests use it so no
    /// socket listens on a real interface. Never set by the binary.
    pub loopback_only: bool,
    /// The port mapper used when `start` asks for one. A test seam: `None` (the binary)
    /// builds the real client, and only when the sockets are not loopback-only.
    pub mapper: Option<Arc<dyn portmap::Mapper>>,
    /// How the relay's certificate is checked. A test seam for the loopback test relay's
    /// self-signed certificate: `None` (the binary) checks it against the embedded roots.
    pub relay_tls: Option<iroh::tls::CaTlsConfig>,
    /// How long the host waits for its relay before it says `unreachable`. A test seam for a
    /// shorter wait; the binary uses the default, ten seconds.
    pub relay_unreachable_after: Duration,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            start_timeout: START_TIMEOUT,
            loopback_only: false,
            mapper: None,
            relay_tls: None,
            relay_unreachable_after: relay::UNREACHABLE_AFTER,
        }
    }
}

/// Runs host mode with the default options. Lines sent to `output` are compact JSON
/// without the terminator. Returns the process exit code.
pub async fn run_host(
    input: impl AsyncBufRead + Unpin + Send + 'static,
    output: mpsc::Sender<String>,
) -> i32 {
    run_host_with(input, output, RunOptions::default()).await
}

/// Runs member mode with the default options. Lines sent to `output` are compact JSON
/// without the terminator. Returns the process exit code.
pub async fn run_member(
    input: impl AsyncBufRead + Unpin + Send + 'static,
    output: mpsc::Sender<String>,
) -> i32 {
    run_member_with(input, output, RunOptions::default()).await
}
