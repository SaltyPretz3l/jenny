//! One host connection: handshake, admit question, streams, drain and close.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::{Connection, Incoming, RecvStream, SendStream};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::control::b64;
use crate::host::{stopping, ConnEntry, ConnSignal, Shared};
use crate::messages::AdmitKind;
use crate::pipe::{
    close_connection as close, closed, not_live, pipe, reset_stream, StreamMode, StreamSignal,
    CODE_CLOSED, CODE_REFUSED,
};
use crate::preamble::{encode_host, HOST_PREAMBLE_BYTES};

const CODE_STREAM_REFUSED: u32 = 2;
/// How long a handshake may hold one of the handshake slots.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// After a drained connection's streams are done, how long the peer gets to read them.
const DRAIN_LINGER: Duration = Duration::from_millis(250);
/// How long streams get to reset themselves at the drain deadline before they are aborted.
const RESET_SETTLE: Duration = Duration::from_millis(100);

/// Holds one handshake slot until dropped.
struct HandshakeSlot(Arc<Shared>);

impl Drop for HandshakeSlot {
    fn drop(&mut self) {
        let mut state = self.0.lock();
        state.handshakes = state.handshakes.saturating_sub(1);
    }
}

/// Holds one stream slot (per connection and in total) until dropped.
struct StreamSlot {
    shared: Arc<Shared>,
    conn: u64,
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        state.streams = state.streams.saturating_sub(1);
        if let Some(entry) = state.conns.get_mut(&self.conn) {
            entry.streams = entry.streams.saturating_sub(1);
        }
        self.shared.publish(&state);
    }
}

/// Finishes the handshake (a failed one is a connection that never existed), then runs
/// the connection. The caller already counted the handshake slot.
pub(crate) async fn handshake(
    shared: Arc<Shared>,
    incoming: Incoming,
    mut stop: watch::Receiver<bool>,
) {
    let slot = HandshakeSlot(shared.clone());
    let conn = tokio::select! {
        biased;
        _ = stopping(&mut stop) => None,
        conn = tokio::time::timeout(HANDSHAKE_TIMEOUT, incoming) => conn.ok().and_then(Result::ok),
    };
    drop(slot);
    if let Some(conn) = conn {
        run_connection(shared, conn).await;
    }
}

enum Registration {
    Stopping,
    Full(usize),
    Live(u64, watch::Receiver<ConnSignal>),
}

enum Decision {
    Admit(AdmitKind),
    Refuse,
    Close,
    PeerGone,
}

fn decision_of(signal: ConnSignal) -> Decision {
    match signal {
        ConnSignal::Admit(kind) => Decision::Admit(kind),
        ConnSignal::Close => Decision::Close,
        // Fail closed: anything else is a refusal.
        ConnSignal::Waiting | ConnSignal::Refuse | ConnSignal::Drain(_) => Decision::Refuse,
    }
}

async fn run_connection(shared: Arc<Shared>, conn: Connection) {
    let key = *conn.remote_id().as_bytes();
    let registration = {
        let mut state = shared.lock();
        let live = state.conns.len();
        if state.stopping {
            Registration::Stopping
        } else if live >= shared.limits.max_connections as usize {
            state.refused_connections += 1;
            shared.publish(&state);
            Registration::Full(live)
        } else {
            let id = state.next_conn;
            state.next_conn += 1;
            let (signal, receiver) = watch::channel(ConnSignal::Waiting);
            state.conns.insert(
                id,
                ConnEntry {
                    key,
                    signal,
                    streams: 0,
                },
            );
            shared.publish(&state);
            Registration::Live(id, receiver)
        }
    };
    let (id, mut signal) = match registration {
        Registration::Stopping => {
            close(&conn, CODE_CLOSED);
            return;
        }
        Registration::Full(live) => {
            shared
                .out
                .log(
                    "team.bridge.connection_refused",
                    json!({ "reason": "connection_cap", "connections": live }),
                )
                .await;
            close(&conn, CODE_CLOSED);
            return;
        }
        Registration::Live(id, receiver) => (id, receiver),
    };

    shared
        .out
        .send(json!({ "t": "admit", "conn": id, "key": b64(&key) }))
        .await;
    match await_decision(&shared, id, &conn, &mut signal).await {
        Decision::Admit(kind) => admitted(&shared, id, key, &conn, signal, kind).await,
        Decision::Refuse => {
            let others = {
                let mut state = shared.lock();
                state.refused_connections += 1;
                shared.publish(&state);
                state.conns.len().saturating_sub(1)
            };
            shared
                .out
                .log(
                    "team.bridge.connection_refused",
                    json!({ "reason": "not_admitted", "connections": others }),
                )
                .await;
            close(&conn, CODE_REFUSED);
        }
        Decision::Close => close(&conn, CODE_CLOSED),
        Decision::PeerGone => {}
    }
    {
        let mut state = shared.lock();
        state.conns.remove(&id);
        shared.publish(&state);
    }
    shared
        .out
        .send(json!({ "t": "conn_closed", "conn": id }))
        .await;
}

