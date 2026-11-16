//! Stranger pressure before the parent is asked (TEAM_INTERNET_SPEC I6, I7): the per-source
//! handshake rate, the handshake and waiting caps and the 0-RTT refusal. The cooldown has its
//! own file, `bridge_cooldown.rs`.

mod common;

use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};

use common::raw::*;
use common::*;
use iroh::endpoint::ConnectOptions;
use serde_json::json;
use tokio::task::JoinSet;

const LOOPBACK_V4: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// Starts `count` handshakes from `source`, each stalled before the client's Finished, so
/// each holds a handshake slot until the host's 5 s handshake timeout.
async fn stalled_flood(
    host_public: &str,
    at: std::net::SocketAddr,
    source: IpAddr,
    count: usize,
) -> (StallProxy, JoinSet<()>) {
    let proxy = StallProxy::start(at, source).await;
    let flooder = client_endpoint(&random32(), LOOPBACK_V4).await;
    let target = dial_addr(host_public, proxy.front);
    let mut flood = JoinSet::new();
    for _ in 0..count {
        let endpoint = flooder.clone();
        let target = target.clone();
        flood.spawn(async move {
            let _ = endpoint.connect(target, ALPN).await;
        });
    }
    (proxy, flood)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_source_flood_leaves_a_member_able_to_connect() {
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["max_handshakes"] = json!(6);
    limits["max_handshakes_per_source"] = json!(4);
    let (mut host, host_public, addresses) = start_host(&http, &random32(), limits).await;
    let at = ipv4_address(&addresses);
    let (_proxy, mut flood) =
        stalled_flood(&host_public, at, other_loopback_source().await, 200).await;

    // The stall holds before the member dials: the source is over its rate and none of its
    // handshakes has finished (no admit line), so its 4 allowed ones hold their slots.
    let summary = host
        .wait_for("the flood's summary", |line| {
            assert_ne!(line["t"], "admit", "a stalled handshake never finishes");
            is_summary(line) && line["fields"]["rate"].as_u64().unwrap_or(0) > 0
        })
        .await;
    assert_eq!(summary["fields"]["handshake_cap"], 0, "4 of the 6 slots");

    let member_keys = keys();
    let started = Instant::now();
    let mut member = start_member_as(
        &host_public,
        &json!([at.to_string()]),
        fast_member_limits(),
        &member_keys,
    )
    .await;
    let question = tokio::time::timeout(
        Duration::from_secs(3),
        host.wait_for("the member's admit question", |line| line["t"] == "admit"),
    )
    .await
    .expect("the member reaches the admit question within 3 s of a one-source flood");
    let took = started.elapsed();
    eprintln!("flood measurement: member admit question after {took:?}");
    assert_eq!(question["key"], member_keys.public.as_str());
    host.send(json!({ "t": "admit_answer", "conn": question["conn"], "kind": "device" }))
        .await;
    assert_eq!(settled(&mut member).await["state"], "online");
    assert_eq!(http.count(), 0, "the flood made no loopback connection");
    flood.shutdown().await;
}

/// The known limit: the per-source rate binds a member behind the flooder's own address too.
/// It is told nothing that reads as a refusal.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_member_behind_the_flooders_address_is_held_to_the_same_rate() {
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["max_handshakes"] = json!(6);
    limits["max_handshakes_per_source"] = json!(4);
    let (mut host, host_public, addresses) = start_host(&http, &random32(), limits).await;
    let at = ipv4_address(&addresses);
    let (_proxy, mut flood) = stalled_flood(&host_public, at, LOOPBACK_V4, 200).await;
    host.wait_for("the flood's summary", |line| {
        is_summary(line) && line["fields"]["rate"].as_u64().unwrap_or(0) > 0
    })
    .await;

    let mut member = start_member_as(
        &host_public,
        &json!([at.to_string()]),
        fast_member_limits(),
        &keys(),
    )
    .await;
    no_admit_for(&mut host, Duration::from_millis(1800)).await;
    let offline = settled(&mut member).await;
    assert_eq!(offline["state"], "offline");
    assert_eq!(offline["reason"], "host_unreachable");
    flood.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn member_behind_a_flooding_address_is_never_told_refused() {
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["max_handshakes_per_source"] = json!(2);
    let (mut host, host_public, addresses) = start_host(&http, &random32(), limits).await;
    let dial = json!([ipv4_address(&addresses).to_string()]);
    let mut members = Vec::new();
    for _ in 0..2 {
        let member_keys = keys();
        let mut member =
            start_member_as(&host_public, &dial, fast_member_limits(), &member_keys).await;
        admit(&mut host, &member_keys.public, json!("device")).await;
        assert_eq!(settled(&mut member).await["state"], "online");
        members.push(member);
    }

    let third_keys = keys();
    let mut third = start_member_as(&host_public, &dial, fast_member_limits(), &third_keys).await;
    let seen = no_admit_for(&mut host, Duration::from_millis(1800)).await;
    let offline = settled(&mut third).await;
    assert_eq!(offline["state"], "offline");
    assert_eq!(
        offline["reason"], "host_unreachable",
        "over the rate reads as unreachable, never as host_refused"
    );

    let summary = summary_after(&mut host, &seen).await;
    assert!(summary["fields"]["rate"].as_u64().unwrap_or(0) >= 1);
    let text = summary.to_string();
    for forbidden in [
        "127.0.0",
        "::1",
        &third_keys.public,
        &host_public,
        &ipv4_address(&addresses).port().to_string(),
    ] {
        assert!(
            !text.contains(forbidden),
            "summary leaks {forbidden}: {text}"
        );
    }
    for (name, value) in summary["fields"].as_object().expect("fields") {
        assert!(
            ["rate", "cooldown", "waiting_cap", "handshake_cap"].contains(&name.as_str()),
            "only counts by cause: {name}"
        );
        assert!(value.is_u64(), "counts only: {value}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn handshakes_past_the_cap_are_counted_in_the_summary() {
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["max_handshakes"] = json!(1);
    let (mut host, host_public, addresses) = start_host(&http, &random32(), limits).await;
    let (_proxy, mut flood) = stalled_flood(
        &host_public,
        ipv4_address(&addresses),
        other_loopback_source().await,
        3,
    )
    .await;
    let summary = host
        .wait_for("a handshake_cap count", |line| {
            is_summary(line) && line["fields"]["handshake_cap"].as_u64().unwrap_or(0) > 0
        })
        .await;
    assert_eq!(
        summary["fields"]["rate"], 0,
        "the cap spends no source's rate"
    );
    flood.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn waiting_cap_closes_one_more_connection_after_its_handshake() {
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["max_waiting"] = json!(2);
    let (mut host, host_public, addresses) = start_host(&http, &random32(), limits).await;
    let dial = json!([ipv4_address(&addresses).to_string()]);
    let mut waiting = Vec::new();
    let mut questions = Vec::new();
    for _ in 0..2 {
        let member_keys = keys();
        let member = start_member_as(&host_public, &dial, member_limits(), &member_keys).await;
        let question = host.expect("admit").await;
        assert_eq!(question["key"], member_keys.public.as_str());
        waiting.push(member);
        questions.push(question);
    }
    let mut over = start_member_as(&host_public, &dial, member_limits(), &keys()).await;
    let seen = no_admit_for(&mut host, Duration::from_millis(800)).await;
    let ended = over.expect_state("offline").await;
    assert_eq!(ended["reason"], "closed", "code 0, not a refusal");
    let summary = summary_after(&mut host, &seen).await;
    assert_eq!(summary["fields"]["waiting_cap"], 1);

    // An admitted connection no longer counts as waiting: the next one is asked about.
    host.send(json!({ "t": "admit_answer", "conn": questions[0]["conn"], "kind": "device" }))
        .await;
    host.expect_log("team.bridge.connection_admitted").await;
    let next_keys = keys();
    let _next = start_member_as(&host_public, &dial, member_limits(), &next_keys).await;
    let question = host.expect("admit").await;
    assert_eq!(question["key"], next_keys.public.as_str());
}

/// Characterizes iroh 1.4.1 and noq 1.4.0 against the 0-RTT rule. The host accepts early
/// data at the TLS layer (`iroh-1.4.1/src/tls.rs:125`), and noq marks a stream `is_0rtt` only
/// when it is accepted while the handshake is still running
/// (`noq-1.4.0/src/connection.rs:1168`). The bridge accepts streams only after admission,
/// which is after the handshake, so nothing early reaches loopback before the key check, and
/// an admitted client's early stream then arrives as an ordinary stream. If a later change
/// accepted streams earlier, `accept_stream` resets every `is_0rtt` stream with code 2.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn early_data_reaches_nothing_before_admission() {
    let mut http = FakeHttp::start().await;
    let (mut host, host_public, addresses) = start_host(&http, &random32(), host_limits()).await;
    let target = dial_addr(&host_public, ipv4_address(&addresses));
    let client_keys = keys();
    let client = client_endpoint(&client_keys.secret, LOOPBACK_V4).await;

    // A full handshake first, so the client holds a session ticket.
    let first = within("the first connection", client.connect(target.clone(), ALPN))
        .await
        .expect("first connection");
    admit(&mut host, &client_keys.public, json!("device")).await;
    host.expect_log("team.bridge.connection_admitted").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    first.close(0u32.into(), b"done");
    host.expect("conn_closed").await;

    let connecting = within(
        "the resumed dial",
        client.connect_with_opts(target, ALPN, ConnectOptions::new()),
    )
    .await
    .expect("connecting");
    let early = match connecting.into_0rtt() {
        Ok(early) => early,
        Err(_) => panic!("the client could not attempt 0-RTT"),
    };
    let (mut send, _recv) = within("an early stream", early.open_bi())
        .await
        .expect("open an early stream");
    send.write_all(b"GET / early").await.expect("early write");
    let question = host.expect("admit").await;
    assert_eq!(question["key"], client_keys.public.as_str());
    let status = within("the handshake", early.handshake_completed()).await;
    assert!(
        matches!(status, Ok(iroh::endpoint::ZeroRttStatus::Accepted(_))),
        "the host accepts early data at the TLS layer"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        http.count(),
        0,
        "no early byte reaches loopback before the admit answer"
    );

    host.send(json!({ "t": "admit_answer", "conn": question["conn"], "kind": "device" }))
        .await;
    let _socket = http.next_socket().await;
    assert!(
        !host.history_has(|line| {
            line["t"] == "log" && line["event"] == "team.bridge.stream_refused"
        }),
        "noq does not mark a stream accepted after the handshake as 0-RTT"
    );
}

/// Finding 4's ceiling, measured: what one connection waiting for its admit answer can make
/// the host buffer. Every stream the host has not accepted still takes data up to the flow
/// control credit the host granted at the handshake (512 KiB per stream, 4 MiB per
/// connection, `src/pipe.rs`); nothing reads it, so the credit is never extended.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_waiting_connection_buffers_at_most_its_connection_window() {
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["admit_timeout_ms"] = json!(4000);
    let (mut host, host_public, addresses) = start_host(&http, &random32(), limits).await;
    let client = client_endpoint(&random32(), LOOPBACK_V4).await;
    let conn = within(
        "the connection",
        client.connect(dial_addr(&host_public, ipv4_address(&addresses)), ALPN),
    )
    .await
    .expect("connect");
    host.expect("admit").await;

    let mut writers = JoinSet::new();
    for _ in 0..16 {
        let (mut send, recv) = within("a stream", conn.open_bi())
            .await
            .expect("open a stream");
        writers.spawn(async move {
            let chunk = vec![0u8; 16 * 1024];
            let mut total = 0usize;
            while let Ok(Ok(written)) =
                tokio::time::timeout(Duration::from_millis(400), send.write(&chunk)).await
            {
                total += written;
            }
            drop(recv);
            total
        });
    }
    let mut total = 0usize;
    while let Some(written) = writers.join_next().await {
        total += written.expect("writer");
    }
    eprintln!("buffered measurement: one waiting connection took {total} bytes on 16 streams");
    assert!(
        total <= 4 * 1024 * 1024,
        "{total} bytes: more than the connection window"
    );
    assert!(
        total > 512 * 1024,
        "{total} bytes: the window, not a stall, ends the writes"
    );
    assert_eq!(http.count(), 0, "nothing reaches loopback while waiting");
}

#[test]
fn member_never_sends_early_data() {
    let source = include_str!("../src/member.rs");
    assert!(
        !source.contains("into_0rtt"),
        "the member dials with a full handshake only"
    );
}
