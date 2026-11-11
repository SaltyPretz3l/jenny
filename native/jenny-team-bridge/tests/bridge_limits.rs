//! Caps, the admit timeout, and the member preamble gate.

mod common;

use std::time::{Duration, Instant};

use common::*;
use jenny_team_bridge::preamble::encode_member;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// True when the socket was ended by the other side within the wait.
async fn ends(socket: &mut TcpStream) -> bool {
    let mut rest = Vec::new();
    match tokio::time::timeout(WAIT, socket.read_to_end(&mut rest)).await {
        Ok(Ok(_)) => rest.is_empty(),
        Ok(Err(_)) => true,
        Err(_) => false,
    }
}

/// True when nothing arrives on the socket within `quiet`.
async fn stays_quiet(socket: &mut TcpStream, quiet: Duration) -> bool {
    let mut byte = [0u8; 1];
    tokio::time::timeout(quiet, socket.read(&mut byte))
        .await
        .is_err()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn third_stream_on_a_connection_never_reaches_the_host() {
    let mut limits = host_limits();
    limits["max_streams_per_connection"] = json!(2);
    let mut pair = pair_with(limits, member_limits()).await;
    // Both ends of the first two streams stay open, so both stay live.
    let mut held = Vec::new();
    for _ in 0..2 {
        let mut socket = client(pair.port, &pair.launch).await;
        socket.write_all(b"a").await.expect("client write");
        held.push(socket);
        held.push(pair.http.next_socket().await);
    }
    pair.host
        .stats_where("two live streams", |line| line["streams"] == 2)
        .await;
    let mut third = client(pair.port, &pair.launch).await;
    third.write_all(b"a").await.expect("client write");
    assert!(stays_quiet(&mut third, Duration::from_millis(600)).await);
    assert_eq!(
        pair.http.count(),
        2,
        "the third stream never reaches the host"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn total_cap_refuses_a_stream_from_another_connection() {
    let mut limits = host_limits();
    limits["max_streams_total"] = json!(1);
    let mut pair = pair_with(limits, member_limits()).await;
    let mut first = client(pair.port, &pair.launch).await;
    first.write_all(b"a").await.expect("client write");
    let _held = pair.http.next_socket().await;

    let (mut second, second_keys, second_launch) =
        start_member(&pair.host_public, &pair.addresses, member_limits()).await;
    admit(&mut pair.host, &second_keys.public, json!("invite")).await;
    let online = second.expect_state("online").await;
    let port = u16::try_from(online["port"].as_u64().expect("port")).expect("port fits");
    let mut refused = client(port, &second_launch).await;
    refused.write_all(b"b").await.expect("client write");

    let log = pair.host.expect_log("team.bridge.stream_refused").await;
    assert_eq!(log["fields"]["reason"], "total_cap");
    assert_eq!(log["fields"]["streams"], 1);
    assert!(ends(&mut refused).await, "the refused stream is reset");
    pair.host
        .stats_where("one refused stream", |line| line["refused_streams"] == 1)
        .await;
    assert_eq!(pair.http.count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connection_cap_turns_a_second_member_away_before_any_question() {
    let mut limits = host_limits();
    limits["max_connections"] = json!(1);
    let mut pair = pair_with(limits, member_limits()).await;
    let (mut second, _keys, _launch) =
        start_member(&pair.host_public, &pair.addresses, member_limits()).await;

    let refused = pair
        .host
        .wait_for("a connection_cap refusal", |line| {
            assert_ne!(
                line["t"], "admit",
                "no admit question for a connection over the cap"
            );
            line["t"] == "log" && line["event"] == "team.bridge.connection_refused"
        })
        .await;
    assert_eq!(refused["fields"]["reason"], "connection_cap");
    assert_eq!(refused["fields"]["connections"], 1);
    let offline = second.expect_state("offline").await;
    assert_eq!(offline["reason"], "closed");
    pair.host
        .stats_where("one refused connection", |line| {
            line["refused_connections"] == 1 && line["connections"] == 1
        })
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unanswered_admit_is_refused_after_the_timeout() {
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["admit_timeout_ms"] = json!(300);
    let (mut host, host_public, addresses) = start_host(&http, &random32(), limits).await;
    let (mut member, member_keys, _launch) =
        start_member(&host_public, &addresses, member_limits()).await;
    let question = host.expect("admit").await;
    let asked = Instant::now();
    assert_eq!(question["key"], member_keys.public.as_str());

    let refused = host.expect_log("team.bridge.connection_refused").await;
    assert_eq!(refused["fields"]["reason"], "not_admitted");
    assert!(asked.elapsed() >= Duration::from_millis(250));
    let closed = host.expect("conn_closed").await;
    assert_eq!(closed["conn"], question["conn"]);
    let offline = member.expect_state("offline").await;
    assert_eq!(offline["reason"], "host_refused");
    // A late answer for the finished connection is ignored.
    host.send(json!({ "t": "admit_answer", "conn": question["conn"], "kind": "device" }))
        .await;
    assert_eq!(http.count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn member_preamble_gate_drops_bad_sockets() {
    let mut limits = member_limits();
    limits["preamble_timeout_ms"] = json!(200);
    let mut pair = pair_with(host_limits(), limits).await;

    let mut wrong = TcpStream::connect(("127.0.0.1", pair.port))
        .await
        .expect("connect");
    let mut other = pair.launch;
    other[0] ^= 1;
    wrong
        .write_all(&encode_member(&other)[..])
        .await
        .expect("write");
    wrong.write_all(b"GET /").await.expect("write");
    assert!(ends(&mut wrong).await, "a wrong secret is dropped");

    let mut short = TcpStream::connect(("127.0.0.1", pair.port))
        .await
        .expect("connect");
    short
        .write_all(&encode_member(&pair.launch)[..20])
        .await
        .expect("write");
    short.shutdown().await.expect("half-close");
    assert!(ends(&mut short).await, "a short preamble is dropped");

    let mut slow = TcpStream::connect(("127.0.0.1", pair.port))
        .await
        .expect("connect");
    let started = Instant::now();
    slow.write_all(&encode_member(&pair.launch)[..39])
        .await
        .expect("write");
    assert!(ends(&mut slow).await, "a slow preamble is dropped");
    assert!(started.elapsed() >= Duration::from_millis(150));

    assert_eq!(pair.http.count(), 0, "no stream was opened");

    // The gate still lets a valid preamble through.
    let mut valid = client(pair.port, &pair.launch).await;
    valid.write_all(b"ok").await.expect("write");
    pair.http.next_socket().await;
    assert_eq!(pair.http.count(), 1);
}
