//! Member mode: dial the host once, then offer a loopback port to Jenny's main process.
//! Every TCP connection must open with the 40-byte member preamble before it becomes a
//! stream to the host. No retries: a refused or lost connection reports `offline`.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr, PublicKey, RelayUrl, TransportAddr, Watcher};
use serde_json::json;
use tokio::io::{AsyncBufRead, AsyncReadExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use zeroize::Zeroizing;

use crate::bulk::{mark_bulk, CLASS_BULK, MAX_BULK_STREAMS};
use crate::control::{read_commands, Input, LineRead, LineReader, Out, Reason};
use crate::member_dial::{bind, connect_reason, offline_reason, turn_away, BindPlan};
use crate::messages::{parse_member_command, parse_member_start, MemberCommand, MemberLimits};
use crate::pipe::{close_connection, CODE_CLOSED};
use crate::pipe::{closed, pipe, reset_stream, StreamMode, StreamSignal};
use crate::preamble::{verify_member, MEMBER_PREAMBLE_BYTES, SECRET_BYTES};
use crate::relay::{self, PathKind};
use crate::RunOptions;

/// The member's endpoint close bound: a dial that never connected otherwise holds the
/// full grace, and a connected member has already closed its connection by then.
const MEMBER_CLOSE_GRACE: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MemberSignal {
    Live,
    Close,
}

impl StreamSignal for MemberSignal {
    fn mode(&self) -> StreamMode {
        match self {
            MemberSignal::Live => StreamMode::Live,
            MemberSignal::Close => StreamMode::Close,
        }
    }
}

#[derive(Default)]
struct Counts {
    online: bool,
    preamble: u32,
    /// Every stream, bulk ones included.
    streams: u32,
    bulk: u32,
}

struct Shared {
    counts: Mutex<Counts>,
    launch_secret: Zeroizing<[u8; SECRET_BYTES]>,
    limits: MemberLimits,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Counts> {
        self.counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SlotKind {
    Preamble,
    Stream,
    /// A stream slot that also counts against the bulk cap.
    BulkStream,
}

/// Releases a preamble slot or a stream slot when dropped.
struct Slot {
    shared: Arc<Shared>,
    kind: SlotKind,
}

impl Slot {
    /// A stream slot, or `None` at the stream cap, at the bulk cap for a bulk socket, or
    /// once offline: the socket is dropped.
    fn stream(shared: &Arc<Shared>, bulk: bool) -> Option<Self> {
        let mut counts = shared.lock();
        let full = counts.streams >= shared.limits.max_streams
            || (bulk && counts.bulk >= MAX_BULK_STREAMS);
        if !counts.online || full {
            return None;
        }
        counts.streams += 1;
        let kind = if bulk {
            counts.bulk += 1;
            SlotKind::BulkStream
        } else {
            SlotKind::Stream
        };
        Some(Self {
            shared: shared.clone(),
            kind,
        })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut counts = self.shared.lock();
        match self.kind {
            SlotKind::Preamble => counts.preamble = counts.preamble.saturating_sub(1),
            SlotKind::Stream => counts.streams = counts.streams.saturating_sub(1),
            SlotKind::BulkStream => {
                counts.streams = counts.streams.saturating_sub(1);
                counts.bulk = counts.bulk.saturating_sub(1);
            }
        }
    }
}

/// How the session ended when the parent asked for it, or the input ended.
enum Exit {
    Stop,
    Invalid,
    Eof,
}

fn exit_of(input: Option<Input<MemberCommand>>) -> Exit {
    match input {
        Some(Input::Command(MemberCommand::Stop)) => Exit::Stop,
        Some(Input::Invalid) => Exit::Invalid,
        Some(Input::Eof) | None => Exit::Eof,
    }
}

async fn offline(out: &Out, reason: &str) {
    out.send(json!({ "t": "state", "state": "offline", "reason": reason }))
        .await;
}

/// Runs member mode until the connection ends, `stop`, end of input, or a protocol error.
/// Returns the exit code.
pub async fn run_member_with<R>(input: R, output: mpsc::Sender<String>, options: RunOptions) -> i32
where
    R: AsyncBufRead + Unpin + Send + 'static,
{
    let out = Out::new(output);
    let mut reader = LineReader::new(input);
    let start = match tokio::time::timeout(options.start_timeout, reader.next_line()).await {
        Err(_) => return fail(&out, Reason::StartTimeout).await,
        Ok(LineRead::Eof) => return 0,
        Ok(LineRead::TooLong) => return fail(&out, Reason::ProtocolInvalid).await,
        Ok(LineRead::Line(line)) => match parse_member_start(&line) {
            Ok(start) => start,
            Err(reason) => return fail(&out, reason).await,
        },
    };
    let loopback_only = options.loopback_only || start.loopback_only;
    if !relay::destination_allowed(start.relay.as_ref(), loopback_only) {
        return fail(&out, Reason::StartInvalid).await;
    }
    out.send(json!({ "t": "state", "state": "connecting" }))
        .await;
    let (command_tx, mut commands) = mpsc::channel(8);
    let reader_task = tokio::spawn(read_commands(reader, command_tx, parse_member_command));

    let relay_url = start.relay.as_ref().map(|relay| relay.url().clone());
    let plan = BindPlan {
        loopback_only,
        addresses: &start.addresses,
        relay: start.relay.as_ref(),
        relay_tls: options.relay_tls.as_ref(),
    };
    let bound = bind(start.secret_key, plan).await;
    drop(start.relay);
    let Ok(endpoint) = bound else {
        offline(&out, "host_unreachable").await;
        reader_task.abort();
        let _ = reader_task.await;
        return 0;
    };
    let turning_away = turn_away(&endpoint);
    let shared = Arc::new(Shared {
        counts: Mutex::new(Counts::default()),
        launch_secret: start.launch_secret,
        limits: start.limits,
    });
    let session = Session {
        out: &out,
        endpoint: &endpoint,
        shared,
    };
    let dial = Dial {
        host_key: start.host_key,
        addresses: start.addresses,
        relay_url,
    };
    let code = session.run(dial, &start.alpn, &mut commands).await;
    let _ = tokio::time::timeout(MEMBER_CLOSE_GRACE, endpoint.close()).await;
    turning_away.abort();
    let _ = turning_away.await;
    reader_task.abort();
    let _ = reader_task.await;
    code
}

async fn fail(out: &Out, reason: Reason) -> i32 {
    out.error(reason).await;
    reason.exit_code()
}

struct Session<'a> {
    out: &'a Out,
    endpoint: &'a Endpoint,
    shared: Arc<Shared>,
}

/// Where the host is: its key, its addresses and the owner's relay.
struct Dial {
    host_key: [u8; 32],
    addresses: Vec<SocketAddr>,
    relay_url: Option<RelayUrl>,
}

/// The two loopback listeners. A socket accepted on `bulk` becomes a bulk stream; both
/// share the preamble cap and the stream cap, and bulk streams have a cap of their own.
struct Listeners {
    ordinary: TcpListener,
    bulk: TcpListener,
    port: u16,
    bulk_port: u16,
}

impl Listeners {
    async fn bind() -> std::io::Result<Self> {
        let loopback = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
        let ordinary = TcpListener::bind(loopback).await?;
        let bulk = TcpListener::bind(loopback).await?;
        Ok(Self {
            port: ordinary.local_addr()?.port(),
            bulk_port: bulk.local_addr()?.port(),
            ordinary,
            bulk,
        })
    }

    /// The `online` line; `path` only with a relay configured.
    fn online_line(&self, path: Option<PathKind>) -> serde_json::Value {
        let (port, bulk_port) = (self.port, self.bulk_port);
        let mut line =
            json!({ "t": "state", "state": "online", "port": port, "bulk_port": bulk_port });
        if let Some(path) = path {
            line["path"] = json!(path.as_str());
        }
        line
    }
}

impl Session<'_> {
    /// Handles an exit asked for by the parent while not offline yet (once offline the run
    /// has already returned). On `stop` the endpoint is closed (bounded) before the last
    /// lines; otherwise the caller closes it.
    async fn exit(&self, exit: Exit) -> i32 {
        match exit {
            Exit::Stop => {
                let _ = tokio::time::timeout(MEMBER_CLOSE_GRACE, self.endpoint.close()).await;
                offline(self.out, "closed").await;
                self.out.send(json!({ "t": "stopped" })).await;
                0
            }
            Exit::Invalid => {
                self.out.error(Reason::ProtocolInvalid).await;
                self.out.mute();
                Reason::ProtocolInvalid.exit_code()
            }
            Exit::Eof => {
                self.out.mute();
                0
            }
        }
    }

    async fn run(
        &self,
        dial: Dial,
        alpn: &[u8],
        commands: &mut mpsc::Receiver<Input<MemberCommand>>,
    ) -> i32 {
        let Ok(host_id) = PublicKey::from_bytes(&dial.host_key) else {
            offline(self.out, "host_unreachable").await;
            return 0;
        };
        let relay = dial.relay_url.is_some();
        let ips = dial.addresses.into_iter().map(TransportAddr::Ip);
        let relays = dial.relay_url.into_iter().map(TransportAddr::Relay);
        let target = EndpointAddr::from_parts(host_id, ips.chain(relays));
        let limit = Duration::from_millis(u64::from(self.shared.limits.connect_timeout_ms));
        // The relay is followed for the whole dial: a refusal caught between two of iroh's
        // retries reads as neither connected nor refused.
        let mut watcher = self.endpoint.home_relay_status();
        let mut seen = relay::DialLook::default();
        seen.see(relay::look(&watcher.get()));
        let mut watching = relay;
        let connecting = tokio::time::timeout(limit, self.endpoint.connect(target, alpn));
        tokio::pin!(connecting);
        let connected = loop {
            tokio::select! {
                biased;
                input = commands.recv() => return self.exit(exit_of(input)).await,
                connected = &mut connecting => break connected,
                update = watcher.updated(), if watching => match update {
                    Ok(statuses) => seen.see(relay::look(&statuses)),
                    Err(_) => watching = false,
                },
            }
        };
        seen.see(relay::look(&watcher.get()));
        let unreachable = if relay {
            seen.reason()
        } else {
            "host_unreachable"
        };
        let conn = match connected {
            Ok(Ok(conn)) => conn,
            Ok(Err(error)) => {
                offline(self.out, connect_reason(&error).unwrap_or(unreachable)).await;
                return 0;
            }
            Err(_) => {
                offline(self.out, unreachable).await;
                return 0;
            }
        };
        let Ok(listeners) = Listeners::bind().await else {
            close_connection(&conn, CODE_CLOSED);
            offline(self.out, "closed").await;
            return 0;
        };
        self.shared.lock().online = true;
        // With a relay, `path` once iroh has selected one: on this line or a later one.
        let path = if relay { relay::path_of(&conn) } else { None };
        self.out.send(listeners.online_line(path)).await;
        self.serve(conn, listeners, (relay, path), commands).await
    }

    /// Counts an accepted loopback socket against the preamble cap; `None` when it is
    /// dropped instead.
    async fn admit(
        &self,
        accepted: std::io::Result<(TcpStream, SocketAddr)>,
    ) -> Option<(Slot, TcpStream)> {
        let Ok((socket, _)) = accepted else {
            // Out of descriptors and the like: back off instead of spinning.
            tokio::time::sleep(Duration::from_millis(50)).await;
            return None;
        };
        let mut counts = self.shared.lock();
        if !counts.online || counts.preamble >= self.shared.limits.max_preamble_sockets {
            return None;
        }
        counts.preamble += 1;
        let slot = Slot {
            shared: self.shared.clone(),
            kind: SlotKind::Preamble,
        };
        Some((slot, socket))
    }

    /// `path` is the path last reported, `None` before one (and always without a relay).
    async fn serve(
        &self,
        conn: Connection,
        listeners: Listeners,
        (relay, mut path): (bool, Option<PathKind>),
        commands: &mut mpsc::Receiver<Input<MemberCommand>>,
    ) -> i32 {
        let mut tick = tokio::time::interval(relay::PATH_POLL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let (signal_tx, signal_rx) = watch::channel(MemberSignal::Live);
        let mut sockets = JoinSet::new();
        let peer_closed = conn.closed();
        tokio::pin!(peer_closed);
        let ended = loop {
            tokio::select! {
                biased;
                input = commands.recv() => break Err(exit_of(input)),
                error = &mut peer_closed => break Ok(offline_reason(&error)),
                Some(_) = sockets.join_next(), if !sockets.is_empty() => {}
                _ = tick.tick(), if relay => {
                    let now = relay::path_of(&conn);
                    if now.is_some() && now.map(PathKind::as_str) != path.map(PathKind::as_str) {
                        path = now;
                        self.out.send(listeners.online_line(path)).await;
                    }
                }
                accepted = listeners.ordinary.accept() => {
                    if let Some((slot, socket)) = self.admit(accepted).await {
                        let signal = signal_rx.clone();
                        sockets.spawn(member_socket(slot, conn.clone(), socket, signal, false));
                    }
                }
                accepted = listeners.bulk.accept() => {
                    if let Some((slot, socket)) = self.admit(accepted).await {
                        let signal = signal_rx.clone();
                        sockets.spawn(member_socket(slot, conn.clone(), socket, signal, true));
                    }
                }
            }
        };
        drop(listeners);
        self.shared.lock().online = false;
        if ended.is_err() {
            close_connection(&conn, CODE_CLOSED);
        }
        let _ = signal_tx.send(MemberSignal::Close);
        sockets.shutdown().await;
        match ended {
            Ok(reason) => {
                offline(self.out, reason.unwrap_or("closed")).await;
                0
            }
            Err(exit) => self.exit(exit).await,
        }
    }
}

/// Checks the preamble, then carries the socket as one stream to the host. A bulk stream
/// starts with the class byte and is sent after every ordinary stream's data.
async fn member_socket(
    preamble_slot: Slot,
    conn: Connection,
    mut socket: TcpStream,
    mut signal: watch::Receiver<MemberSignal>,
    bulk: bool,
) {
    let shared = preamble_slot.shared.clone();
    let limit = Duration::from_millis(u64::from(shared.limits.preamble_timeout_ms));
    let mut preamble = Zeroizing::new([0u8; MEMBER_PREAMBLE_BYTES]);
    let valid = tokio::select! {
        biased;
        _ = closed(&mut signal) => false,
        read = tokio::time::timeout(limit, socket.read_exact(&mut preamble[..])) => {
            matches!(read, Ok(Ok(_))) && verify_member(&preamble[..], &shared.launch_secret)
        }
    };
    drop(preamble);
    drop(preamble_slot);
    if !valid {
        return;
    }
    let Some(_stream_slot) = Slot::stream(&shared, bulk) else {
        return;
    };
    let opened = tokio::select! {
        biased;
        _ = closed(&mut signal) => None,
        opened = conn.open_bi() => opened.ok(),
    };
    let Some((mut send, mut recv)) = opened else {
        return;
    };
    if bulk {
        mark_bulk(&send);
        let marked = tokio::select! {
            biased;
            _ = closed(&mut signal) => false,
            written = send.write_all(&[CLASS_BULK]) => written.is_ok(),
        };
        if !marked {
            reset_stream(&mut send, &mut recv, CODE_CLOSED);
            return;
        }
    }
    let _ = socket.set_nodelay(true);
    pipe(send, recv, socket, signal).await;
}
