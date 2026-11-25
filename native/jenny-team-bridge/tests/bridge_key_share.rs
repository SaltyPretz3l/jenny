//! A per-key share of the host's slots (independent review X3-F03): one admitted key holds at
//! most two connections and sixteen streams, so one device cannot lock every member out.

mod common;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use common::raw::*;
use common::*;
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::Endpoint;
use serde_json::{json, Value};
use tokio::net::UdpSocket;

/// Loopback IPv4 sources this machine can bind, `127.0.0.1` first, at most `wanted`.
async fn loopback_sources(wanted: u8) -> Vec<IpAddr> {
    let mut found = vec![];
    for last in 1..=wanted {
        let ip = IpAddr::V4(Ipv4Addr::new(127, 0, 0, last));
        if UdpSocket::bind((ip, 0)).await.is_ok() {
            found.push(ip);
        }
    }
    found
}

/// One raw client connection, admitted with `kind` once the host asks; returns its `conn` id.
async fn connect(
    host: &mut Bridge,
    endpoint: &Endpoint,
    target: &iroh::EndpointAddr,
    kind: Option<&str>,
) -> (Connection, Value) {
    let conn = within("a handshake", endpoint.connect(target.clone(), ALPN))
        .await
        .expect("handshake");
    let question = host.expect("admit").await;
    if let Some(kind) = kind {
        host.send(json!({ "t": "admit_answer", "conn": question["conn"], "kind": kind }))
            .await;
    }
    (conn, question["conn"].clone())
}

async fn stream(conn: &Connection) -> (SendStream, RecvStream) {
    let (mut send, recv) = conn.open_bi().await.expect("open a stream");
    send.write_all(b"a").await.expect("write");
    (send, recv)
}

/// True when the peer closed `conn` with the ordinary closed code within `limit`.
async fn closed_by_host(conn: &Connection, limit: Duration) -> bool {
    match tokio::time::timeout(limit, conn.closed()).await {
        Ok(iroh::endpoint::ConnectionError::ApplicationClosed(close)) => {
            u64::from(close.error_code) == 0
        }
        _ => false,
    }
}