async fn await_decision(
    shared: &Shared,
    id: u64,
    conn: &Connection,
    signal: &mut watch::Receiver<ConnSignal>,
) -> Decision {
    let limit = Duration::from_millis(u64::from(shared.limits.admit_timeout_ms));
    let answered = tokio::select! {
        biased;
        answer = async {
            signal
                .wait_for(|value| *value != ConnSignal::Waiting)
                .await
                .map(|value| *value)
        } => Some(answer.unwrap_or(ConnSignal::Close)),
        _ = tokio::time::sleep(limit) => None,
        _ = conn.closed() => return Decision::PeerGone,
    };
    if let Some(answer) = answered {
        return decision_of(answer);
    }
    // Timed out: refuse, unless an answer won the race under the lock.
    let state = shared.lock();
    let Some(entry) = state.conns.get(&id) else {
        return Decision::Refuse;
    };
    entry.signal.send_if_modified(|value| {
        if *value != ConnSignal::Waiting {
            return false;
        }
        *value = ConnSignal::Refuse;
        true
    });
    let current = *entry.signal.borrow();
    decision_of(current)
}

enum End {
    Peer,
    Close,
    Drain(Instant),
}

async fn admitted(
    shared: &Arc<Shared>,
    id: u64,
    key: [u8; 32],
    conn: &Connection,
    mut signal: watch::Receiver<ConnSignal>,
    kind: AdmitKind,
) {
    let live = shared.lock().conns.len();
    shared
        .out
        .log(
            "team.bridge.connection_admitted",
            json!({ "kind": kind.as_str(), "connections": live }),
        )
        .await;
    let mut streams = JoinSet::new();
    let peer_closed = conn.closed();
    tokio::pin!(peer_closed);
    let end = loop {
        match *signal.borrow_and_update() {
            ConnSignal::Drain(deadline) => break End::Drain(deadline),
            ConnSignal::Close | ConnSignal::Refuse => break End::Close,
            ConnSignal::Waiting | ConnSignal::Admit(_) => {}
        }
        tokio::select! {
            biased;
            _ = &mut peer_closed => break End::Peer,
            changed = signal.changed() => {
                if changed.is_err() {
                    break End::Close;
                }
            }
            Some(_) = streams.join_next(), if !streams.is_empty() => {}
            pair = conn.accept_bi() => match pair {
                Ok((send, recv)) => {
                    accept_stream(shared, id, key, send, recv, &signal, &mut streams, false).await;
                }
                Err(_) => break End::Peer,
            },
        }
    };
    match end {
        End::Peer => {}
        End::Close => close(conn, CODE_CLOSED),
        End::Drain(deadline) => {
            let mut drain = Drain {
                shared,
                id,
                key,
                conn,
                signal: &mut signal,
                streams: &mut streams,
            };
            drain.run(deadline, peer_closed).await;
        }
    }
    // Whatever is left (peer gone, stop) is aborted; the slots uncount themselves.
    streams.shutdown().await;
}

struct Drain<'a> {
    shared: &'a Arc<Shared>,
    id: u64,
    key: [u8; 32],
    conn: &'a Connection,
    signal: &'a mut watch::Receiver<ConnSignal>,
    streams: &'a mut JoinSet<()>,
}

enum DrainEnd {
    AllDone,
    Deadline,
    Close,
    Peer,
}

