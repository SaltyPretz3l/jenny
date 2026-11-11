//! Host mode: bind the endpoint, answer the parent's control lines, accept connections.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use iroh::endpoint::{presets, BindOpts, VarInt};
use iroh::{Endpoint, EndpointAddr, SecretKey, Watcher};
use serde_json::json;
use tokio::io::AsyncBufRead;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::control::{b64, read_commands, Input, LineRead, LineReader, Out, Reason};
use crate::host_conn;
use crate::messages::{parse_host_command, parse_host_start, AdmitKind, HostCommand, HostLimits};
use crate::pipe::{StreamMode, StreamSignal};
use crate::RunOptions;

/// How long `stop` waits for connections to report closed, and for the endpoint to close.
pub(crate) const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// What the control loop has told one connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConnSignal {
    Waiting,
    Admit(AdmitKind),
    Refuse,
    Drain(Instant),
    Close,
}

impl StreamSignal for ConnSignal {
    fn mode(&self) -> StreamMode {
        match self {
            ConnSignal::Waiting | ConnSignal::Admit(_) => StreamMode::Live,
            ConnSignal::Drain(_) => StreamMode::Drain,
            ConnSignal::Refuse | ConnSignal::Close => StreamMode::Close,
        }
    }
}

/// A live connection: waiting for its admit answer, admitted, or draining.
pub(crate) struct ConnEntry {
    pub key: [u8; 32],
    pub signal: watch::Sender<ConnSignal>,
    pub streams: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Stats {
    connections: usize,
    streams: u32,
    refused_streams: u64,
    refused_connections: u64,
}

#[derive(Default)]
pub(crate) struct State {
    pub stopping: bool,
    pub next_conn: u64,
    pub conns: HashMap<u64, ConnEntry>,
    pub streams: u32,
    pub refused_streams: u64,
    pub refused_connections: u64,
    pub handshakes: u32,
}

pub(crate) struct Shared {
    state: Mutex<State>,
    stats: watch::Sender<Stats>,
    pub out: Out,
    pub boot_secret: Zeroizing<[u8; 32]>,
    pub loopback_port: u16,
    pub limits: HostLimits,
}

impl Shared {
    /// Never held across an await.
    pub fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Publishes the four counters; the stats task writes a line when they changed.
    pub fn publish(&self, state: &State) {
        let next = Stats {
            connections: state.conns.len(),
            streams: state.streams,
            refused_streams: state.refused_streams,
            refused_connections: state.refused_connections,
        };
        self.stats.send_if_modified(|current| {
            if *current == next {
                return false;
            }
            *current = next;
            true
        });
    }
}

fn addresses_of(addr: &EndpointAddr) -> Vec<String> {
    addr.ip_addrs().map(|ip| ip.to_string()).collect()
}

async fn bind(
    secret_key: Zeroizing<[u8; 32]>,
    alpn: &[u8],
    direct_port: Option<u16>,
    streams_per_connection: u32,
    loopback_only: bool,
) -> Result<Endpoint, ()> {
    let transport = crate::pipe::bounded_transport()
        .max_concurrent_bidi_streams(VarInt::from_u32(streams_per_connection))
        .build();
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(&secret_key))
        .alpns(vec![alpn.to_vec()])
        .transport_config(transport);
    drop(secret_key);
    if direct_port.is_some() || loopback_only {
        let (v4, v6): (IpAddr, IpAddr) = if loopback_only {
            (Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into())
        } else {
            (Ipv4Addr::UNSPECIFIED.into(), Ipv6Addr::UNSPECIFIED.into())
        };
        let port = direct_port.unwrap_or(0);
        // IPv6 may be missing on the machine: that socket is optional, IPv4 is required.
        builder = builder
            .clear_ip_transports()
            .bind_addr(SocketAddr::new(v4, port))
            .map_err(|_| ())?
            .bind_addr_with_opts(
                SocketAddr::new(v6, port),
                BindOpts::default().set_is_required(false),
            )
            .map_err(|_| ())?;
    }
    builder.bind().await.map_err(|_| ())
}

