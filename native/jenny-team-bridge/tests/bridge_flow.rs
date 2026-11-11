//! A host and a member in one process over loopback: echo, stranger, drops.

mod common;

use std::time::{Duration, Instant};

use common::*;
use jenny_team_bridge::preamble::decode_host;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BULK: usize = 200 * 1024;

fn pattern(seed: u8, len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

async fn read_host_preamble(socket: &mut tokio::net::TcpStream) -> [u8; 72] {
    let mut preamble = [0u8; 72];
    within("the host preamble", socket.read_exact(&mut preamble))
        .await
        .expect("read host preamble");
    preamble
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stream_carries_bulk_both_ways_after_the_preamble() {
    let mut pair = pair().await;
    let up = pattern(7, BULK);
    let down = pattern(91, BULK);

    let mut client = client(pair.port, &pair.launch).await;
    let up_copy = up.clone();
    let client_task = tokio::spawn(async move {
        client.write_all(&up_copy).await.expect("client write");
        client.shutdown().await.expect("client half-close");
        let mut received = Vec::new();
        client
            .read_to_end(&mut received)
            .await
            .expect("client read");
        received
    });

    let mut socket = pair.http.next_socket().await;
    let preamble = read_host_preamble(&mut socket).await;
    let decoded = decode_host(&preamble).expect("a well-formed host preamble comes first");
    assert_eq!(*decoded.secret, pair.boot);
    assert_eq!(b64(&decoded.remote_key), pair.member_keys.public);
    let mut request = Vec::new();
    within("the request", socket.read_to_end(&mut request))
        .await
        .expect("http read");
    assert_eq!(request.len(), BULK);
    assert!(request == up, "the request arrives intact");
    socket.write_all(&down).await.expect("http write");
    socket.shutdown().await.expect("http half-close");

    let received = within("the answer", client_task)
        .await
        .expect("client task");
    assert_eq!(received.len(), BULK);
    assert!(received == down, "the answer arrives intact");
    assert_eq!(pair.http.count(), 1);
    // The stream was counted while it lived, and uncounted once both directions ended.
    pair.host
        .stats_where("one live stream", |line| line["streams"] == 1)
        .await;
    pair.host
        .wait_for("streams back to zero", |line| {
            line["t"] == "stats" && line["streams"] == 0 && line["connections"] == 1
        })
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stranger_is_refused_before_any_stream() {
    let http = FakeHttp::start().await;
    let boot = random32();
    let (mut host, host_public, addresses) = start_host(&http, &boot, host_limits()).await;
    let (mut member, member_keys, _launch) =
        start_member(&host_public, &addresses, member_limits()).await;
    let conn = admit(&mut host, &member_keys.public, json!(null)).await;

    let offline = member.expect_state("offline").await;
    assert_eq!(offline["reason"], "host_refused");
    let (code, _) = member.finish().await;
    assert_eq!(code, 0);

    let refused = host.expect_log("team.bridge.connection_refused").await;
    assert_eq!(refused["fields"]["reason"], "not_admitted");
    assert_eq!(refused["fields"]["connections"], 0);
    let closed = host.expect("conn_closed").await;
    assert_eq!(closed["conn"], conn);
    host.stats_where("one refused connection", |line| {
        line["refused_connections"] == 1 && line["connections"] == 0
    })
    .await;
    assert_eq!(http.count(), 0, "a stranger reaches no loopback connection");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drop_lets_a_finished_answer_out_first() {
    let mut pair = pair().await;
    let mut client = client(pair.port, &pair.launch).await;
    client.write_all(b"GET /").await.expect("client write");

    let mut socket = pair.http.next_socket().await;
    read_host_preamble(&mut socket).await;
    let mut request = [0u8; 5];
    within("the request", socket.read_exact(&mut request))
        .await
        .expect("http read");
    assert_eq!(&request, b"GET /");

    let key = pair.member_keys.public.clone();
    pair.host.send(json!({ "t": "drop", "key": key })).await;
    let dropped = pair.host.expect_log("team.bridge.dropped").await;
    assert_eq!(dropped["fields"]["connections"], 1);

    let answer = pattern(3, 4096);
    socket.write_all(&answer).await.expect("http write");
    drop(socket);

    let mut received = Vec::new();
    within("the answer", client.read_to_end(&mut received))
        .await
        .expect("the answer ends cleanly, not reset");
    assert!(received == answer, "all 4 KiB arrive");
    let offline = pair.member.expect_state("offline").await;
    assert_eq!(offline["reason"], "host_refused");
    pair.host.expect("conn_closed").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drop_on_an_idle_stream_closes_within_the_grace() {
    let grace = 400;
    let mut limits = host_limits();
    limits["drop_grace_ms"] = json!(grace);
    let mut pair = pair_with(limits, member_limits()).await;
    let mut client = client(pair.port, &pair.launch).await;
    client.write_all(b"x").await.expect("client write");
    let mut socket = pair.http.next_socket().await;
    read_host_preamble(&mut socket).await;
    let mut request = [0u8; 1];
    within("the request", socket.read_exact(&mut request))
        .await
        .expect("http read");

    let started = Instant::now();
    let key = pair.member_keys.public.clone();
    pair.host.send(json!({ "t": "drop", "key": key })).await;
    let offline = pair.member.expect_state("offline").await;
    let elapsed = started.elapsed();
    assert_eq!(offline["reason"], "host_refused");
    // The stream never ended on its own, so the drain ran to its deadline, and no longer.
    assert!(
        elapsed >= Duration::from_millis(grace - 50),
        "closed after {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_millis(grace + 1500),
        "closed after {elapsed:?}"
    );
    // The loopback socket was given up: it ends without carrying anything more.
    let mut rest = Vec::new();
    let ended = within("the loopback socket to end", socket.read_to_end(&mut rest)).await;
    assert!(ended.is_err() || rest.is_empty());
    pair.host.expect("conn_closed").await;
}
