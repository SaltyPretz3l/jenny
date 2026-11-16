//! One host connection after its handshake: admit question, streams, drain and close.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::{Connection, RecvStream, SendStream};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::admission::Cause;
use crate::bulk::{mark_bulk, read_head};
use crate::control::b64;
use crate::host::{ConnEntry, ConnSignal, Shared};
use crate::key_share::{share, stream_room, Share};
use crate::messages::AdmitKind;
use crate::pipe::{
    close_connection as close, closed, not_live, pipe, reset_stream, StreamMode, StreamSignal,
    CODE_ADMIT_TIMEOUT, CODE_CLOSED, CODE_COOLDOWN, CODE_REFUSED,
};
use crate::preamble::{encode_host, HOST_PREAMBLE_BYTES};

const CODE_STREAM_REFUSED: u32 = 2;
/// After a drained connection's streams are done, how long the peer gets to read them.
const DRAIN_LINGER: Duration = Duration::from_millis(250);
/// How long streams get to reset themselves at the drain deadline before they are aborted.
const RESET_SETTLE: Duration = Duration::from_millis(100);

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

enum Registration {
    Stopping,
    Cooling,
    Full(usize),
    WaitingFull,
    Live(u64, watch::Receiver<ConnSignal>),
}

enum Decision {
    Admit(AdmitKind),
    /// The host application refused (a `null` answer or a `drop`).
    Refuse,
    /// Nobody answered within the admit timeout: refused, but told apart on the wire.
    TimedOut,
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

pub(crate) async fn run_connection(shared: Arc<Shared>, conn: Connection) {
    let key = *conn.remote_id().as_bytes();
    let registration = {
        let mut state = shared.lock();
        let live = state.conns.len();
        // A key at its share gives its oldest admitted connection's slot to the new one: a
        // member who reconnects always gets in, and nobody is told refused. A key with
        // nothing admitted replaces nothing, so its refusals still reach the cooldown.
        let share = share(&state.conns, &key);
        let victim = match share {
            Share::Replace(old) => Some(old),
            Share::Room | Share::Full => None,
        };
        let freed = usize::from(victim.is_some());
        let registration = if state.stopping {
            Registration::Stopping
        } else if state.admission.is_cooling(&key, std::time::Instant::now()) {
            // Refused in the last cooldown: refused again without asking the parent.
            state.admission.note(Cause::Cooldown);
            Registration::Cooling
        } else if live - freed >= shared.limits.max_connections as usize {
            Registration::Full(live)
        } else if share == Share::Full
            || state
                .conns
                .values()
                .filter(|entry| *entry.signal.borrow() == ConnSignal::Waiting)
                .count()
                >= shared.limits.max_waiting as usize
        {
            // The other connection slots are for admitted keys only, and a key with nothing
            // admitted waits on at most its share.
            state.admission.note(Cause::WaitingCap);
            Registration::WaitingFull
        } else {
            if let Some(old) = victim {
                // Closed as a stop closes it; its own task removes it and reports
                // `conn_closed`.
                if let Some(entry) = state.conns.get(&old) {
                    entry.signal.send_replace(ConnSignal::Close);
                }
                state.refused_connections += 1;
            }
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
            if shared.follow_paths {
                let path = crate::relay::path_of(&conn);
                state.paths.insert(id, (conn.clone(), path));
            }
            shared.publish(&state);
            Registration::Live(id, receiver)
        };
        if matches!(
            registration,
            Registration::Cooling | Registration::Full(_) | Registration::WaitingFull
        ) {
            state.refused_connections += 1;
            shared.publish(&state);
        }
        registration
    };
    let (id, mut signal) = match registration {
        Registration::Stopping | Registration::WaitingFull => {
            close(&conn, CODE_CLOSED);
            return;
        }
        Registration::Cooling => {
            // The bridge's memory of an earlier refusal, not a fresh answer from the host.
            close(&conn, CODE_COOLDOWN);
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
        decision @ (Decision::Refuse | Decision::TimedOut) => {
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
            let code = match decision {
                Decision::TimedOut => CODE_ADMIT_TIMEOUT,
                _ => CODE_REFUSED,
            };
            close(&conn, code);
        }
        Decision::Close => close(&conn, CODE_CLOSED),
        Decision::PeerGone => {}
    }
    {
        let mut state = shared.lock();
        state.conns.remove(&id);
        state.paths.remove(&id);
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
    // Timed out: refuse, unless an answer won the race under the lock. Only this task removes
    // the entry, so it is there; fail closed if not.
    let state = shared.lock();
    let Some(entry) = state.conns.get(&id) else {
        return Decision::TimedOut;
    };
    let timed_out = entry.signal.send_if_modified(|value| {
        if *value != ConnSignal::Waiting {
            return false;
        }
        *value = ConnSignal::Refuse;
        true
    });
    if timed_out {
        return Decision::TimedOut;
    }
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
        let reason = if recv.is_0rtt() {
            // Early data is replayable (I6): never piped, whatever the connection's state.
            Some("early_data")
        } else if state.stopping || draining {
            Some("closing")
        } else if on_connection >= shared.limits.max_streams_per_connection {
            Some("connection_cap")
        } else if !stream_room(&state.conns, &key) {
            Some("key_cap")
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

/// Reads how the stream begins (a bulk stream's class byte is not forwarded), opens the
/// loopback connection, writes the preamble and the request's first byte, then pipes.
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
    let Some(head) = read_head(&mut recv, &mut signal).await else {
        reset_stream(&mut send, &mut recv, CODE_CLOSED);
        return;
    };
    if head.bulk {
        mark_bulk(&send);
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
        written = async {
            socket.write_all(&preamble[..]).await?;
            socket.write_all(&[head.byte]).await
        } => written.is_ok(),
    };
    drop(preamble);
    if !written {
        reset_stream(&mut send, &mut recv, CODE_CLOSED);
        return;
    }
    pipe(send, recv, socket, signal).await;
}