/// Runs host mode until `stop`, end of input, or a protocol error. Returns the exit code.
pub async fn run_host_with<R>(input: R, output: mpsc::Sender<String>, options: RunOptions) -> i32
where
    R: AsyncBufRead + Unpin + Send + 'static,
{
    let out = Out::new(output);
    let mut reader = LineReader::new(input);
    let start = match tokio::time::timeout(options.start_timeout, reader.next_line()).await {
        Err(_) => return fail(&out, Reason::StartTimeout).await,
        Ok(LineRead::Eof) => return 0,
        Ok(LineRead::TooLong) => return fail(&out, Reason::ProtocolInvalid).await,
        Ok(LineRead::Line(line)) => match parse_host_start(&line) {
            Ok(start) => start,
            Err(reason) => return fail(&out, reason).await,
        },
    };
    let endpoint = match bind(
        start.secret_key,
        &start.alpn,
        start.direct_port,
        start.limits.max_streams_per_connection,
        options.loopback_only || start.loopback_only,
    )
    .await
    {
        Ok(endpoint) => endpoint,
        Err(()) => return fail(&out, Reason::BindFailed).await,
    };

    let addresses = addresses_of(&endpoint.addr());
    out.send(json!({
        "t": "ready",
        "public_key": b64(endpoint.id().as_bytes()),
        "addresses": addresses,
    }))
    .await;
    out.log("team.bridge.started", json!({})).await;

    let (stats_tx, stats_rx) = watch::channel(Stats::default());
    let (stop_tx, stop_rx) = watch::channel(false);
    let (stats_done_tx, stats_done_rx) = oneshot::channel();
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            next_conn: 1,
            ..State::default()
        }),
        stats: stats_tx,
        out: out.clone(),
        boot_secret: start.boot_secret,
        loopback_port: start.loopback_port,
        limits: start.limits,
    });
    let tasks = Tasks {
        stats: tokio::spawn(stats_loop(out.clone(), stats_rx, stats_done_rx)),
        stats_done: stats_done_tx,
        addresses: tokio::spawn(address_loop(
            out.clone(),
            endpoint.clone(),
            addresses,
            stop_rx.clone(),
        )),
        accept: tokio::spawn(accept_loop(shared.clone(), endpoint.clone(), stop_rx)),
        stop: stop_tx,
    };
    let (command_tx, mut commands) = mpsc::channel(64);
    let reader_task = tokio::spawn(read_commands(reader, command_tx, parse_host_command));

    let code = loop {
        match commands.recv().await {
            Some(Input::Command(HostCommand::AdmitAnswer { conn, kind })) => {
                answer_admit(&shared, conn, kind);
            }
            Some(Input::Command(HostCommand::Drop { key })) => {
                let ended = drop_key(&shared, &key);
                if ended > 0 {
                    out.log("team.bridge.dropped", json!({ "connections": ended }))
                        .await;
                }
            }
            Some(Input::Command(HostCommand::Stop)) => {
                shutdown(&shared, &endpoint, tasks).await;
                out.log("team.bridge.stopped", json!({})).await;
                out.send(json!({ "t": "stopped" })).await;
                break 0;
            }
            Some(Input::Invalid) => {
                out.error(Reason::ProtocolInvalid).await;
                out.mute();
                shutdown(&shared, &endpoint, tasks).await;
                break Reason::ProtocolInvalid.exit_code();
            }
            Some(Input::Eof) | None => {
                out.mute();
                shutdown(&shared, &endpoint, tasks).await;
                break 0;
            }
        }
    };
    reader_task.abort();
    let _ = reader_task.await;
    code
}

async fn fail(out: &Out, reason: Reason) -> i32 {
    out.error(reason).await;
    reason.exit_code()
}

fn answer_admit(shared: &Shared, conn: u64, kind: Option<AdmitKind>) {
    let state = shared.lock();
    // An answer for an unknown or finished connection is ignored.
    if let Some(entry) = state.conns.get(&conn) {
        entry.signal.send_if_modified(|signal| {
            if *signal != ConnSignal::Waiting {
                return false;
            }
            *signal = kind.map_or(ConnSignal::Refuse, ConnSignal::Admit);
            true
        });
    }
}

/// Ends every connection of `key`: waiting ones are refused, admitted ones drain.
/// Returns how many connections this drop ended.
fn drop_key(shared: &Shared, key: &[u8; 32]) -> usize {
    let state = shared.lock();
    let deadline = Instant::now() + Duration::from_millis(u64::from(shared.limits.drop_grace_ms));
    let mut ended = 0;
    for entry in state.conns.values().filter(|entry| entry.key == *key) {
        entry.signal.send_if_modified(|signal| match *signal {
            ConnSignal::Waiting => {
                *signal = ConnSignal::Refuse;
                ended += 1;
                true
            }
            ConnSignal::Admit(_) => {
                *signal = ConnSignal::Drain(deadline);
                ended += 1;
                true
            }
            _ => false,
        });
    }
    ended
}

