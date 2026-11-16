//! Stop, end of input, and the start timeout.

mod common;

use std::time::Duration;

use common::*;
use jenny_team_bridge::RunOptions;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_closes_everything_and_stopped_is_last() {
    let mut pair = pair().await;
    let mut client = client(pair.port, &pair.launch).await;
    client.write_all(b"GET /").await.expect("client write");
    let mut socket = pair.http.next_socket().await;

    let lines = pair.host.stop_until_stopped().await;
    let (code, rest) = pair.host.finish().await;
    assert_eq!(code, 0);
    assert!(rest.is_empty(), "stopped is the last host line: {rest:?}");
    let closed_at = lines
        .iter()
        .position(|line| line["t"] == "conn_closed")
        .expect("the connection reports closed");
    let log_at = lines
        .iter()
        .position(|line| line["t"] == "log" && line["event"] == "team.bridge.stopped")
        .expect("the stopped log line");
    assert!(closed_at < log_at);
    assert_eq!(log_at, lines.len() - 2);

    let offline = pair.member.expect_state("offline").await;
    assert_eq!(offline["reason"], "closed");
    let (code, _) = pair.member.finish().await;
    assert_eq!(code, 0);

    let mut rest = Vec::new();
    let ended = within("the loopback socket to end", socket.read_to_end(&mut rest)).await;
    // At most the preamble and the request that were already sent; the socket then ends.
    assert!(ended.is_err() || rest.len() <= 72 + 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn member_stop_reports_offline_then_stopped() {
    let mut pair = pair().await;
    pair.member.send(json!({ "t": "stop" })).await;
    let offline = pair.member.next().await;
    assert_eq!(offline["state"], "offline");
    assert_eq!(offline["reason"], "closed");
    assert_eq!(pair.member.next().await["t"], "stopped");
    let (code, rest) = pair.member.finish().await;
    assert_eq!(code, 0);
    assert!(rest.is_empty());
    pair.host.expect("conn_closed").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn end_of_input_exits_zero_and_writes_nothing_more() {
    let mut pair = pair().await;
    pair.host.close_input();
    let (code, rest) = pair.host.finish().await;
    assert_eq!(code, 0);
    assert!(
        rest.iter()
            .all(|line| line["t"] != "stopped" && line["t"] != "conn_closed"),
        "nothing is written after end of input: {rest:?}"
    );
    pair.member.close_input();
    let (code, _) = pair.member.finish().await;
    assert_eq!(code, 0);
}

#[tokio::test]
async fn end_of_input_before_start_exits_zero_silently() {
    for host in [true, false] {
        let mut bridge = if host {
            Bridge::host()
        } else {
            Bridge::member()
        };
        bridge.close_input();
        let (code, rest) = bridge.finish().await;
        assert_eq!(code, 0);
        assert!(rest.is_empty());
    }
}

#[tokio::test]
async fn missing_start_times_out() {
    let options = RunOptions {
        start_timeout: Duration::from_millis(100),
        loopback_only: true,
        ..RunOptions::default()
    };
    let mut bridge = Bridge::host_with(options.clone());
    assert_eq!(
        bridge.next().await,
        json!({ "t": "error", "reason": "start_timeout" })
    );
    assert_eq!(bridge.finish().await.0, 2);
    let mut bridge = Bridge::member_with(options);
    assert_eq!(
        bridge.next().await,
        json!({ "t": "error", "reason": "start_timeout" })
    );
    assert_eq!(bridge.finish().await.0, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unreachable_host_reports_offline() {
    let host = keys();
    let mut limits = member_limits();
    limits["connect_timeout_ms"] = json!(300);
    // A loopback port with nothing listening on it.
    let address = format!("127.0.0.1:{}", free_udp_port());
    let mut member = Bridge::member();
    member
        .send(member_start(
            &random32(),
            &host.public,
            &json!([address]),
            &random32(),
            limits,
        ))
        .await;
    member.expect_state("connecting").await;
    let offline = member.expect_state("offline").await;
    assert_eq!(offline["reason"], "host_unreachable");
    assert_eq!(member.finish().await.0, 0);
}

/// The binary runs with the default options: the relay's certificate is checked against the
/// embedded roots, never the test relay's trust (check_team_transport_boundary.py keeps the
/// seam out of src/main.rs).
#[test]
fn the_default_options_carry_no_test_relay_trust() {
    assert!(RunOptions::default().relay_tls.is_none());
}
