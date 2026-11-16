//! The owner's relay through iroh's loopback test relay: one
//! custom relay on both sides, the host's `relay` lines and path counts, the member's `path`
//! and its two offline reasons, and the 5-1 and 5-2 rules over a relayed path. No test leaves
//! loopback or needs DNS.

mod common;

use std::time::{Duration, Instant};

use common::raw::ALPN;
use common::relay::*;
use common::*;
use iroh::endpoint::ConnectOptions;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "relay-token-for-the-loopback-test";
/// The default `unreachable` bound (`src/relay.rs`), plus slack for a loaded machine.
const UNREACHABLE_WITHIN: Duration = Duration::from_secs(13);
/// The shorter bound the absent-relay test sets, and its slack.
const SHORT_UNREACHABLE: Duration = Duration::from_secs(1);

async fn relay_host(http: &FakeHttp, relay: Value, limits: Value) -> (Bridge, Keys) {
    relay_host_with(relay_options(), http, relay, limits).await
}

async fn relay_host_with(
    options: jenny_team_bridge::RunOptions,
    http: &FakeHttp,
    relay: Value,
    limits: Value,
) -> (Bridge, Keys) {
    let mut host = Bridge::host_with(options);
    let host_keys = keys();
    let mut start = host_start(&host_keys.secret, &random32(), http.port, limits);
    start["relay"] = relay;
    host.send(start).await;
    host.expect("ready").await;
    (host, host_keys)
}

async fn relay_member(host_public: &str, relay: Value, limits: Value) -> (Bridge, Keys, [u8; 32]) {
    let mut member = Bridge::member_with(relay_options());
    let member_keys = keys();
    let launch = random32();
    let mut start = member_start(
        &member_keys.secret,
        host_public,
        &dead_address(),
        &launch,
        limits,
    );
    start["relay"] = relay;
    member.send(start).await;
    member.expect_state("connecting").await;
    (member, member_keys, launch)
}

fn is_relay(line: &Value, state: &str) -> bool {
    line["t"] == "relay" && line["state"] == state
}