impl Drain<'_> {
    /// Lets finished answers out: streams already stopped reading from the peer; wait for
    /// them to end, linger briefly, then close as refused. Bounded by `deadline`.
    async fn run<F: std::future::Future>(&mut self, deadline: Instant, peer_closed: F) {
        tokio::pin!(peer_closed);
        let end = loop {
            tokio::select! {
                biased;
                _ = &mut peer_closed => break DrainEnd::Peer,
                _ = closed(&mut *self.signal) => break DrainEnd::Close,
                _ = tokio::time::sleep_until(deadline) => break DrainEnd::Deadline,
                joined = self.streams.join_next() => {
                    if joined.is_none() {
                        break DrainEnd::AllDone;
                    }
                }
                pair = self.conn.accept_bi() => match pair {
                    Ok((send, recv)) => {
                        accept_stream(
                            self.shared,
                            self.id,
                            self.key,
                            send,
                            recv,
                            &*self.signal,
                            &mut *self.streams,
                            true,
                        )
                        .await;
                    }
                    Err(_) => break DrainEnd::Peer,
                },
            }
        };
        match end {
            DrainEnd::Peer => {}
            DrainEnd::Close => close(self.conn, CODE_CLOSED),
            DrainEnd::AllDone => {
                let linger = DRAIN_LINGER.min(deadline.saturating_duration_since(Instant::now()));
                tokio::select! {
                    biased;
                    _ = &mut peer_closed => return,
                    _ = closed(&mut *self.signal) => {
                        close(self.conn, CODE_CLOSED);
                        return;
                    }
                    _ = tokio::time::sleep(linger) => {}
                }
                close(self.conn, CODE_REFUSED);
            }
            DrainEnd::Deadline => {
                self.set_close();
                let streams = &mut *self.streams;
                let _ = tokio::time::timeout(RESET_SETTLE, async {
                    while streams.join_next().await.is_some() {}
                })
                .await;
                close(self.conn, CODE_REFUSED);
            }
        }
    }

    /// Tells every stream of this connection to reset now.
    fn set_close(&self) {
        let state = self.shared.lock();
        if let Some(entry) = state.conns.get(&self.id) {
            entry.signal.send_if_modified(|value| {
                if *value == ConnSignal::Close {
                    return false;
                }
                *value = ConnSignal::Close;
                true
            });
        }
    }
}

/// Counts and starts one stream, or refuses it (reset and stop with code 2).
#[allow(clippy::too_many_arguments)]
async fn accept_stream(
    shared: &Arc<Shared>,
    id: u64,
    key: [u8; 32],
    mut send: SendStream,
    mut recv: RecvStream,
    signal: &watch::Receiver<ConnSignal>,
    streams: &mut JoinSet<()>,
    draining: bool,
) {
    let verdict = {
        let mut state = shared.lock();
        let on_connection = state.conns.get(&id).map_or(u32::MAX, |entry| entry.streams);
        let reason = if state.stopping || draining {
            Some("closing")
        } else if on_connection >= shared.limits.max_streams_per_connection {
            Some("connection_cap")
        } else if state.streams >= shared.limits.max_streams_total {
            Some("total_cap")
        } else {
            None
        };
        match reason {
            Some(reason) => {
                state.refused_streams += 1;
                shared.publish(&state);
                Err((reason, state.streams))
            }
            None => {
                state.streams += 1;
                if let Some(entry) = state.conns.get_mut(&id) {
                    entry.streams += 1;
                }
                shared.publish(&state);
                Ok(StreamSlot {
                    shared: shared.clone(),
                    conn: id,
                })
            }
        }
    };
    match verdict {
        Err((reason, live)) => {
            reset_stream(&mut send, &mut recv, CODE_STREAM_REFUSED);
            shared
                .out
                .log(
                    "team.bridge.stream_refused",
                    json!({ "reason": reason, "streams": live }),
                )
                .await;
        }
        Ok(slot) => {
            let preamble = encode_host(&shared.boot_secret, &key);
            streams.spawn(host_stream(
                shared.loopback_port,
                preamble,
                send,
                recv,
                signal.clone(),
                slot,
            ));
        }
    }
}

/// Opens the loopback connection, writes the preamble first, then pipes.
async fn host_stream(
    port: u16,
    preamble: Zeroizing<[u8; HOST_PREAMBLE_BYTES]>,
    mut send: SendStream,
    mut recv: RecvStream,
    mut signal: watch::Receiver<ConnSignal>,
    _slot: StreamSlot,
) {
    if signal.borrow().mode() != StreamMode::Live {
        reset_stream(&mut send, &mut recv, CODE_CLOSED);
        return;
    }
    let target = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let connected = tokio::select! {
        biased;
        _ = not_live(&mut signal) => None,
        socket = TcpStream::connect(target) => socket.ok(),
    };
    let Some(mut socket) = connected else {
        reset_stream(&mut send, &mut recv, CODE_CLOSED);
        return;
    };
    let _ = socket.set_nodelay(true);
    let written = tokio::select! {
        biased;
        _ = closed(&mut signal) => false,
        written = socket.write_all(&preamble[..]) => written.is_ok(),
    };
    drop(preamble);
    if !written {
        reset_stream(&mut send, &mut recv, CODE_CLOSED);
        return;
    }
    pipe(send, recv, socket, signal).await;
}
