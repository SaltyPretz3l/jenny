//! Host mode: bind the endpoint, answer the parent's control lines, accept connections.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::num::NonZeroU16;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use iroh::endpoint::{presets, BindOpts, Connection, VarInt};
use iroh::tls::CaTlsConfig;
use iroh::{Endpoint, EndpointAddr, SecretKey, Watcher};
use serde_json::json;
use tokio::io::AsyncBufRead;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::accept;
use crate::admission::{self, Admission};
use crate::control::{b64, read_commands, Input, LineRead, LineReader, Out, Reason};
use crate::messages::{parse_host_command, parse_host_start, AdmitKind, HostCommand, HostLimits};
use crate::pipe::{StreamMode, StreamSignal};
use crate::portmap;
use crate::relay::{self, PathKind, RelayStart};
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
    direct_external: usize,
    relayed: usize,
}

pub(crate) struct State {
    pub stopping: bool,
    pub next_conn: u64,
    pub conns: HashMap<u64, ConnEntry>,
    pub streams: u32,
    pub refused_streams: u64,
    pub refused_connections: u64,
    pub handshakes: u32,
    /// The handshake slots relayed connections hold, at most their share of `handshakes`.
    pub relayed_handshakes: u32,
    pub admission: Admission,
    /// With a relay configured: each live connection and its selected path, by connection id;
    /// removed with the connection.
    pub paths: HashMap<u64, (Connection, Option<PathKind>)>,
}

pub(crate) struct Shared {
    state: Mutex<State>,
    stats: watch::Sender<Stats>,
    pub out: Out,
    pub boot_secret: Zeroizing<[u8; 32]>,
    pub loopback_port: u16,
    pub limits: HostLimits,
    /// A relay is configured or internet joining is on: connections keep their path and `stats`
    /// counts them, so the host can say a member reached it from outside.
    pub follow_paths: bool,
}