/// Neither the token nor the relay's address is in any line.
fn assert_secret_free(lines: &[Value], url: &str) {
    let authority = url.trim_start_matches("https://");
    for line in lines {
        let text = line.to_string();
        assert!(!text.contains(TOKEN), "the token in a line: {text}");
        assert!(
            !text.contains(authority),
            "the relay address in a line: {text}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_member_with_no_working_address_connects_through_the_relay() {
    let relay = test_relay().await;
    let mut http = FakeHttp::start().await;
    let (mut host, host_keys) =
        relay_host(&http, relay_field(&relay.url, Some(TOKEN)), host_limits()).await;
    host.wait_for("relay connected", |line| is_relay(line, "connected"))
        .await;

    // Without a relay, the dead address is all the member has.
    let (mut alone, _, _) =
        relay_member(&host_keys.public, Value::Null, fast_member_limits()).await;
    let offline = alone.expect_state("offline").await;
    assert_eq!(offline["reason"], "host_unreachable");

    let field = relay_field(&relay.url, Some(TOKEN));
    let (mut member, member_keys, launch) =
        relay_member(&host_keys.public, field, member_limits()).await;
    admit(&mut host, &member_keys.public, json!("device")).await;
    let online = member.expect_state("online").await;
    assert_eq!(online["path"], "relay", "{online}");
    assert!(online["bulk_port"].is_u64(), "{online}");
    host.stats_where("one relayed connection", |line| {
        line["relayed_connections"] == 1
    })
    .await;

    let port = u16::try_from(online["port"].as_u64().expect("port")).expect("port fits");
    let mut client = client(port, &launch).await;
    // A QUIC stream reaches the host with its first bytes.
    client.write_all(b"ping").await.expect("client write");
    let mut socket = http.next_socket().await;
    let mut preamble = [0u8; 72];
    within("the host preamble", socket.read_exact(&mut preamble))
        .await
        .expect("preamble");
    let mut up = [0u8; 4];
    within("bytes up", socket.read_exact(&mut up))
        .await
        .expect("read up");
    assert_eq!(&up, b"ping");
    socket.write_all(b"pong").await.expect("host write");
    let mut down = [0u8; 4];
    within("bytes down", client.read_exact(&mut down))
        .await
        .expect("read down");
    assert_eq!(&down, b"pong");

    // Both sides are on loopback, so hole punching finds a direct path: one more line.
    let moved = member
        .wait_for("the path moves to direct", |line| {
            line["t"] == "state" && line["state"] == "online" && line["path"] == "direct"
        })
        .await;
    // The line after a path change names both ports again, unchanged.
    assert_eq!(moved["port"], online["port"]);
    assert_eq!(moved["bulk_port"], online["bulk_port"]);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    drop(client);
    let mut lines = member.stop_until_stopped().await;
    let paths: Vec<&Value> = member
        .history()
        .iter()
        .filter(|line| line["t"] == "state" && line["state"] == "online")
        .map(|line| &line["path"])
        .collect();
    assert_eq!(paths, vec!["relay", "direct"], "a line on a change only");
    lines.extend(member.history().iter().cloned());
    lines.extend(host.stop_until_stopped().await);
    lines.extend(host.history().iter().cloned());
    lines.extend(alone.history().iter().cloned());
    assert_secret_free(&lines, &relay.url);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_null_sends_no_relay_line_and_no_path() {
    let http = FakeHttp::start().await;
    let mut host = Bridge::host();
    let host_keys = keys();
    let mut start = host_start(&host_keys.secret, &random32(), http.port, host_limits());
    start["relay"] = Value::Null;
    host.send(start).await;
    let ready = host.expect("ready").await;
    let mut member = Bridge::member();
    let member_keys = keys();
    let mut start = member_start(
        &member_keys.secret,
        &host_keys.public,
        &ready["addresses"],
        &random32(),
        member_limits(),
    );
    start["relay"] = Value::Null;
    member.send(start).await;
    admit(&mut host, &member_keys.public, json!("device")).await;
    let online = member.expect_state("online").await;
    // `t`, `state`, `port` and `bulk_port`: no `path`.
    assert_eq!(online.as_object().expect("object").len(), 4, "{online}");
    assert!(online.get("path").is_none(), "{online}");
    host.stats_where("one connection", |line| line["connections"] == 1)
        .await;
    let mut lines = host.stop_until_stopped().await;
    lines.extend(host.history().iter().cloned());
    assert!(lines.iter().all(|line| line["t"] != "relay"), "{lines:?}");
    for line in lines.iter().filter(|line| line["t"] == "stats") {
        assert_eq!(line.as_object().expect("object").len(), 5, "{line}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_absent_relay_is_unreachable_in_the_bound_and_connected_once_it_comes_up() {
    let (url, port) = absent_relay();
    let http = FakeHttp::start().await;
    let started = Instant::now();
    let options = jenny_team_bridge::RunOptions {
        relay_unreachable_after: SHORT_UNREACHABLE,
        ..relay_options()
    };
    let field = relay_field(&url, None);
    let (mut host, _) = relay_host_with(options, &http, field, host_limits()).await;
    let waiting = host
        .wait_for("connecting", |line| is_relay(line, "connecting"))
        .await;
    let waited = Instant::now();
    host.wait_up_to(SHORT_UNREACHABLE * 4, "unreachable", |line| {
        is_relay(line, "unreachable")
    })
    .await;
    assert!(
        waited.elapsed() >= SHORT_UNREACHABLE / 2,
        "{waiting}: not before the bound"
    );
    eprintln!("unreachable after {:?}", started.elapsed());

    let relay = test_relay().await;
    let _forwarder = forward(port, relay.https).await;
    // The endpoint looks for its home relay again in its periodic report (20 to 26 s).
    host.wait_up_to(Duration::from_secs(45), "connected", |line| {
        is_relay(line, "connected")
    })
    .await;
    eprintln!("connected after {:?}", started.elapsed());
    let lines = host.stop_until_stopped().await;
    assert!(lines.iter().any(|line| is_relay(line, "off")), "{lines:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_relay_that_refuses_the_token_is_denied_on_both_sides() {
    let relay = test_relay_with_token(TOKEN).await;
    let http = FakeHttp::start().await;
    // The right token is let in, so the refusal below is about the token.
    let (mut admitted, admitted_keys) =
        relay_host(&http, relay_field(&relay.url, Some(TOKEN)), host_limits()).await;
    admitted
        .wait_up_to(UNREACHABLE_WITHIN, "relay connected", |line| {
            is_relay(line, "connected")
        })
        .await;

    let wrong = relay_field(&relay.url, Some("not-the-relay-token"));
    let (mut refused, _) = relay_host(&http, wrong.clone(), host_limits()).await;
    refused
        .wait_for("connecting", |line| is_relay(line, "connecting"))
        .await;
    refused
        .wait_up_to(UNREACHABLE_WITHIN, "denied", |line| {
            is_relay(line, "denied")
        })
        .await;
    // iroh retries a refused relay 10 ms to 16 s apart; `denied` holds through them.
    let more = tokio::time::timeout(
        Duration::from_secs(2),
        refused.wait_for("another relay line", |line| line["t"] == "relay"),
    )
    .await;
    assert!(more.is_err(), "denied flapped: {more:?}");

    let (mut member, _, _) = relay_member(&admitted_keys.public, wrong, member_limits()).await;
    let offline = member.expect_state("offline").await;
    assert_eq!(offline["reason"], "relay_denied", "{offline}");

    let mut lines = refused.stop_until_stopped().await;
    assert!(lines.iter().any(|line| is_relay(line, "off")), "{lines:?}");
    lines.extend(refused.history().iter().cloned());
    lines.extend(member.history().iter().cloned());
    lines.extend(admitted.stop_until_stopped().await);
    lines.extend(admitted.history().iter().cloned());
    assert_secret_free(&lines, &relay.url);
    for line in &lines {
        assert!(!line.to_string().contains("not-the-relay-token"), "{line}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reachable_relay_with_no_host_behind_the_key_ends_host_unreachable() {
    let relay = test_relay().await;
    let nobody = keys();
    let field = relay_field(&relay.url, None);
    // The whole connect timeout (5 s): the member's relay connects early in it.
    let (mut member, _, _) = relay_member(&nobody.public, field, member_limits()).await;
    let offline = member.expect_state("offline").await;
    assert_eq!(offline["reason"], "host_unreachable", "{offline}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_member_whose_relay_is_absent_ends_relay_unreachable() {
    let (url, _) = absent_relay();
    let http = FakeHttp::start().await;
    let (_host, host_keys) = relay_host(&http, Value::Null, host_limits()).await;
    let (mut member, _, _) = relay_member(
        &host_keys.public,
        relay_field(&url, None),
        fast_member_limits(),
    )
    .await;
    let offline = member.expect_state("offline").await;
    assert_eq!(offline["reason"], "relay_unreachable");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_with_a_relay_sends_off_before_stopped() {
    let relay = test_relay().await;
    let http = FakeHttp::start().await;
    let (mut host, _) = relay_host(&http, relay_field(&relay.url, None), host_limits()).await;
    host.wait_for("relay connected", |line| is_relay(line, "connected"))
        .await;
    let asked = Instant::now();
    let lines = host.stop_until_stopped().await;
    let took = asked.elapsed();
    eprintln!("stop with a relay took {took:?}");
    assert!(
        took < Duration::from_secs(4),
        "inside the stop bound: {took:?}"
    );
    let off = lines.iter().position(|line| is_relay(line, "off"));
    let stopped = lines.iter().position(|line| line["t"] == "stopped");
    assert!(off.is_some() && off < stopped, "{lines:?}");
    assert_eq!(
        lines.iter().filter(|line| line["t"] == "relay").count(),
        1,
        "off is the only relay line at stop: {lines:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_relayed_unknown_key_is_asked_refused_and_cooled() {
    let relay = test_relay().await;
    let http = FakeHttp::start().await;
    let (mut host, host_keys) =
        relay_host(&http, relay_field(&relay.url, None), host_limits()).await;
    host.wait_for("relay connected", |line| is_relay(line, "connected"))
        .await;
    let stranger = keys();
    let client = relay_client(&stranger.secret, &relay.url).await;
    let target = relay_dial(&host_keys.public, &relay.url);
    let first = within("a relayed handshake", client.connect(target.clone(), ALPN))
        .await
        .expect("handshake through the relay");
    admit(&mut host, &stranger.public, Value::Null).await;
    within("the refusal", first.closed()).await;
    // Cooled: the claimed id is ignored before the handshake, so the parent is not asked.
    let again = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(2), client.connect(target, ALPN)).await
    });
    no_admit_for(&mut host, Duration::from_millis(2500)).await;
    let again = again.await.expect("join");
    assert!(
        !matches!(again, Ok(Ok(_))),
        "a cooled relayed key does not connect"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relayed_dials_count_toward_the_key_share_and_the_handshake_rate() {
    let relay = test_relay().await;
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["max_handshakes_per_source"] = json!(3);
    let (mut host, host_keys) = relay_host(&http, relay_field(&relay.url, None), limits).await;
    host.wait_for("relay connected", |line| is_relay(line, "connected"))
        .await;
    let stranger = keys();
    let client = relay_client(&stranger.secret, &relay.url).await;
    let target = relay_dial(&host_keys.public, &relay.url);
    let mut held = vec![];
    for _ in 0..2 {
        held.push(
            within("a relayed dial", client.connect(target.clone(), ALPN))
                .await
                .expect("dial"),
        );
        host.expect("admit").await;
    }
    // The key's share is full with nothing admitted: the third is closed unasked.
    let third = within("the third dial", client.connect(target.clone(), ALPN))
        .await
        .expect("dial");
    within("the share closes it", third.closed()).await;
    // The fourth is past the claimed id's rate of 3: ignored before the handshake.
    let fourth = tokio::time::timeout(Duration::from_secs(2), client.connect(target, ALPN)).await;
    assert!(!matches!(fourth, Ok(Ok(_))), "over the rate");
    let summary = host
        .wait_for("the summary", |line| {
            is_summary(line) && line["fields"]["rate"].as_u64().unwrap_or(0) > 0
        })
        .await;
    assert!(
        host.history_has(
            |line| is_summary(line) && line["fields"]["waiting_cap"].as_u64().unwrap_or(0) > 0
        ),
        "the share's close is counted as waiting_cap: {summary}"
    );
    let asked = host.history().iter().filter(|line| line["t"] == "admit");
    assert_eq!(asked.count(), 2, "only the first two were asked about");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn early_data_over_the_relay_reaches_nothing_before_admission() {
    let relay = test_relay().await;
    let mut http = FakeHttp::start().await;
    let (mut host, host_keys) =
        relay_host(&http, relay_field(&relay.url, None), host_limits()).await;
    host.wait_for("relay connected", |line| is_relay(line, "connected"))
        .await;
    let client_keys = keys();
    let client = relay_client(&client_keys.secret, &relay.url).await;
    let target = relay_dial(&host_keys.public, &relay.url);
    let first = within("the first connection", client.connect(target.clone(), ALPN))
        .await
        .expect("first connection");
    admit(&mut host, &client_keys.public, json!("device")).await;
    host.expect_log("team.bridge.connection_admitted").await;
    // A round trip after admission: the session ticket, sent with the handshake's end, is in.
    let (mut send, mut recv) = within("a stream", first.open_bi()).await.expect("open");
    send.write_all(b"x").await.expect("write");
    let mut socket = http.next_socket().await;
    let mut head = [0u8; 73];
    within("the stream's bytes", socket.read_exact(&mut head))
        .await
        .expect("preamble and byte");
    socket.write_all(b"y").await.expect("answer");
    let mut answer = [0u8; 1];
    within("the answer", recv.read_exact(&mut answer))
        .await
        .expect("read the answer");
    drop((send, recv, socket));
    first.close(0u32.into(), b"done");
    host.expect("conn_closed").await;

    let connecting = within(
        "the resumed dial",
        client.connect_with_opts(target, ALPN, ConnectOptions::new()),
    )
    .await
    .expect("connecting");
    let Ok(early) = connecting.into_0rtt() else {
        panic!("the client could not attempt 0-RTT through the relay");
    };
    let (mut send, _recv) = within("an early stream", early.open_bi())
        .await
        .expect("open an early stream");
    send.write_all(b"GET / early").await.expect("early write");
    let question = host.expect("admit").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        http.count(),
        1,
        "no early byte reaches loopback before the answer (one socket was the round trip)"
    );
    host.send(json!({ "t": "admit_answer", "conn": question["conn"], "kind": "device" }))
        .await;
    let _socket = http.next_socket().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bad_relay_field_is_start_invalid_and_never_echoed() {
    // The parser's whole matrix is in tests/control_codec.rs; these three go through the binary.
    let good = "https://relay.example.com";
    let cases = [
        relay_field("https://owner@relay.example.com", Some(TOKEN)),
        relay_field("https://relay.example.com/path", Some(TOKEN)),
        json!({ "url": good, "token": format!("{TOKEN} with a space") }),
    ];
    for field in cases {
        for host_mode in [true, false] {
            let mut bridge = if host_mode {
                Bridge::host_with(relay_options())
            } else {
                Bridge::member_with(relay_options())
            };
            let mut start = if host_mode {
                host_start(&random32(), &random32(), 9, host_limits())
            } else {
                member_start(
                    &random32(),
                    &keys().public,
                    &dead_address(),
                    &random32(),
                    member_limits(),
                )
            };
            start["relay"] = field.clone();
            bridge.send(start).await;
            let error = bridge.expect("error").await;
            assert_eq!(error["reason"], "start_invalid", "{field}");
            let (_code, mut rest) = bridge.finish().await;
            rest.push(error);
            for line in &rest {
                let text = line.to_string();
                assert!(!text.contains("with a space"), "token echoed: {text}");
                assert!(!text.contains("relay.example.com"), "host echoed: {text}");
                assert!(!text.contains("owner"), "user info echoed: {text}");
            }
        }
    }
}

/// Review round two, R11-F02: with two handshake slots the relayed share is one, and each
/// finished relayed handshake gives its share back, so relayed dials one after another are all
/// asked about (a share that leaked would ignore the second).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_finished_relayed_handshake_gives_its_share_back() {
    let relay = test_relay().await;
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["max_handshakes"] = json!(2);
    let (mut host, host_keys) = relay_host(&http, relay_field(&relay.url, None), limits).await;
    host.wait_for("relay connected", |line| is_relay(line, "connected"))
        .await;
    let target = relay_dial(&host_keys.public, &relay.url);
    let mut held = vec![];
    for _ in 0..3 {
        let dialer = keys();
        let client = relay_client(&dialer.secret, &relay.url).await;
        let conn = within("a relayed dial", client.connect(target.clone(), ALPN))
            .await
            .expect("dial");
        admit(&mut host, &dialer.public, json!("device")).await;
        held.push((client, conn));
    }
    assert!(
        !host.history_has(|line| {
            is_summary(line) && line["fields"]["handshake_cap"].as_u64().unwrap_or(0) > 0
        }),
        "no relayed dial was turned away for want of a slot"
    );
}
