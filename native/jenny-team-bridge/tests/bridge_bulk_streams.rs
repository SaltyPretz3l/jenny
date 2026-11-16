//! Bulk streams on the wire: the class byte on each leg, the host's first-byte window, and
//! the member's second loopback port (shared caps, the bulk cap, the preamble gate,
//! `online`, stop).

mod common;

use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};

use common::raw::{addresses_of, client_endpoint, dial_addr, host_endpoint, ipv4_address, ALPN};
use common::*;
use iroh::endpoint::Connection;
use iroh::Endpoint;
use jenny_team_bridge::preamble::{decode_host, encode_member};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const HOST_PREAMBLE: usize = 72;

/// A host with a fake HTTP layer and one admitted raw client: a member bridge the test
/// writes stream bytes for itself, as a bridge that knows no stream classes would.
struct RawPair {
    host: Bridge,
    http: FakeHttp,
    boot: [u8; 32],
    conn: Connection,
    _endpoint: Endpoint,
}

async fn raw_pair() -> RawPair {
    let http = FakeHttp::start().await;
    let boot = random32();
    let (mut host, host_public, addresses) = start_host(&http, &boot, host_limits()).await;
    let client_keys = keys();
    let endpoint = client_endpoint(&client_keys.secret, IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    let target = dial_addr(&host_public, ipv4_address(&addresses));
    let conn = within("the handshake", endpoint.connect(target, ALPN))
        .await
        .expect("handshake");
    admit(&mut host, &client_keys.public, json!("device")).await;
    host.expect_log("team.bridge.connection_admitted").await;
    RawPair {
        host,
        http,
        boot,
        conn,
        _endpoint: endpoint,
    }
}

/// Everything the loopback socket receives until the bridge half-closes it, after checking
/// that the host preamble came first.
async fn arrived(socket: &mut TcpStream, boot: &[u8; 32]) -> Vec<u8> {
    let mut all = Vec::new();
    within("the stream's bytes", socket.read_to_end(&mut all))
        .await
        .expect("loopback read");
    assert!(all.len() >= HOST_PREAMBLE, "the preamble arrives whole");
    let decoded = decode_host(&all[..HOST_PREAMBLE]).expect("a well-formed host preamble");
    assert_eq!(*decoded.secret, *boot);
    all.split_off(HOST_PREAMBLE)
}

/// Waits for a `stats` line written from now on with this many live streams.
async fn streams_become(host: &mut Bridge, count: u64) {
    host.wait_for("the stream count", |line| {
        line["t"] == "stats" && line["streams"] == count
    })
    .await;
}

/// True when the other side ended the socket within `limit` without sending anything.
async fn ends_within(socket: &mut TcpStream, limit: Duration) -> bool {
    let mut rest = Vec::new();
    match tokio::time::timeout(limit, socket.read_to_end(&mut rest)).await {
        Ok(Ok(_)) => rest.is_empty(),
        Ok(Err(_)) => true,
        Err(_) => false,
    }
}

/// Opens a socket on `port` and sends one request byte; `None` when the member bridge
/// drops it within `limit` instead of carrying it.
async fn carried(pair: &Pair, port: u16, limit: Duration) -> Option<TcpStream> {
    let mut near = client(port, &pair.launch).await;
    near.write_all(b"a").await.expect("write");
    (!ends_within(&mut near, limit).await).then_some(near)
}

async fn refused(port: u16) -> bool {
    within("a refused connect", TcpStream::connect(("127.0.0.1", port)))
        .await
        .is_err()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_byte_first_arrives_in_place_after_the_preamble() {
    let mut raw = raw_pair().await;
    // PUT, GET, DELETE, HEAD, OPTIONS: what a member bridge with no classes sends first.
    for first in *b"PGDHO" {
        let request = [first, b' ', b'/', b'x'];
        let (mut send, _recv) = raw.conn.open_bi().await.expect("open a stream");
        send.write_all(&request).await.expect("write");
        send.finish().expect("finish");
        let mut socket = raw.http.next_socket().await;
        assert_eq!(arrived(&mut socket, &raw.boot).await, request);
    }
    assert_eq!(raw.http.count(), 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_class_byte_is_not_forwarded() {
    let mut raw = raw_pair().await;
    let (mut send, _recv) = raw.conn.open_bi().await.expect("open a stream");
    send.write_all(b"\x01PUT /x").await.expect("write");
    send.finish().expect("finish");
    let mut socket = raw.http.next_socket().await;
    assert_eq!(arrived(&mut socket, &raw.boot).await, b"PUT /x");

    // Only the first byte is a class byte: a later 0x01 is the request's own.
    let (mut send, _recv) = raw.conn.open_bi().await.expect("open a stream");
    send.write_all(b"\x01\x01G").await.expect("write");
    send.finish().expect("finish");
    let mut socket = raw.http.next_socket().await;
    assert_eq!(arrived(&mut socket, &raw.boot).await, b"\x01G");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn both_member_ports_deliver_the_request_unchanged() {
    let mut pair = pair().await;
    for port in [pair.port, pair.bulk_port] {
        let mut near = client(port, &pair.launch).await;
        near.write_all(b"GET /x").await.expect("write");
        near.shutdown().await.expect("half-close");
        let mut socket = pair.http.next_socket().await;
        assert_eq!(arrived(&mut socket, &pair.boot).await, b"GET /x");
        socket.write_all(b"ok").await.expect("answer");
        drop(socket);
        let mut answer = Vec::new();
        within("the answer", near.read_to_end(&mut answer))
            .await
            .expect("read");
        assert_eq!(answer, b"ok");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_silent_stream_is_reset_inside_the_window_and_frees_its_slot() {
    let mut raw = raw_pair().await;
    // The second stream's data makes the first, silent one visible to the host.
    let (_silent_send, mut silent_recv) = raw.conn.open_bi().await.expect("open a stream");
    let (mut send, _recv) = raw.conn.open_bi().await.expect("open a stream");
    send.write_all(b"G").await.expect("write");
    let opened = Instant::now();
    let _held = raw.http.next_socket().await;
    raw.host
        .stats_where("two counted streams", |line| line["streams"] == 2)
        .await;
    streams_become(&mut raw.host, 1).await;
    let waited = opened.elapsed();
    assert!(
        waited >= Duration::from_millis(2500) && waited < Duration::from_millis(6000),
        "reset at the 3 s window, not before and not much later: {waited:?}"
    );
    let mut byte = [0u8; 1];
    let read = within("the reset", silent_recv.read(&mut byte)).await;
    assert!(read.is_err(), "the silent stream is reset: {read:?}");
    assert_eq!(raw.http.count(), 1, "it never reached loopback");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stream_that_ends_before_a_request_byte_leaves_nothing() {
    let mut raw = raw_pair().await;
    // Ended with no byte at all: reset, no loopback socket.
    let (mut send, mut recv) = raw.conn.open_bi().await.expect("open a stream");
    send.finish().expect("finish");
    let mut byte = [0u8; 1];
    let read = within("the reset", recv.read(&mut byte)).await;
    assert!(read.is_err(), "an empty stream is reset: {read:?}");
    assert_eq!(raw.http.count(), 0);

    // The class byte and then the end: the same. A bulk stream with no request byte is
    // reset and opens no loopback socket either.
    let (mut send, mut recv) = raw.conn.open_bi().await.expect("open a stream");
    send.write_all(b"\x01").await.expect("write");
    send.finish().expect("finish");
    let read = within("the reset", recv.read(&mut byte)).await;
    assert!(read.is_err(), "an empty bulk stream is reset: {read:?}");
    raw.host
        .stats_where("no stream left", |line| line["streams"] == 0)
        .await;
    assert_eq!(raw.http.count(), 0, "neither reached loopback");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_member_bridge_writes_the_class_byte_on_the_bulk_port_only() {
    // A bare host endpoint: what the member bridge itself puts on the wire, unread by a
    // host bridge.
    let host_keys = keys();
    let endpoint = host_endpoint(&host_keys.secret).await;
    let (mut member, _keys, launch) =
        start_member(&host_keys.public, &addresses_of(&endpoint), member_limits()).await;
    let incoming = within("the member's dial", endpoint.accept())
        .await
        .expect("an incoming connection");
    let conn = within("the handshake", async { incoming.await })
        .await
        .expect("handshake");
    let online = member.expect_state("online").await;
    for (key, expected) in [("port", &b"GET /x"[..]), ("bulk_port", &b"\x01GET /x"[..])] {
        let port = u16::try_from(online[key].as_u64().expect("a port")).expect("port fits");
        let mut near = client(port, &launch).await;
        near.write_all(b"GET /x").await.expect("write");
        near.shutdown().await.expect("half-close");
        let (_send, mut recv) = within("the member's stream", conn.accept_bi())
            .await
            .expect("a stream");
        let all = within("the stream's bytes", recv.read_to_end(64))
            .await
            .expect("read");
        assert_eq!(all, expected, "what the {key} socket's stream carries");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_stop_ends_a_stream_still_waiting_for_its_request_byte() {
    let mut raw = raw_pair().await;
    // The class byte and nothing after: the host waits up to 3 s for the request byte.
    let (mut send, mut recv) = raw.conn.open_bi().await.expect("open a stream");
    send.write_all(b"\x01").await.expect("write");
    raw.host
        .stats_where("the waiting stream counted", |line| line["streams"] == 1)
        .await;
    let asked = Instant::now();
    raw.host.stop_until_stopped().await;
    let (code, _rest) = raw.host.finish().await;
    assert_eq!(code, 0);
    assert!(
        asked.elapsed() < Duration::from_millis(2000),
        "stop does not wait out the window: {:?}",
        asked.elapsed()
    );
    let mut byte = [0u8; 1];
    let read = within("the stream's end", recv.read(&mut byte)).await;
    assert!(read.is_err(), "the waiting stream is gone: {read:?}");
    assert_eq!(raw.http.count(), 0, "it never reached loopback");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_loopback_connect_that_fails_resets_the_stream() {
    let mut raw = raw_pair().await;
    // The host's HTTP layer is gone: its port refuses.
    let gone = std::mem::replace(&mut raw.http, FakeHttp::start().await);
    drop(gone);
    tokio::time::sleep(Duration::from_millis(100)).await;
    for request in [&b"GET /x"[..], &b"\x01PUT /x"[..]] {
        let (mut send, mut recv) = raw.conn.open_bi().await.expect("open a stream");
        send.write_all(request).await.expect("write");
        let mut byte = [0u8; 1];
        let read = within("the reset", recv.read(&mut byte)).await;
        assert!(read.is_err(), "the stream is reset: {read:?}");
    }
    raw.host
        .wait_for("no stream left", |line| {
            line["t"] == "stats" && line["streams"] == 0
        })
        .await;
    assert_eq!(raw.http.count(), 0, "nothing was forwarded anywhere");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn both_ports_share_the_stream_cap() {
    let mut limits = member_limits();
    limits["max_streams"] = json!(4);
    let mut pair = pair_with(host_limits(), limits).await;
    let ports = [pair.port, pair.bulk_port];
    // Two on each port: at the cap, and every one reaches the host.
    let mut held = Vec::new();
    for index in 0..4 {
        let mut near = client(ports[index % 2], &pair.launch).await;
        near.write_all(b"a").await.expect("write");
        held.push((near, pair.http.next_socket().await));
    }
    pair.host
        .stats_where("four live streams", |line| line["streams"] == 4)
        .await;
    // One past the cap on either port: the socket is dropped and nothing reaches the host.
    for port in ports {
        let mut over = client(port, &pair.launch).await;
        over.write_all(b"a").await.expect("write");
        assert!(ends_within(&mut over, WAIT).await, "port {port} is capped");
    }
    assert_eq!(pair.http.count(), 4);
    // A stream that ends gives its slot back to either port.
    drop(held.pop());
    streams_become(&mut pair.host, 3).await;
    // The member frees its own slot a moment after the host reports the stream gone.
    let mut passed = None;
    for _ in 0..50 {
        let mut again = client(pair.bulk_port, &pair.launch).await;
        again.write_all(b"a").await.expect("write");
        if !ends_within(&mut again, Duration::from_millis(200)).await {
            passed = Some(again);
            break;
        }
    }
    assert!(passed.is_some(), "the freed slot is never given out again");
    pair.http.next_socket().await;
    assert_eq!(pair.http.count(), 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_streams_have_their_own_cap_of_six() {
    let mut pair = pair().await;
    // Six bulk streams: at the cap, and every one reaches the host.
    let mut held = Vec::new();
    for _ in 0..6 {
        let near = carried(&pair, pair.bulk_port, Duration::from_millis(50)).await;
        held.push((near.expect("carried"), pair.http.next_socket().await));
    }
    // A seventh bulk socket is dropped; the ordinary port still has the rest of the
    // stream cap.
    let over = carried(&pair, pair.bulk_port, WAIT).await;
    assert!(over.is_none(), "a seventh bulk socket is dropped");
    assert_eq!(pair.http.count(), 6);
    let mut ordinary = Vec::new();
    for _ in 0..4 {
        let near = carried(&pair, pair.port, Duration::from_millis(50)).await;
        ordinary.push((near.expect("carried"), pair.http.next_socket().await));
    }
    assert_eq!(pair.http.count(), 10);
    // A bulk stream that ends gives its bulk slot back; the member frees it a moment
    // after the host reports the stream gone.
    drop(held.pop());
    streams_become(&mut pair.host, 9).await;
    let mut again = None;
    for _ in 0..50 {
        again = carried(&pair, pair.bulk_port, Duration::from_millis(200)).await;
        if again.is_some() {
            break;
        }
    }
    assert!(
        again.is_some(),
        "the freed bulk slot is never given out again"
    );
    pair.http.next_socket().await;
    assert_eq!(pair.http.count(), 11);
    // Back at six: the next bulk socket is dropped again.
    let over = carried(&pair, pair.bulk_port, WAIT).await;
    assert!(over.is_none(), "still six at most");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn both_ports_share_the_preamble_cap() {
    let mut limits = member_limits();
    limits["max_preamble_sockets"] = json!(3);
    let mut pair = pair_with(host_limits(), limits).await;
    // Three sockets that have not sent their preamble yet, across the two ports.
    let mut waiting = Vec::new();
    for port in [pair.port, pair.bulk_port, pair.port] {
        waiting.push(
            TcpStream::connect(("127.0.0.1", port))
                .await
                .expect("connect"),
        );
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    // One past the cap on either port is dropped at once, well inside the 3 s window.
    for port in [pair.bulk_port, pair.port] {
        let mut over = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        assert!(
            ends_within(&mut over, Duration::from_millis(1500)).await,
            "port {port} is capped"
        );
    }
    // The three at the cap were admitted: each still becomes a stream.
    for socket in &mut waiting {
        socket
            .write_all(&encode_member(&pair.launch)[..])
            .await
            .expect("preamble");
        socket.write_all(b"a").await.expect("write");
        pair.http.next_socket().await;
    }
    assert_eq!(pair.http.count(), 3);
    // Their preamble slots are free again.
    let mut next = client(pair.bulk_port, &pair.launch).await;
    next.write_all(b"a").await.expect("write");
    pair.http.next_socket().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_port_preamble_gate_drops_bad_sockets() {
    let mut limits = member_limits();
    limits["preamble_timeout_ms"] = json!(200);
    let mut pair = pair_with(host_limits(), limits).await;
    let port = pair.bulk_port;

    let mut wrong = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let mut other = pair.launch;
    other[0] ^= 1;
    wrong
        .write_all(&encode_member(&other)[..])
        .await
        .expect("write");
    wrong.write_all(b"GET /").await.expect("write");
    assert!(
        ends_within(&mut wrong, WAIT).await,
        "a wrong secret is dropped"
    );

    let mut short = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    short
        .write_all(&encode_member(&pair.launch)[..20])
        .await
        .expect("write");
    short.shutdown().await.expect("half-close");
    assert!(
        ends_within(&mut short, WAIT).await,
        "a short preamble is dropped"
    );

    let mut slow = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let started = Instant::now();
    slow.write_all(&encode_member(&pair.launch)[..39])
        .await
        .expect("write");
    assert!(
        ends_within(&mut slow, WAIT).await,
        "a slow preamble is dropped"
    );
    assert!(started.elapsed() >= Duration::from_millis(150));
    assert_eq!(pair.http.count(), 0, "no stream was opened");

    let mut valid = client(port, &pair.launch).await;
    valid.write_all(b"ok").await.expect("write");
    pair.http.next_socket().await;
    assert_eq!(pair.http.count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn online_names_both_ports_and_the_host_says_it_reads_classes() {
    let http = FakeHttp::start().await;
    let host_keys = keys();
    let mut host = Bridge::host();
    host.send(host_start(
        &host_keys.secret,
        &random32(),
        http.port,
        host_limits(),
    ))
    .await;
    let ready = host.expect("ready").await;
    assert_eq!(ready["bulk"], 1, "{ready}");
    let (mut member, member_keys, _launch) =
        start_member(&host_keys.public, &ready["addresses"], member_limits()).await;
    admit(&mut host, &member_keys.public, json!("device")).await;
    let online = member.expect_state("online").await;
    let port = online["port"].as_u64().expect("port");
    let bulk_port = online["bulk_port"].as_u64().expect("bulk port");
    assert!(
        bulk_port > 0 && bulk_port <= 65535 && bulk_port != port,
        "{online}"
    );
    assert_eq!(
        online,
        json!({ "t": "state", "state": "online", "port": port, "bulk_port": bulk_port })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_closes_both_listeners() {
    // The member's own stop.
    let mut pair = pair().await;
    let mut open = client(pair.bulk_port, &pair.launch).await;
    open.write_all(b"a").await.expect("write");
    let _held = pair.http.next_socket().await;
    pair.member.stop_until_stopped().await;
    assert_eq!(pair.member.finish().await.0, 0);
    assert!(refused(pair.port).await, "the ordinary port is closed");
    assert!(refused(pair.bulk_port).await, "the bulk port is closed");
    assert!(ends_within(&mut open, WAIT).await, "its socket is dropped");
    pair.host
        .wait_for("no stream left on the host", |line| {
            line["t"] == "stats" && line["streams"] == 0 && line["connections"] == 0
        })
        .await;

    // The host going away.
    let mut pair = pair_with(host_limits(), member_limits()).await;
    pair.host.stop_until_stopped().await;
    pair.member.expect_state("offline").await;
    assert_eq!(pair.member.finish().await.0, 0);
    assert!(refused(pair.port).await, "the ordinary port is closed");
    assert!(refused(pair.bulk_port).await, "the bulk port is closed");
}