impl Shared {
    /// Never held across an await.
    pub fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Publishes the counters; the stats task writes a line when they changed.
    pub fn publish(&self, state: &State) {
        let paths = state.paths.values().map(|(_, path)| *path);
        let next = Stats {
            connections: state.conns.len(),
            streams: state.streams,
            refused_streams: state.refused_streams,
            refused_connections: state.refused_connections,
            direct_external: paths
                .clone()
                .filter(|path| *path == Some(PathKind::Direct { public: true }))
                .count(),
            relayed: paths.filter(|path| *path == Some(PathKind::Relay)).count(),
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

struct BindPlan<'a> {
    direct_port: Option<u16>,
    streams_per_connection: u32,
    loopback_only: bool,
    relay: Option<&'a RelayStart>,
    relay_tls: Option<&'a CaTlsConfig>,
}

async fn bind(
    secret_key: Zeroizing<[u8; 32]>,
    alpn: &[u8],
    plan: BindPlan<'_>,
) -> Result<Endpoint, ()> {
    let BindPlan {
        direct_port,
        streams_per_connection,
        loopback_only,
        relay,
        relay_tls,
    } = plan;
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
    relay::configure(builder, relay, relay_tls)
        .bind()
        .await
        .map_err(|_| ())
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
    let loopback_only = options.loopback_only || start.loopback_only;
    if !relay::destination_allowed(start.relay.as_ref(), loopback_only) {
        return fail(&out, Reason::StartInvalid).await;
    }
    // Never the real router client with loopback sockets: no router can map them, and so no
    // test can reach a real router.
    if start.map_port && options.mapper.is_none() && loopback_only {
        return fail(&out, Reason::StartInvalid).await;
    }
    let map_port = start.direct_port.filter(|_| start.map_port);
    let plan = BindPlan {
        direct_port: start.direct_port,
        streams_per_connection: start.limits.max_streams_per_connection,
        loopback_only,
        relay: start.relay.as_ref(),
        relay_tls: options.relay_tls.as_ref(),
    };
    let relay_on = start.relay.is_some();
    let follow_paths = relay_on || start.map_port;
    let endpoint = match bind(start.secret_key, &start.alpn, plan).await {
        Ok(endpoint) => endpoint,
        Err(()) => return fail(&out, Reason::BindFailed).await,
    };

    let addresses = addresses_of(&endpoint.addr());
    out.send(json!({
        "t": "ready",
        "public_key": b64(endpoint.id().as_bytes()),
        "addresses": addresses,
        "bulk": 1,
        // Reads `known_keys` (review C3); a parent sends it only to a bridge that says so.
        "known_keys": 1,
    }))
    .await;
    out.log("team.bridge.started", json!({})).await;

    let (stats_tx, stats_rx) = watch::channel(Stats::default());
    let (stop_tx, stop_rx) = watch::channel(false);
    let (stats_done_tx, stats_done_rx) = oneshot::channel();
    let (addresses_tx, addresses_rx) = watch::channel(());
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            stopping: false,
            next_conn: 1,
            conns: HashMap::new(),
            streams: 0,
            refused_streams: 0,
            refused_connections: 0,
            handshakes: 0,
            relayed_handshakes: 0,
            paths: HashMap::new(),
            admission: Admission::new(
                start.limits.max_handshakes_per_source,
                Duration::from_millis(u64::from(start.limits.refused_cooldown_ms)),
            ),
        }),
        stats: stats_tx,
        out: out.clone(),
        boot_secret: start.boot_secret,
        loopback_port: start.loopback_port,
        limits: start.limits,
        follow_paths,
    });
    drop(start.relay);
    let mapping = map_port.and_then(NonZeroU16::new).map(|port| {
        tokio::spawn(portmap::run(portmap::Task {
            mapper: options.mapper.clone().unwrap_or_else(portmap::router),
            port,
            external: Arc::new(endpoint.clone()),
            addresses: addresses_rx,
            out: out.clone(),
            stop: stop_rx.clone(),
        }))
    });
    let [relay, paths] = relay::spawn_tasks(
        relay_on,
        follow_paths,
        &shared,
        &endpoint,
        options.relay_unreachable_after,
        &stop_rx,
    );
    let tasks = Tasks {
        stats: tokio::spawn(stats_loop(
            out.clone(),
            stats_rx,
            stats_done_rx,
            follow_paths,
        )),
        stats_done: stats_done_tx,
        addresses: tokio::spawn(address_loop(
            out.clone(),
            endpoint.clone(),
            addresses,
            addresses_tx,
            stop_rx.clone(),
        )),
        mapping,
        relay,
        paths,
        summary: tokio::spawn(admission::summary_loop(shared.clone(), stop_rx.clone())),
        accept: tokio::spawn(accept::accept_loop(
            shared.clone(),
            endpoint.clone(),
            stop_rx,
        )),
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
            Some(Input::Command(HostCommand::KnownKeys { keys })) => {
                shared.lock().admission.set_known(keys);
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
    let mut state = shared.lock();
    // An answer for an unknown or finished connection is ignored.
    let Some(entry) = state.conns.get(&conn) else {
        return;
    };
    let decided = entry.signal.send_if_modified(|signal| {
        if *signal != ConnSignal::Waiting {
            return false;
        }
        *signal = kind.map_or(ConnSignal::Refuse, ConnSignal::Admit);
        true
    });
    // An answer that decided a waiting connection is about its key: a refusal starts the
    // key's cooldown, an admit ends it. A late answer (admitted, timed out, dropped) does not.
    if decided {
        let key = entry.key;
        match kind {
            None => state.admission.refused(key, std::time::Instant::now()),
            Some(_) => state.admission.clear(&key),
        }
    }
}

/// Ends every connection of `key`: waiting ones are refused, admitted ones drain.
/// Returns how many connections this drop ended.
fn drop_key(shared: &Shared, key: &[u8; 32]) -> usize {
    let mut state = shared.lock();
    state.admission.clear(key);
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
    mapping: Option<JoinHandle<()>>,
    relay: Option<JoinHandle<()>>,
    paths: Option<JoinHandle<()>>,
    summary: JoinHandle<()>,
    accept: JoinHandle<()>,
    stop: watch::Sender<bool>,
}

/// Stops accepting, closes every connection at once (no drain), deactivates the port
/// mapping (bounded, beside the connections), closes the endpoint (bounded), then flushes
/// the last `stats`.
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
    // `off` goes out before the endpoint closes, so a closing relay adds no line. The path
    // follower has nothing to flush.
    if let Some(paths) = tasks.paths {
        paths.abort();
    }
    if let Some(relay) = tasks.relay {
        join_bounded(relay, Duration::from_secs(1)).await;
    }
    let mapping = async {
        if let Some(task) = tasks.mapping {
            join_bounded(task, portmap::DEACTIVATE_BOUND + Duration::from_secs(1)).await;
        }
    };
    tokio::join!(
        join_bounded(tasks.accept, SHUTDOWN_GRACE + Duration::from_secs(1)),
        mapping
    );
    join_bounded(tasks.summary, Duration::from_millis(100)).await;
    admission::flush_summary(shared).await;
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

async fn stats_loop(
    out: Out,
    mut stats: watch::Receiver<Stats>,
    mut done: oneshot::Receiver<()>,
    paths: bool,
) {
    loop {
        tokio::select! {
            biased;
            changed = stats.changed() => {
                if changed.is_err() {
                    return;
                }
                let current = *stats.borrow_and_update();
                out.send(stats_line(current, paths)).await;
            }
            _ = &mut done => {
                if stats.has_changed().unwrap_or(false) {
                    let current = *stats.borrow_and_update();
                    out.send(stats_line(current, paths)).await;
                }
                return;
            }
        }
    }
}

/// The two path counts are on the line only with a relay configured or internet joining on, so
/// a LAN bridge sends the same line as before.
fn stats_line(stats: Stats, paths: bool) -> serde_json::Value {
    let mut line = json!({
        "t": "stats",
        "connections": stats.connections,
        "streams": stats.streams,
        "refused_streams": stats.refused_streams,
        "refused_connections": stats.refused_connections,
    });
    if paths {
        line["direct_external_connections"] = json!(stats.direct_external);
        line["relayed_connections"] = json!(stats.relayed);
    }
    line
}

async fn address_loop(
    out: Out,
    endpoint: Endpoint,
    mut last: Vec<String>,
    changed: watch::Sender<()>,
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
                    changed.send_replace(());
                }
            }
        }
    }
}
