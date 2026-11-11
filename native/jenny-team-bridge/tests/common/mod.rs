//! Shared harness: a bridge run in-process with in-memory control channels, a fake host
//! HTTP layer on an ephemeral loopback port, and helpers to build `start` lines.
#![allow(dead_code)]

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use iroh::SecretKey;
use jenny_team_bridge::preamble::encode_member;
use jenny_team_bridge::{run_host_with, run_member_with, RunOptions};
use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader, DuplexStream};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub const WAIT: Duration = Duration::from_secs(10);

/// Awaits `future` for at most [`WAIT`].
pub async fn within<F: Future>(what: &str, future: F) -> F::Output {
    match tokio::time::timeout(WAIT, future).await {
        Ok(value) => value,
        Err(_) => panic!("timed out waiting for {what}"),
    }
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn options() -> RunOptions {
    RunOptions {
        loopback_only: true,
        ..RunOptions::default()
    }
}

/// A key pair: secret bytes and the public key in base64url.
pub struct Keys {
    pub secret: [u8; 32],
    pub public: String,
}

pub fn keys() -> Keys {
    let secret = SecretKey::generate();
    Keys {
        secret: secret.to_bytes(),
        public: b64(secret.public().as_bytes()),
    }
}

pub fn random32() -> [u8; 32] {
    SecretKey::generate().to_bytes()
}

/// One bridge running in-process.
pub struct Bridge {
    input: Option<DuplexStream>,
    lines: mpsc::Receiver<String>,
    task: Option<JoinHandle<i32>>,
    /// Every line returned so far, for checks that do not depend on line order.
    history: Vec<Value>,
}

impl Bridge {
    fn spawn(host: bool, options: RunOptions) -> Self {
        let (client, server) = tokio::io::duplex(1 << 20);
        let (tx, lines) = mpsc::channel(1024);
        let reader = BufReader::new(server);
        let task = if host {
            tokio::spawn(run_host_with(reader, tx, options))
        } else {
            tokio::spawn(run_member_with(reader, tx, options))
        };
        Self {
            input: Some(client),
            lines,
            task: Some(task),
            history: Vec::new(),
        }
    }

    pub fn host() -> Self {
        Self::spawn(true, options())
    }

    pub fn host_with(options: RunOptions) -> Self {
        Self::spawn(true, options)
    }

    pub fn member() -> Self {
        Self::spawn(false, options())
    }

    pub fn member_with(options: RunOptions) -> Self {
        Self::spawn(false, options)
    }

    pub async fn send_raw(&mut self, bytes: &[u8]) {
        let input = self.input.as_mut().expect("input still open");
        input.write_all(bytes).await.expect("write control line");
    }

    pub async fn send(&mut self, message: Value) {
        let mut line = message.to_string().into_bytes();
        line.push(b'\n');
        self.send_raw(&line).await;
    }

    /// Ends the control input (end of file).
    pub fn close_input(&mut self) {
        self.input = None;
    }

    /// The next line, parsed. Panics when none arrives in time or the bridge ended.
    pub async fn next(&mut self) -> Value {
        let line = within("a control line", self.lines.recv())
            .await
            .expect("bridge still running");
        assert!(!line.contains('\n'), "line is a single line");
        let value: Value = serde_json::from_str(&line).expect("line is JSON");
        self.history.push(value.clone());
        value
    }

    /// Like [`Self::wait_for`], but also matches a line already seen. For `stats`, which
    /// its own task writes, so it may come before or after the line it goes with.
    pub async fn seen_or_wait(&mut self, what: &str, matches: impl Fn(&Value) -> bool) -> Value {
        if let Some(line) = self.history.iter().rev().find(|line| matches(line)) {
            return line.clone();
        }
        self.wait_for(what, matches).await
    }

    /// The latest `stats` line matching, seen before or arriving later.
    pub async fn stats_where(&mut self, what: &str, matches: impl Fn(&Value) -> bool) -> Value {
        self.seen_or_wait(what, |line| line["t"] == "stats" && matches(line))
            .await
    }

    /// Skips lines until one matches.
    pub async fn wait_for(&mut self, what: &str, matches: impl Fn(&Value) -> bool) -> Value {
        within(what, async {
            loop {
                let line = self.next().await;
                if matches(&line) {
                    return line;
                }
            }
        })
        .await
    }

    pub async fn expect(&mut self, t: &str) -> Value {
        self.wait_for(t, |line| line["t"] == t).await
    }

    pub async fn expect_state(&mut self, state: &str) -> Value {
        self.wait_for(state, |line| line["t"] == "state" && line["state"] == state)
            .await
    }

    pub async fn expect_log(&mut self, event: &str) -> Value {
        self.wait_for(event, |line| line["t"] == "log" && line["event"] == event)
            .await
    }

    /// Waits for the run to return; gives back its exit code and every line left.
    pub async fn finish(mut self) -> (i32, Vec<Value>) {
        let task = self.task.take().expect("task present");
        let code = within("the bridge to exit", task)
            .await
            .expect("bridge task");
        let mut rest = Vec::new();
        while let Ok(line) = self.lines.try_recv() {
            rest.push(serde_json::from_str(&line).expect("line is JSON"));
        }
        (code, rest)
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

pub fn host_limits() -> Value {
    json!({
        "max_connections": 64,
        "max_streams_per_connection": 16,
        "max_streams_total": 128,
        "max_handshakes": 64,
        "admit_timeout_ms": 5000,
        "drop_grace_ms": 1000,
    })
}

pub fn member_limits() -> Value {
    json!({
        "max_preamble_sockets": 16,
        "max_streams": 16,
        "preamble_timeout_ms": 3000,
        "connect_timeout_ms": 5000,
    })
}

pub fn host_start(secret: &[u8; 32], boot: &[u8; 32], loopback_port: u16, limits: Value) -> Value {
    json!({
        "t": "start",
        "mode": "host",
        "secret_key": b64(secret),
        "boot_secret": b64(boot),
        "alpn": "jenny-team/1",
        "loopback_port": loopback_port,
        "direct_port": null,
        "limits": limits,
    })
}

pub fn member_start(
    secret: &[u8; 32],
    host_key: &str,
    addresses: &Value,
    launch: &[u8; 32],
    limits: Value,
) -> Value {
    json!({
        "t": "start",
        "mode": "member",
        "secret_key": b64(secret),
        "host_key": host_key,
        "addresses": addresses,
        "alpn": "jenny-team/1",
        "launch_secret": b64(launch),
        "limits": limits,
    })
}

/// The host's HTTP layer: a loopback listener that hands over every accepted socket.
pub struct FakeHttp {
    pub port: u16,
    pub accepted: Arc<AtomicUsize>,
    sockets: mpsc::Receiver<TcpStream>,
    task: JoinHandle<()>,
}

impl FakeHttp {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake http");
        let port = listener.local_addr().expect("local addr").port();
        let accepted = Arc::new(AtomicUsize::new(0));
        let (tx, sockets) = mpsc::channel(64);
        let counter = accepted.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                if tx.send(socket).await.is_err() {
                    return;
                }
            }
        });
        Self {
            port,
            accepted,
            sockets,
            task,
        }
    }

    pub async fn next_socket(&mut self) -> TcpStream {
        within("a loopback connection", self.sockets.recv())
            .await
            .expect("fake http running")
    }

    pub fn count(&self) -> usize {
        self.accepted.load(Ordering::SeqCst)
    }
}