async fn host_at(limits: Value) -> (Bridge, String, SocketAddr, FakeHttp) {
    let http = FakeHttp::start().await;
    let (host, host_public, addresses) = start_host(&http, &random32(), limits).await;
    let at = ipv4_address(&addresses);
    (host, host_public, at, http)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_key_opening_many_connections_leaves_room_for_another_key() {
    let mut limits = host_limits();
    limits["max_connections"] = json!(4);
    let (mut host, host_public, at, mut http) = host_at(limits).await;
    let target = dial_addr(&host_public, at);
    // Each source may start 8 handshakes per 10 s: spread one key's 40 dials over sources,
    // keeping one handshake for the second key.
    let sources = loopback_sources(6).await;
    let per_source = 8;
    let total = (per_source * sources.len() - 1).min(40);
    let flooder = random32();
    let mut endpoints = vec![];
    for ip in &sources {
        endpoints.push(client_endpoint(&flooder, *ip).await);
    }
    let mut held = vec![];
    for index in 0..total {
        let (conn, _) = connect(
            &mut host,
            &endpoints[index / per_source],
            &target,
            Some("device"),
        )
        .await;
        held.push(conn);
    }
    eprintln!(
        "one key opened {total} connections from {} sources",
        sources.len()
    );

    let other = client_endpoint(&random32(), sources[total / per_source]).await;
    let (second, _) = connect(&mut host, &other, &target, Some("device")).await;
    let (_send, _recv) = stream(&second).await;
    let _socket = http.next_socket().await;
    host.stats_where("the first key holds two, the second one", |line| {
        line["connections"] == 3
    })
    .await;
    let open = held
        .iter()
        .filter(|conn| conn.close_reason().is_none())
        .count();
    assert_eq!(open, 2, "the first key keeps two connections");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_oldest_connection_of_a_key_is_the_one_closed() {
    let (mut host, host_public, at, _http) = host_at(host_limits()).await;
    let target = dial_addr(&host_public, at);
    let endpoint = client_endpoint(&random32(), IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    let (first, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    let (second, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    host.stats_where("two connections", |line| line["connections"] == 2)
        .await;
    let (third, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    assert!(
        closed_by_host(&first, Duration::from_secs(3)).await,
        "the oldest is closed with the ordinary closed code"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(second.close_reason().is_none(), "the second stays");
    assert!(third.close_reason().is_none(), "the newest stays");
    host.stats_where("the replacement is counted", |line| {
        line["refused_connections"] == 1 && line["connections"] == 2
    })
    .await;
    assert!(
        !host.history_has(
            |line| line["t"] == "log" && line["event"] == "team.bridge.connection_refused"
        ),
        "nothing reads as a refusal"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_key_at_sixteen_streams_has_its_next_reset_while_another_key_gets_one() {
    let (mut host, host_public, at, mut http) = host_at(host_limits()).await;
    let target = dial_addr(&host_public, at);
    let endpoint = client_endpoint(&random32(), IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    let (one, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    let (two, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    let mut held = vec![];
    let mut sockets = vec![];
    for conn in [&one, &two] {
        for _ in 0..8 {
            held.push(stream(conn).await);
            sockets.push(http.next_socket().await);
        }
    }
    host.stats_where("sixteen streams", |line| line["streams"] == 16)
        .await;
    held.push(stream(&one).await);
    let refused = host.expect_log("team.bridge.stream_refused").await;
    assert_eq!(refused["fields"]["reason"], "key_cap");
    assert_eq!(refused["fields"]["streams"], 16);

    let other = client_endpoint(&random32(), IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    let (third, _) = connect(&mut host, &other, &target, Some("device")).await;
    held.push(stream(&third).await);
    sockets.push(http.next_socket().await);
    host.stats_where("another key's stream", |line| {
        line["streams"] == 17 && line["refused_streams"] == 1
    })
    .await;
    assert_eq!(http.count(), 17);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unknown_key_at_its_share_is_closed_unasked_and_its_refusal_still_cools_it() {
    let (mut host, host_public, at, _http) = host_at(host_limits()).await;
    let target = dial_addr(&host_public, at);
    let endpoint = client_endpoint(&random32(), IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    let (first, first_conn) = connect(&mut host, &endpoint, &target, None).await;
    let (second, _) = connect(&mut host, &endpoint, &target, None).await;
    // The third dial before any answer: nothing admitted to replace, so it is closed as the
    // waiting cap closes one, and the parent is not asked.
    let third = within("a handshake", endpoint.connect(target.clone(), ALPN))
        .await
        .expect("handshake");
    no_admit_for(&mut host, Duration::from_millis(1000)).await;
    assert!(
        closed_by_host(&third, Duration::from_secs(3)).await,
        "the newcomer is closed with the ordinary closed code"
    );
    assert!(first.close_reason().is_none(), "the first still waits");
    assert!(second.close_reason().is_none(), "the second still waits");

    // The refusal for the first decides it, so the key cools: the next dial is not asked.
    host.send(json!({ "t": "admit_answer", "conn": first_conn, "kind": null }))
        .await;
    tokio::time::timeout(Duration::from_secs(3), first.closed())
        .await
        .expect("the refused one closes");
    let _fourth = within("a handshake", endpoint.connect(target.clone(), ALPN)).await;
    no_admit_for(&mut host, Duration::from_millis(1000)).await;
}

/// Review H11: a reconnect still waiting for its answer never pushes the live admitted link out;
/// the oldest admitted one gives its slot only once the key holds more than two admitted.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_waiting_reconnect_never_pushes_out_the_admitted_link() {
    let (mut host, host_public, at, _http) = host_at(host_limits()).await;
    let target = dial_addr(&host_public, at);
    let endpoint = client_endpoint(&random32(), IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    let (admitted, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    host.stats_where("one connection", |line| line["connections"] == 1)
        .await;
    let (waiting, waiting_conn) = connect(&mut host, &endpoint, &target, None).await;
    let (third, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(admitted.close_reason().is_none(), "the admitted link stays");
    assert!(waiting.close_reason().is_none(), "the waiting one stays");
    assert!(third.close_reason().is_none(), "the newest stays");
    host.send(json!({ "t": "admit_answer", "conn": waiting_conn, "kind": "device" }))
        .await;
    assert!(
        closed_by_host(&admitted, Duration::from_secs(3)).await,
        "a third admitted takes the oldest one's slot"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        waiting.close_reason().is_none(),
        "the newly admitted one stays"
    );
    assert!(third.close_reason().is_none(), "the newest stays");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_host_still_takes_a_member_reconnect_in_place_of_its_oldest() {
    let mut limits = host_limits();
    limits["max_connections"] = json!(2);
    let (mut host, host_public, at, mut http) = host_at(limits).await;
    let target = dial_addr(&host_public, at);
    let endpoint = client_endpoint(&random32(), IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    let (first, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    let (_second, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    host.stats_where("the host is full", |line| line["connections"] == 2)
        .await;
    // `live - freed`: the oldest's slot passes to the newcomer, which is asked and admitted.
    let (third, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    assert!(closed_by_host(&first, Duration::from_secs(3)).await);
    let (_send, _recv) = stream(&third).await;
    let _socket = http.next_socket().await;
    assert!(
        !host.history_has(
            |line| line["t"] == "log" && line["event"] == "team.bridge.connection_refused"
        ),
        "no connection_cap refusal"
    );
}

/// Review H11: a dropped connection that is still draining holds no connection slot, so a full
/// host takes the next member while the drain runs out.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_draining_connection_holds_no_connection_slot() {
    let mut limits = host_limits();
    limits["max_connections"] = json!(1);
    limits["drop_grace_ms"] = json!(5000);
    let (mut host, host_public, at, mut http) = host_at(limits).await;
    let target = dial_addr(&host_public, at);
    let dropped = keys();
    let endpoint = client_endpoint(&dropped.secret, IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    let (old, _) = connect(&mut host, &endpoint, &target, Some("device")).await;
    // An open stream keeps the drain going until its deadline.
    let (_send, _recv) = stream(&old).await;
    let _socket = http.next_socket().await;
    host.send(json!({ "t": "drop", "key": dropped.public }))
        .await;
    host.expect_log("team.bridge.dropped").await;
    let other = client_endpoint(&random32(), IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    let (second, _) = connect(&mut host, &other, &target, Some("device")).await;
    let (_send2, _recv2) = stream(&second).await;
    let _socket2 = http.next_socket().await;
    assert!(
        old.close_reason().is_none(),
        "the drained one is still draining"
    );
    assert!(
        !host.history_has(|line| line["t"] == "log"
            && line["event"] == "team.bridge.connection_refused"
            && line["fields"]["reason"] == "connection_cap"),
        "no connection_cap refusal while the drain runs"
    );
}
