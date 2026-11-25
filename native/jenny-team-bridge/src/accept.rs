//! The host's accept loop: the retry for an unproven source, then the handshake slots and the
//! admission tables before any handshake is spent (`docs/plans/TEAM_INTERNET_SPEC.md`, I7).

use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::{Incoming, IncomingAddr};
use iroh::Endpoint;
use tokio::sync::watch;
use tokio::task::JoinSet;

use crate::admission::slots_full;
use crate::host::{stopping, Shared, SHUTDOWN_GRACE};
use crate::host_conn;

/// How long a handshake may hold one of the handshake slots.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) async fn accept_loop(
    shared: Arc<Shared>,
    endpoint: Endpoint,
    mut stop: watch::Receiver<bool>,
) {
    let mut connections = JoinSet::new();
    loop {
        let stop_for_task = stop.clone();
        tokio::select! {
            biased;
            _ = stopping(&mut stop) => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { break };
                // A source that has not proved its address costs one round trip and no slot,
                // so spoofed Initials cannot hold the handshake slots.
                let incoming = if incoming.remote_addr_validated() {
                    incoming
                } else {
                    // noq refuses a retry only for a source already validated by a retry token
                    // (`noq-proto-1.4.0/src/endpoint.rs:751-758`, `:1290-1294`): unreachable here.
                    if let Err(error) = incoming.retry() {
                        error.into_incoming().ignore();
                    }
                    continue;
                };
                // Counted only once the source is validated, so a spoofed address cannot
                // spend a real member's rate.
                let remote = incoming.remote_addr();
                let (admitted, relayed_share) = {
                    let mut state = shared.lock();
                    let now = std::time::Instant::now();
                    let max = shared.limits.max_handshakes;
                    // A relayed dial claiming a known key holds no slot of the relayed share
                    // (review C3): strangers stalling relayed handshakes cannot lock it out.
                    let relayed_share = matches!(remote, IncomingAddr::Relay { .. })
                        && !state.admission.is_known_relayed(&remote);
                    let full = if relayed_share {
                        slots_full(&remote, state.handshakes, state.relayed_handshakes, max)
                    } else {
                        state.handshakes >= max
                    };
                    let go = !state.stopping && state.admission.before_handshake(&remote, full, now);
                    if go {
                        state.handshakes += 1;
                        if relayed_share {
                            state.relayed_handshakes += 1;
                        }
                    } else if full && !state.stopping {
                        state.refused_connections += 1;
                        shared.publish(&state);
                    }
                    (go, relayed_share)
                };
                if !admitted {
                    // Ignored, not refused: a refusal would read as host_refused to a member.
                    // The summary line counts it.
                    incoming.ignore();
                    continue;
                }
                let task = handshake(shared.clone(), incoming, relayed_share, stop_for_task);
                connections.spawn(task);
            }
        }
    }
    // Every live connection has its Close signal; give each a bounded time to report.
    let drained = tokio::time::timeout(SHUTDOWN_GRACE, async {
        while connections.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        connections.shutdown().await;
    }
}

/// Holds one handshake slot (and, for a relayed connection of a key not known, one of the
/// relayed share) until dropped.
struct HandshakeSlot {
    shared: Arc<Shared>,
    relayed: bool,
}

impl Drop for HandshakeSlot {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        state.handshakes = state.handshakes.saturating_sub(1);
        if self.relayed {
            state.relayed_handshakes = state.relayed_handshakes.saturating_sub(1);
        }
    }
}

/// Finishes the handshake (a failed one is a connection that never existed), then runs
/// the connection. The caller already counted the handshake slot.
pub(crate) async fn handshake(
    shared: Arc<Shared>,
    incoming: Incoming,
    relayed: bool,
    mut stop: watch::Receiver<bool>,
) {
    let slot = HandshakeSlot {
        shared: shared.clone(),
        relayed,
    };
    let conn = tokio::select! {
        biased;
        _ = stopping(&mut stop) => None,
        conn = tokio::time::timeout(HANDSHAKE_TIMEOUT, incoming) => conn.ok().and_then(Result::ok),
    };
    drop(slot);
    if let Some(conn) = conn {
        host_conn::run_connection(shared, conn).await;
    }
}
