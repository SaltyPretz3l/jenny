//! Port mapping in a running host, with a fake mapper (TEAM_INTERNET_SPEC I3, I5, T8). No test
//! here or anywhere starts the real client: a host with loopback sockets refuses `map_port`
//! unless a fake is given.

mod common;

use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::fake_mapper::{FakeMapper, Gate};
use common::*;
use jenny_team_bridge::portmap::{Mapper, DEACTIVATE_BOUND};
use jenny_team_bridge::RunOptions;
use serde_json::{json, Value};

/// Polls `holds` until it is true, for at most [`WAIT`].
async fn eventually(what: &str, holds: impl Fn() -> bool) {
    within(what, async {
        while !holds() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
}

fn with_mapper(fake: &Arc<FakeMapper>) -> RunOptions {
    RunOptions {
        mapper: Some(fake.clone() as Arc<dyn Mapper>),
        ..options()
    }
}

async fn start_mapping_host(fake: &Arc<FakeMapper>, internet: Value) -> (Bridge, u16, FakeHttp) {
    let http = FakeHttp::start().await;
    let port = free_udp_port();
    let mut host = Bridge::host_with(with_mapper(fake));
    let mut start = host_start(&random32(), &random32(), http.port, host_limits());
    start["direct_port"] = json!(port);
    start["internet"] = internet;
    host.send(start).await;
    host.expect("ready").await;
    (host, port, http)
}

fn is_mapping(line: &Value, state: &str) -> bool {
    line["t"] == "mapping" && line["state"] == state
}

async fn stop(mut host: Bridge) -> Vec<Value> {
    host.stop_until_stopped().await
}

/// The control lines (logs left out): `off` must be the last before `stopped`.
fn off_then_stopped(lines: &[Value]) {
    let control: Vec<&Value> = lines.iter().filter(|line| line["t"] != "log").collect();
    assert!(
        control.len() >= 2
            && is_mapping(control[control.len() - 2], "off")
            && control[control.len() - 1]["t"] == "stopped",
        "off is the last control line before stopped: {lines:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn map_port_asks_for_the_direct_port_at_start() {
    let fake = FakeMapper::new(true);
    let (mut host, port, _http) = start_mapping_host(&fake, json!({ "map_port": true })).await;
    let line = host
        .wait_for("requesting", |line| is_mapping(line, "requesting"))
        .await;
    assert_eq!(line["external"], Value::Null);
    // The line goes out at once; the request follows the probe.
    eventually("the request", || fake.ports() == vec![port]).await;
    assert_eq!(fake.probes(), 1);
    assert_eq!(
        fake.procures(),
        0,
        "setting the port is the one request at start"
    );
    stop(host).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_deactivates_and_reports_off_before_stopped() {
    let fake = FakeMapper::new(true);
    let (mut host, _port, _http) = start_mapping_host(&fake, json!({ "map_port": true })).await;
    host.wait_for("requesting", |line| is_mapping(line, "requesting"))
        .await;
    let lines = stop(host).await;
    assert_eq!(fake.deactivates(), 1);
    off_then_stopped(&lines);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stopped_waits_for_a_held_deactivate_and_off_comes_first() {
    let (gate, release) = Gate::held();
    let fake = FakeMapper::with(Gate::Open, gate);
    let (mut host, _port, _http) = start_mapping_host(&fake, json!({ "map_port": true })).await;
    host.wait_for("requesting", |line| is_mapping(line, "requesting"))
        .await;
    host.send(json!({ "t": "stop" })).await;
    eventually("the deactivate call", || fake.deactivates() == 1).await;
    // Held for less than the bound: `stopped` waits for the mapping task.
    let held = DEACTIVATE_BOUND / 2;
    let end = tokio::time::Instant::now() + held;
    let mut lines = vec![];
    while let Ok(line) = tokio::time::timeout_at(end, host.next()).await {
        assert_ne!(line["t"], "stopped", "stopped while the deactivate is held");
        lines.push(line);
    }
    release.send_replace(true);
    lines.extend(host.until_stopped().await);
    off_then_stopped(&lines);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_deactivate_that_never_resolves_still_stops_inside_the_bound() {
    let fake = FakeMapper::new(false);
    let (mut host, _port, _http) = start_mapping_host(&fake, json!({ "map_port": true })).await;
    host.wait_for("requesting", |line| is_mapping(line, "requesting"))
        .await;
    let asked = Instant::now();
    let lines = host.stop_until_stopped().await;
    let took = asked.elapsed();
    assert!(
        took >= DEACTIVATE_BOUND && took < DEACTIVATE_BOUND + Duration::from_secs(2),
        "bounded at {DEACTIVATE_BOUND:?}: {took:?}"
    );
    off_then_stopped(&lines);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn internet_null_creates_no_mapper_and_asks_nothing() {
    let fake = FakeMapper::new(true);
    let (host, _port, _http) = start_mapping_host(&fake, Value::Null).await;
    // Stop joins every task, so nothing can touch the fake after it.
    let lines = stop(host).await;
    assert_eq!(fake.calls(), 0, "the fake was never touched");
    assert!(lines.iter().all(|line| line["t"] != "mapping"), "{lines:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_mapped_address_reaches_the_endpoint_and_no_log_line() {
    let fake = FakeMapper::new(true);
    let (mut host, _port, _http) = start_mapping_host(&fake, json!({ "map_port": true })).await;
    host.wait_for("requesting", |line| is_mapping(line, "requesting"))
        .await;
    let first = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 7), 4444);
    fake.map(Some(first));
    let mapped = host
        .wait_for("mapped", |line| is_mapping(line, "mapped"))
        .await;
    assert_eq!(mapped["external"], "203.0.113.7:4444");
    let listed = |addr: &'static str| {
        move |line: &Value| {
            line["t"] == "addresses"
                && line["addresses"]
                    .as_array()
                    .is_some_and(|all| all.iter().any(|one| one == addr))
        }
    };
    host.seen_or_wait(
        "the endpoint lists the mapped address",
        listed("203.0.113.7:4444"),
    )
    .await;
    // With a mapping held an address change asks nothing (portmap_task.rs proves it on
    // paused time).

    let second = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 8), 5555);
    fake.map(Some(second));
    host.wait_for("the new address", |line| {
        is_mapping(line, "mapped") && line["external"] == "203.0.113.8:5555"
    })
    .await;
    host.wait_for("the old address gone", |line| {
        listed("203.0.113.8:5555")(line) && !listed("203.0.113.7:4444")(line)
    })
    .await;

    let mut lines = host.history().to_vec();
    lines.extend(stop(host).await);
    for line in lines.iter().filter(|line| line["t"] == "log") {
        let text = line.to_string();
        assert!(
            !text.contains("203.0.113"),
            "no mapped address in a log line: {text}"
        );
        assert!(
            !text.contains("4444") && !text.contains("5555"),
            "no port: {text}"
        );
    }
}

#[tokio::test]
async fn map_port_with_loopback_sockets_and_no_fake_is_start_invalid() {
    let mut host = Bridge::host();
    let mut start = host_start(&random32(), &random32(), 8080, host_limits());
    start["direct_port"] = json!(free_udp_port());
    start["internet"] = json!({ "map_port": true });
    host.send(start).await;
    let error = host.expect("error").await;
    assert_eq!(error["reason"], "start_invalid");
}

/// Internet joining without a relay still follows each connection's path, so the host can say a
/// member reached it from outside. There is no `relay` line without a relay.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn internet_joining_counts_paths_without_a_relay() {
    let fake = FakeMapper::new(true);
    let http = FakeHttp::start().await;
    let mut host = Bridge::host_with(with_mapper(&fake));
    let host_keys = keys();
    let mut start = host_start(&host_keys.secret, &random32(), http.port, host_limits());
    start["direct_port"] = json!(free_udp_port());
    start["internet"] = json!({ "map_port": true });
    host.send(start).await;
    let ready = host.expect("ready").await;
    let (mut member, member_keys, _launch) =
        start_member(&host_keys.public, &ready["addresses"], member_limits()).await;
    let question = host.wait_for("admit", |line| line["t"] == "admit").await;
    assert_eq!(question["key"], member_keys.public.as_str());
    host.send(json!({ "t": "admit_answer", "conn": question["conn"], "kind": "device" }))
        .await;
    member.expect_state("online").await;
    // A loopback peer is not an outside one: the counts are on the line and both are zero.
    let stats = host
        .stats_where("a stats line with the path counts", |line| {
            line["connections"] == 1
        })
        .await;
    assert_eq!(stats["direct_external_connections"], 0);
    assert_eq!(stats["relayed_connections"], 0);
    let mut lines = host.history().to_vec();
    lines.extend(stop(host).await);
    assert!(
        !lines.iter().any(|line| line["t"] == "relay"),
        "no relay line without a relay"
    );
}