impl Drop for FakeHttp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A host with a fake HTTP layer and one admitted, online member.
pub struct Pair {
    pub host: Bridge,
    pub member: Bridge,
    pub http: FakeHttp,
    pub boot: [u8; 32],
    pub host_public: String,
    pub addresses: Value,
    pub member_keys: Keys,
    pub launch: [u8; 32],
    pub port: u16,
}

/// Starts a host and returns it with its public key and addresses.
pub async fn start_host(
    http: &FakeHttp,
    boot: &[u8; 32],
    limits: Value,
) -> (Bridge, String, Value) {
    let mut host = Bridge::host();
    let host_keys = keys();
    host.send(host_start(&host_keys.secret, boot, http.port, limits))
        .await;
    let ready = host.expect("ready").await;
    assert_eq!(ready["public_key"], host_keys.public.as_str());
    let addresses = ready["addresses"].clone();
    assert!(
        !addresses.as_array().expect("addresses array").is_empty(),
        "the host reports at least one address"
    );
    (host, host_keys.public, addresses)
}

/// Starts a member against the host; does not answer the admit question.
pub async fn start_member(
    host_public: &str,
    addresses: &Value,
    limits: Value,
) -> (Bridge, Keys, [u8; 32]) {
    let mut member = Bridge::member();
    let member_keys = keys();
    let launch = random32();
    member
        .send(member_start(
            &member_keys.secret,
            host_public,
            addresses,
            &launch,
            limits,
        ))
        .await;
    member.expect_state("connecting").await;
    (member, member_keys, launch)
}

/// Answers the next admit question; checks it names `key`.
pub async fn admit(host: &mut Bridge, key: &str, kind: Value) -> u64 {
    let question = host.expect("admit").await;
    assert_eq!(question["key"], key);
    let conn = question["conn"].as_u64().expect("conn number");
    host.send(json!({ "t": "admit_answer", "conn": conn, "kind": kind }))
        .await;
    conn
}

pub async fn pair_with(host_limits: Value, member_limits: Value) -> Pair {
    let http = FakeHttp::start().await;
    let boot = random32();
    let (mut host, host_public, addresses) = start_host(&http, &boot, host_limits).await;
    let (mut member, member_keys, launch) =
        start_member(&host_public, &addresses, member_limits).await;
    admit(&mut host, &member_keys.public, json!("device")).await;
    host.expect_log("team.bridge.connection_admitted").await;
    let online = member.expect_state("online").await;
    let port = u16::try_from(online["port"].as_u64().expect("port")).expect("port fits");
    Pair {
        host,
        member,
        http,
        boot,
        host_public,
        addresses,
        member_keys,
        launch,
        port,
    }
}

pub async fn pair() -> Pair {
    pair_with(host_limits(), member_limits()).await
}

/// Connects to the member's loopback port and sends a valid preamble.
pub async fn client(port: u16, launch: &[u8; 32]) -> TcpStream {
    let mut socket = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect to member port");
    socket
        .write_all(&encode_member(launch)[..])
        .await
        .expect("write member preamble");
    socket
}
