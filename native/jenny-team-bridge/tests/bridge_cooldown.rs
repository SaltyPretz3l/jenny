//! The refused-key cooldown in a running bridge (TEAM_INTERNET_SPEC I7): only an explicit
//! `null` answer that decides a waiting connection starts it; `drop` and a `device` or
//! `invite` answer clear it; the admit timeout and `drop` never start it.

mod common;

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use common::raw::*;
use common::*;
use iroh::endpoint::{Connection, ConnectionError};
use serde_json::{json, Value};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refused_key_is_not_asked_again_within_the_cooldown() {
    let http = FakeHttp::start().await;
    let (mut host, host_public, addresses) = start_host(&http, &random32(), host_limits()).await;
    let dial = json!([ipv4_address(&addresses).to_string()]);
    let stranger = keys();

    let mut first = start_member_as(&host_public, &dial, fast_member_limits(), &stranger).await;
    admit(&mut host, &stranger.public, Value::Null).await;
    let offline = first.expect_state("offline").await;
    assert_eq!(offline["reason"], "host_refused");

    let mut again = start_member_as(&host_public, &dial, fast_member_limits(), &stranger).await;
    no_admit_for(&mut host, Duration::from_millis(1000)).await;
    let offline = again.expect_state("offline").await;
    assert_eq!(
        offline["reason"], "host_cooldown",
        "a cooled key is turned away by the bridge's memory, which is not the host refusing it"
    );

    // A drop clears the key: the parent is asked again.
    host.send(json!({ "t": "drop", "key": stranger.public }))
        .await;
    let _later = start_member_as(&host_public, &dial, fast_member_limits(), &stranger).await;
    let question = host.expect("admit").await;
    assert_eq!(question["key"], stranger.public.as_str());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_or_invite_answer_clears_a_cooled_key() {
    for kind in ["device", "invite"] {
        let http = FakeHttp::start().await;
        let (mut host, host_public, addresses) =
            start_host(&http, &random32(), host_limits()).await;
        let dial = json!([ipv4_address(&addresses).to_string()]);
        let key = keys();
        let mut one = start_member_as(&host_public, &dial, fast_member_limits(), &key).await;
        let first = host.expect("admit").await;
        let mut two = start_member_as(&host_public, &dial, fast_member_limits(), &key).await;
        let second = host.expect("admit").await;
        host.send(json!({ "t": "admit_answer", "conn": first["conn"], "kind": null }))
            .await;
        assert_eq!(one.expect_state("offline").await["reason"], "host_refused");
        host.send(json!({ "t": "admit_answer", "conn": second["conn"], "kind": kind }))
            .await;
        assert_eq!(settled(&mut two).await["state"], "online", "{kind}");

        let _three = start_member_as(&host_public, &dial, fast_member_limits(), &key).await;
        let question = host.expect("admit").await;
        assert_eq!(
            question["key"],
            key.public.as_str(),
            "{kind} clears the key"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_admit_timeout_and_a_drop_never_cool_a_key() {
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["admit_timeout_ms"] = json!(300);
    let (mut host, host_public, addresses) = start_host(&http, &random32(), limits).await;
    let dial = json!([ipv4_address(&addresses).to_string()]);
    let key = keys();

    // Unanswered until the child's own timeout refuses it.
    let mut slow = start_member_as(&host_public, &dial, fast_member_limits(), &key).await;
    host.expect("admit").await;
    assert_eq!(
        slow.expect_state("offline").await["reason"],
        "host_admit_timeout"
    );
    let mut after_timeout = start_member_as(&host_public, &dial, fast_member_limits(), &key).await;
    let question = host.expect("admit").await;
    assert_eq!(
        question["key"],
        key.public.as_str(),
        "a timeout does not cool"
    );

    // Refused by a drop while it waits.
    host.send(json!({ "t": "drop", "key": key.public })).await;
    assert_eq!(
        after_timeout.expect_state("offline").await["reason"],
        "host_refused"
    );
    let _after_drop = start_member_as(&host_public, &dial, fast_member_limits(), &key).await;
    let question = host.expect("admit").await;
    assert_eq!(question["key"], key.public.as_str(), "a drop does not cool");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_late_null_for_an_admitted_connection_does_not_cool_the_key() {
    let http = FakeHttp::start().await;
    let (mut host, host_public, addresses) = start_host(&http, &random32(), host_limits()).await;
    let dial = json!([ipv4_address(&addresses).to_string()]);
    let key = keys();
    let mut member = start_member_as(&host_public, &dial, fast_member_limits(), &key).await;
    let conn = admit(&mut host, &key.public, json!("device")).await;
    assert_eq!(settled(&mut member).await["state"], "online");
    host.expect_log("team.bridge.connection_admitted").await;

    // The answer changes nothing: the connection was decided already.
    host.send(json!({ "t": "admit_answer", "conn": conn, "kind": null }))
        .await;
    let _again = start_member_as(&host_public, &dial, fast_member_limits(), &key).await;
    let question = host.expect("admit").await;
    assert_eq!(question["key"], key.public.as_str());
}

/// The close a raw client reads: its application code and reason bytes.
async fn close_of(conn: &Connection) -> (u64, String) {
    match within("the close", conn.closed()).await {
        ConnectionError::ApplicationClosed(close) => (
            close.error_code.into_inner(),
            String::from_utf8_lossy(&close.reason).into_owned(),
        ),
        other => panic!("not an application close: {other}"),
    }
}

/// Each way the host bridge turns a connection away has its own close code (review round two,
/// R11-F01): 1 only when the host application refused, 3 for the bridge's refused-key cooldown
/// and 4 for an unanswered admit. A member built before codes 3 and 4 knows only code 1 as a
/// refusal and reads the other two as unreachable or closed; none of them is admitted.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_turn_away_has_its_own_close_code_and_none_is_admitted() {
    let http = FakeHttp::start().await;
    let mut limits = host_limits();
    limits["admit_timeout_ms"] = json!(300);
    let (mut host, host_public, addresses) = start_host(&http, &random32(), limits).await;
    let target = dial_addr(&host_public, ipv4_address(&addresses));
    let stranger = keys();
    let client = client_endpoint(&stranger.secret, IpAddr::V4(Ipv4Addr::LOCALHOST)).await;

    let refused = within("a handshake", client.connect(target.clone(), ALPN))
        .await
        .expect("handshake");
    admit(&mut host, &stranger.public, Value::Null).await;
    assert_eq!(close_of(&refused).await, (1, "refused".to_string()));

    let cooled = within("a handshake", client.connect(target.clone(), ALPN))
        .await
        .expect("handshake");
    assert_eq!(close_of(&cooled).await, (3, "cooldown".to_string()));

    let silent_keys = keys();
    let silent_client = client_endpoint(&silent_keys.secret, IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    let silent = within("a handshake", silent_client.connect(target, ALPN))
        .await
        .expect("handshake");
    let question = host.expect("admit").await;
    assert_eq!(question["key"], silent_keys.public.as_str());
    assert_eq!(close_of(&silent).await, (4, "admit_timeout".to_string()));
    let asked = host.history().iter().filter(|line| line["t"] == "admit");
    assert_eq!(asked.count(), 2, "the cooled key was not asked about");
    assert_eq!(
        http.count(),
        0,
        "nothing reached the host's loopback listener"
    );
}

/// Review H11 and C3: the parent's `known_keys` (said in `ready`) clears the cooldown of a key
/// it newly names, the device key an invite was just redeemed for, while a key it already named
/// keeps its cooldown.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_newly_known_key_is_asked_again_and_a_known_one_stays_cooled() {
    let http = FakeHttp::start().await;
    let mut host = Bridge::host();
    host.send(host_start(
        &random32(),
        &random32(),
        http.port,
        host_limits(),
    ))
    .await;
    let ready = host.expect("ready").await;
    assert_eq!(
        ready["known_keys"], 1,
        "the bridge says it reads known_keys"
    );
    let host_public = ready["public_key"].as_str().expect("key").to_string();
    let dial = json!([ipv4_address(&ready["addresses"]).to_string()]);
    let device = keys();

    let mut first = start_member_as(&host_public, &dial, fast_member_limits(), &device).await;
    admit(&mut host, &device.public, Value::Null).await;
    assert_eq!(
        first.expect_state("offline").await["reason"],
        "host_refused"
    );
    let mut cooled = start_member_as(&host_public, &dial, fast_member_limits(), &device).await;
    no_admit_for(&mut host, Duration::from_millis(1000)).await;
    assert_eq!(
        cooled.expect_state("offline").await["reason"],
        "host_cooldown"
    );

    host.send(json!({ "t": "known_keys", "keys": [device.public] }))
        .await;
    let mut asked = start_member_as(&host_public, &dial, fast_member_limits(), &device).await;
    admit(&mut host, &device.public, Value::Null).await;
    assert_eq!(
        asked.expect_state("offline").await["reason"],
        "host_refused"
    );

    // The same set again: the key is not new to it, so the refusal above keeps it cooled.
    host.send(json!({ "t": "known_keys", "keys": [device.public] }))
        .await;
    let mut again = start_member_as(&host_public, &dial, fast_member_limits(), &device).await;
    no_admit_for(&mut host, Duration::from_millis(1000)).await;
    assert_eq!(
        again.expect_state("offline").await["reason"],
        "host_cooldown"
    );
}
