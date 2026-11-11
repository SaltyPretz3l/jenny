//! Member mode: dial the host once, then offer a loopback port to Jenny's main process.
//! Every TCP connection must open with the 40-byte member preamble before it becomes a
//! stream to the host. No retries: a refused or lost connection reports `offline`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use iroh::endpoint::{
    presets, BindOpts, ConnectError, ConnectingError, Connection, ConnectionError,
    TransportErrorCode, VarInt,
};
use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey, TransportAddr};
use serde_json::json;
use tokio::io::{AsyncBufRead, AsyncReadExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use zeroize::Zeroizing;

use crate::control::{read_commands, Input, LineRead, LineReader, Out, Reason};
use crate::messages::{parse_member_command, parse_member_start, MemberCommand, MemberLimits};
use crate::pipe::{close_connection, CODE_CLOSED, CODE_REFUSED};
use crate::pipe::{closed, pipe, StreamMode, StreamSignal};
use crate::preamble::{verify_member, MEMBER_PREAMBLE_BYTES, SECRET_BYTES};
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
    streams: u32,
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

/// Releases a preamble slot or a stream slot when dropped.
struct Slot {
    shared: Arc<Shared>,
    stream: bool,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut counts = self.shared.lock();
        if self.stream {
            counts.streams = counts.streams.saturating_sub(1);
        } else {
            counts.preamble = counts.preamble.saturating_sub(1);
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

/// True when the peer refused or closed with the refused code.
fn refused(error: &ConnectionError) -> bool {
    match error {
        ConnectionError::ApplicationClosed(close) => {
            close.error_code == VarInt::from_u32(CODE_REFUSED)
        }
        ConnectionError::ConnectionClosed(close) => {
            close.error_code == TransportErrorCode::CONNECTION_REFUSED
        }
        _ => false,
    }
}

fn connect_refused(error: &ConnectError) -> bool {
    match error {
        ConnectError::Connecting {
            source: ConnectingError::ConnectionError { source, .. },
            ..
        } => refused(source),
        ConnectError::Connection { source, .. } => refused(source),
        _ => false,
    }
}

async fn bind(secret_key: Zeroizing<[u8; 32]>, loopback_only: bool) -> Result<Endpoint, ()> {
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(&secret_key))
        .transport_config(crate::pipe::bounded_transport().build());
    drop(secret_key);
    if loopback_only {
        builder = builder
            .clear_ip_transports()
            .bind_addr(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .map_err(|_| ())?
            .bind_addr_with_opts(
                SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 0),
                BindOpts::default().set_is_required(false),
            )
            .map_err(|_| ())?;
    }
    builder.bind().await.map_err(|_| ())
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
    out.send(json!({ "t": "state", "state": "connecting" }))
        .await;
    let (command_tx, mut commands) = mpsc::channel(8);
    let reader_task = tokio::spawn(read_commands(reader, command_tx, parse_member_command));

    let loopback_only = options.loopback_only || start.loopback_only;
    let Ok(endpoint) = bind(start.secret_key, loopback_only).await else {
        offline(&out, "host_unreachable").await;
        reader_task.abort();
        let _ = reader_task.await;
        return 0;
    };
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
    let code = session
        .run(start.host_key, start.addresses, &start.alpn, &mut commands)
        .await;
    let _ = tokio::time::timeout(MEMBER_CLOSE_GRACE, endpoint.close()).await;
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
        host_key: [u8; 32],
        addresses: Vec<SocketAddr>,
        alpn: &[u8],
        commands: &mut mpsc::Receiver<Input<MemberCommand>>,
    ) -> i32 {
        let Ok(host_id) = PublicKey::from_bytes(&host_key) else {
            offline(self.out, "host_unreachable").await;
            return 0;
        };
        let target =
            EndpointAddr::from_parts(host_id, addresses.into_iter().map(TransportAddr::Ip));
        let limit = Duration::from_millis(u64::from(self.shared.limits.connect_timeout_ms));
        let connected = tokio::select! {
            biased;
            input = commands.recv() => return self.exit(exit_of(input)).await,
            connected = tokio::time::timeout(limit, self.endpoint.connect(target, alpn)) => {
                connected
            }
        };
        let conn = match connected {
            Ok(Ok(conn)) => conn,
            Ok(Err(error)) => {
                let reason = if connect_refused(&error) {
                    "host_refused"
                } else {
                    "host_unreachable"
                };
                offline(self.out, reason).await;
                return 0;
            }
            Err(_) => {
                offline(self.out, "host_unreachable").await;
                return 0;
            }
        };
        let loopback = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
        let Ok(listener) = TcpListener::bind(loopback).await else {
            close_connection(&conn, CODE_CLOSED);
            offline(self.out, "closed").await;
            return 0;
        };
        let port = match listener.local_addr() {
            Ok(address) => address.port(),
            Err(_) => {
                close_connection(&conn, CODE_CLOSED);
                offline(self.out, "closed").await;
                return 0;
            }
        };
        self.shared.lock().online = true;
        self.out
            .send(json!({ "t": "state", "state": "online", "port": port }))
            .await;
        self.serve(conn, listener, commands).await
    }

    async fn serve(
        &self,
        conn: Connection,
        listener: TcpListener,
        commands: &mut mpsc::Receiver<Input<MemberCommand>>,
    ) -> i32 {
        let (signal_tx, signal_rx) = watch::channel(MemberSignal::Live);
        let mut sockets = JoinSet::new();
        let peer_closed = conn.closed();
        tokio::pin!(peer_closed);
        let ended = loop {
            tokio::select! {
                biased;
                input = commands.recv() => break Err(exit_of(input)),
                error = &mut peer_closed => break Ok(refused(&error)),
                Some(_) = sockets.join_next(), if !sockets.is_empty() => {}
                accepted = listener.accept() => {
                    let Ok((socket, _)) = accepted else {
                        // Out of descriptors and the like: back off instead of spinning.
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    };
                    let admitted = {
                        let mut counts = self.shared.lock();
                        let cap = self.shared.limits.max_preamble_sockets;
                        if !counts.online || counts.preamble >= cap {
                            false
                        } else {
                            counts.preamble += 1;
                            true
                        }
                    };
                    if !admitted {
                        drop(socket);
                        continue;
                    }
                    let slot = Slot { shared: self.shared.clone(), stream: false };
                    sockets.spawn(member_socket(slot, conn.clone(), socket, signal_rx.clone()));
                }
            }
        };
        drop(listener);
        self.shared.lock().online = false;
        if ended.is_err() {
            close_connection(&conn, CODE_CLOSED);
        }
        let _ = signal_tx.send(MemberSignal::Close);
        sockets.shutdown().await;
        match ended {
            Ok(was_refused) => {
                offline(
                    self.out,
                    if was_refused {
                        "host_refused"
                    } else {
                        "closed"
                    },
                )
                .await;
                0
            }
            Err(exit) => self.exit(exit).await,
        }
    }
}

/// Checks the preamble, then carries the socket as one stream to the host.
async fn member_socket(
    preamble_slot: Slot,
    conn: Connection,
    mut socket: TcpStream,
    mut signal: watch::Receiver<MemberSignal>,
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
    let stream_slot = {
        let mut counts = shared.lock();
        if !counts.online || counts.streams >= shared.limits.max_streams {
            None
        } else {
            counts.streams += 1;
            Some(Slot {
                shared: shared.clone(),
                stream: true,
            })
        }
    };
    let Some(_stream_slot) = stream_slot else {
        return;
    };
    let opened = tokio::select! {
        biased;
        _ = closed(&mut signal) => None,
        opened = conn.open_bi() => opened.ok(),
    };
    let Some((send, recv)) = opened else {
        return;
    };
    let _ = socket.set_nodelay(true);
    pipe(send, recv, socket, signal).await;
}