struct Tasks {
    stats: JoinHandle<()>,
    stats_done: oneshot::Sender<()>,
    addresses: JoinHandle<()>,
    accept: JoinHandle<()>,
    stop: watch::Sender<bool>,
}

/// Stops accepting, closes every connection at once (no drain), closes the endpoint
/// (bounded), then flushes the last `stats`.
async fn shutdown(shared: &Shared, endpoint: &Endpoint, tasks: Tasks) {
    {
        let mut state = shared.lock();
        state.stopping = true;
        for entry in state.conns.values() {
            entry.signal.send_if_modified(|signal| {
                if *signal == ConnSignal::Close {
                    return false;
                }
                *signal = ConnSignal::Close;
                true
            });
        }
    }
    let _ = tasks.stop.send(true);
    join_bounded(tasks.accept, SHUTDOWN_GRACE + Duration::from_secs(1)).await;
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, endpoint.close()).await;
    join_bounded(tasks.addresses, Duration::from_millis(100)).await;
    let _ = tasks.stats_done.send(());
    join_bounded(tasks.stats, Duration::from_secs(1)).await;
}

/// Resolves once the bridge is stopping (or the flag's sender is gone).
pub(crate) async fn stopping(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|stopping| *stopping).await;
}

/// Awaits a task for at most `limit`, then aborts it and waits for the abort.
pub(crate) async fn join_bounded(mut task: JoinHandle<()>, limit: Duration) {
    if tokio::time::timeout(limit, &mut task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
}

async fn stats_loop(out: Out, mut stats: watch::Receiver<Stats>, mut done: oneshot::Receiver<()>) {
    loop {
        tokio::select! {
            biased;
            changed = stats.changed() => {
                if changed.is_err() {
                    return;
                }
                let current = *stats.borrow_and_update();
                out.send(stats_line(current)).await;
            }
            _ = &mut done => {
                if stats.has_changed().unwrap_or(false) {
                    let current = *stats.borrow_and_update();
                    out.send(stats_line(current)).await;
                }
                return;
            }
        }
    }
}

fn stats_line(stats: Stats) -> serde_json::Value {
    json!({
        "t": "stats",
        "connections": stats.connections,
        "streams": stats.streams,
        "refused_streams": stats.refused_streams,
        "refused_connections": stats.refused_connections,
    })
}

async fn address_loop(
    out: Out,
    endpoint: Endpoint,
    mut last: Vec<String>,
    mut stop: watch::Receiver<bool>,
) {
    let mut watcher = endpoint.watch_addr();
    drop(endpoint);
    loop {
        tokio::select! {
            biased;
            _ = stopping(&mut stop) => return,
            update = watcher.updated() => {
                let Ok(addr) = update else { return };
                let now = addresses_of(&addr);
                if now != last {
                    out.send(json!({ "t": "addresses", "addresses": now })).await;
                    last = now;
                }
            }
        }
    }
}

async fn accept_loop(shared: Arc<Shared>, endpoint: Endpoint, mut stop: watch::Receiver<bool>) {
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
                    match incoming.retry() {
                        Ok(()) => continue,
                        Err(error) => error.into_incoming(),
                    }
                };
                let admitted = {
                    let mut state = shared.lock();
                    if state.stopping {
                        None
                    } else if state.handshakes >= shared.limits.max_handshakes {
                        state.refused_connections += 1;
                        shared.publish(&state);
                        Some(false)
                    } else {
                        state.handshakes += 1;
                        Some(true)
                    }
                };
                match admitted {
                    Some(true) => {}
                    Some(false) => {
                        // Ignored, not refused: a refusal would read as host_refused to a member.
                        incoming.ignore();
                        let live = shared.lock().conns.len();
                        shared
                            .out
                            .log(
                                "team.bridge.connection_refused",
                                json!({ "reason": "handshake_cap", "connections": live }),
                            )
                            .await;
                        continue;
                    }
                    None => {
                        incoming.ignore();
                        continue;
                    }
                }
                connections.spawn(host_conn::handshake(shared.clone(), incoming, stop_for_task));
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
