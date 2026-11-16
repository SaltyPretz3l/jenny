//! The admission tables with a test clock: the rate window, the cooldown, oldest-first
//! eviction at each bound, and the summary counts.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};

use iroh::endpoint::IncomingAddr;
use iroh::{RelayUrl, SecretKey};
use jenny_team_bridge::admission::{
    relayed_slot_share, send_summary, slots_full, Admission, Cause, Counts, Source,
    MAX_COOLED_KEYS, MAX_RELAYED_SOURCES, MAX_SOURCES, RATE_WINDOW,
};
use jenny_team_bridge::control::Out;
use tokio::sync::mpsc;

const COOLDOWN: Duration = Duration::from_secs(60);

fn v4(index: u32) -> Source {
    Source::direct(IpAddr::V4(Ipv4Addr::from(0x0a00_0000 + index)))
}

fn key(index: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    key[..4].copy_from_slice(&index.to_be_bytes());
    key
}

#[test]
fn a_source_gets_its_rate_per_window_then_again_after_it() {
    let start = Instant::now();
    let mut admission = Admission::new(8, COOLDOWN);
    for _ in 0..8 {
        assert!(admission.allow_handshake(v4(1), start));
    }
    assert!(
        !admission.allow_handshake(v4(1), start),
        "the ninth is over the rate"
    );
    assert!(
        admission.allow_handshake(v4(2), start),
        "another source has its own rate"
    );
    let almost = start + RATE_WINDOW - Duration::from_millis(1);
    assert!(!admission.allow_handshake(v4(1), almost));
    assert!(admission.allow_handshake(v4(1), start + RATE_WINDOW));
    assert_eq!(admission.take_counts().rate, 2);
}

#[test]
fn ipv6_sources_share_their_64_and_mapped_ipv4_is_ipv4() {
    let start = Instant::now();
    let mut admission = Admission::new(1, COOLDOWN);
    let one: Ipv6Addr = "2001:db8:1:2::1".parse().expect("v6");
    let same_net: Ipv6Addr = "2001:db8:1:2:ffff::9".parse().expect("v6");
    let other_net: Ipv6Addr = "2001:db8:1:3::1".parse().expect("v6");
    assert!(admission.allow_handshake(Source::direct(one.into()), start));
    assert!(!admission.allow_handshake(Source::direct(same_net.into()), start));
    assert!(admission.allow_handshake(Source::direct(other_net.into()), start));

    let mapped: Ipv6Addr = Ipv4Addr::new(192, 0, 2, 7).to_ipv6_mapped();
    assert_eq!(
        Source::direct(mapped.into()),
        Source::direct(Ipv4Addr::new(192, 0, 2, 7).into())
    );
}

#[test]
fn the_rate_table_evicts_its_oldest_source_at_the_bound() {
    let now = Instant::now();
    let mut admission = Admission::new(1, COOLDOWN);
    assert!(admission.allow_handshake(v4(0), now));
    for index in 1..u32::try_from(MAX_SOURCES).expect("fits") {
        assert!(admission.allow_handshake(v4(index), now));
    }
    assert_eq!(admission.sizes().0, MAX_SOURCES);
    assert!(
        !admission.allow_handshake(v4(0), now),
        "still remembered while the table holds it"
    );
    assert!(admission.allow_handshake(v4(9_999), now));
    assert_eq!(admission.sizes().0, MAX_SOURCES, "the bound holds");
    assert!(
        admission.allow_handshake(v4(0), now),
        "the oldest source was evicted and starts again"
    );
}

#[test]
fn a_refused_key_cools_down_and_is_cleared() {
    let start = Instant::now();
    let mut admission = Admission::new(8, COOLDOWN);
    admission.refused(key(1), start);
    assert!(admission.is_cooling(&key(1), start));
    assert!(!admission.is_cooling(&key(2), start));
    assert!(admission.is_cooling(&key(1), start + COOLDOWN - Duration::from_millis(1)));
    assert!(!admission.is_cooling(&key(1), start + COOLDOWN));

    admission.refused(key(3), start);
    admission.clear(&key(3));
    assert!(
        !admission.is_cooling(&key(3), start),
        "a drop or an admit clears it"
    );
    assert_eq!(admission.sizes().1, 0);
}

#[test]
fn the_cooldown_table_evicts_its_oldest_key_at_the_bound() {
    let now = Instant::now();
    let mut admission = Admission::new(8, COOLDOWN);
    for index in 0..u32::try_from(MAX_COOLED_KEYS).expect("fits") {
        admission.refused(key(index), now);
    }
    assert_eq!(admission.sizes().1, MAX_COOLED_KEYS);
    assert!(admission.is_cooling(&key(0), now));
    admission.refused(key(99_999), now);
    assert_eq!(admission.sizes().1, MAX_COOLED_KEYS, "the bound holds");
    assert!(
        !admission.is_cooling(&key(0), now),
        "the oldest key was evicted"
    );
    assert!(admission.is_cooling(&key(1), now));
    assert!(admission.is_cooling(&key(99_999), now));
}

#[test]
fn a_refused_key_refused_again_is_renewed_not_duplicated() {
    let start = Instant::now();
    let mut admission = Admission::new(8, COOLDOWN);
    admission.refused(key(1), start);
    admission.refused(key(2), start);
    admission.refused(key(1), start + Duration::from_secs(30));
    assert_eq!(admission.sizes().1, 2);
    // Key 2 expires first; key 1 lives on until its renewed end.
    assert!(!admission.is_cooling(&key(2), start + COOLDOWN));
    assert!(admission.is_cooling(&key(1), start + COOLDOWN));
    assert!(!admission.is_cooling(&key(1), start + Duration::from_secs(90)));
}

#[test]
fn counts_are_kept_by_cause_and_start_again_after_each_summary() {
    let mut admission = Admission::new(8, COOLDOWN);
    assert!(!admission.take_counts().any());
    admission.note(Cause::Rate);
    admission.note(Cause::Rate);
    admission.note(Cause::Cooldown);
    admission.note(Cause::WaitingCap);
    admission.note(Cause::HandshakeCap);
    assert_eq!(
        admission.take_counts(),
        Counts {
            rate: 2,
            cooldown: 1,
            waiting_cap: 1,
            handshake_cap: 1,
        }
    );
    assert_eq!(admission.take_counts(), Counts::default());
}

fn direct(index: u32) -> IncomingAddr {
    IncomingAddr::Ip(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::from(0x0a00_0000 + index)),
        4433,
    ))
}

#[test]
fn attempts_the_handshake_cap_ignores_spend_no_rate() {
    let now = Instant::now();
    let mut admission = Admission::new(1, COOLDOWN);
    for _ in 0..5 {
        assert!(!admission.before_handshake(&direct(1), true, now));
    }
    assert!(
        admission.before_handshake(&direct(1), false, now),
        "the source's one handshake is still there once a slot frees"
    );
    assert!(!admission.before_handshake(&direct(1), false, now));
    let counts = admission.take_counts();
    assert_eq!(counts.handshake_cap, 5);
    assert_eq!(counts.rate, 1);
}

#[tokio::test]
async fn a_summary_waits_for_room_and_loses_no_count() {
    let (tx, mut rx) = mpsc::channel(1);
    tx.send("filler".to_string())
        .await
        .expect("fill the channel");
    let out = Out::new(tx);
    let mut admission = Admission::new(8, COOLDOWN);
    for _ in 0..3 {
        admission.note(Cause::Rate);
    }
    let counts = admission.take_counts();
    let writer = tokio::spawn({
        let out = out.clone();
        async move { send_summary(&out, counts).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(rx.recv().await.as_deref(), Some("filler"));
    let line = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("the summary arrives once there is room")
        .expect("channel open");
    let line: serde_json::Value = serde_json::from_str(&line).expect("json");
    assert_eq!(line["event"], "team.bridge.refusal_summary");
    assert_eq!(line["fields"]["rate"], 3);
    writer.await.expect("writer");

    admission.note(Cause::Rate);
    admission.note(Cause::Rate);
    send_summary(&out, admission.take_counts()).await;
    let line: serde_json::Value =
        serde_json::from_str(&rx.recv().await.expect("second line")).expect("json");
    assert_eq!(line["fields"]["rate"], 2, "3 + 2 counted, none lost");
}

/// A relayed connection whose relay claims the `index`th endpoint id.
fn relayed(index: u32) -> IncomingAddr {
    let mut seed = [7u8; 32];
    seed[..4].copy_from_slice(&index.to_be_bytes());
    let url: RelayUrl = "https://relay.example.com".parse().expect("relay url");
    IncomingAddr::Relay {
        url,
        endpoint_id: SecretKey::from_bytes(&seed).public(),
    }
}

// Review round two, R11-F02: relayed sources in their own table (TEAM_INTERNET_SPEC 5-1 known
// limits, repaid here).
#[test]
fn a_relayed_sender_with_fresh_keys_is_held_to_the_relayed_table() {
    let mut admission = Admission::new(8, COOLDOWN);
    let now = Instant::now();
    let direct = direct(9);
    for _ in 0..8 {
        assert!(admission.before_handshake(&direct, false, now));
    }
    assert!(
        !admission.before_handshake(&direct, false, now),
        "the direct source is over its rate"
    );
    let mut allowed = 0;
    for index in 0..5000 {
        if admission.before_handshake(&relayed(index), false, now) {
            allowed += 1;
        }
    }
    assert_eq!(
        allowed, MAX_RELAYED_SOURCES,
        "{allowed} relayed handshakes of one window were let through: one per id the table holds"
    );
    assert_eq!(admission.relayed_sources(), MAX_RELAYED_SOURCES);
    assert_eq!(
        admission.sizes().0,
        1,
        "the direct table holds only the direct source"
    );
}

#[test]
fn a_full_relayed_table_refuses_newcomers_keeps_its_known_ids_and_frees_after_the_window() {
    let mut admission = Admission::new(8, COOLDOWN);
    let start = Instant::now();
    for index in 0..MAX_RELAYED_SOURCES as u32 {
        assert!(admission.before_handshake(&relayed(index), false, start));
    }
    assert!(
        !admission.before_handshake(&relayed(99_999), false, start),
        "a new relayed source is refused while the table is full"
    );
    assert_eq!(admission.take_counts().rate, 1, "counted as rate");
    for _ in 1..8 {
        assert!(
            admission.before_handshake(&relayed(0), false, start),
            "a known relayed id keeps its own rate"
        );
    }
    assert!(!admission.before_handshake(&relayed(0), false, start));
    for index in 0..MAX_SOURCES as u32 {
        assert!(
            admission.before_handshake(&direct(index), false, start),
            "direct sources never see the relayed table"
        );
    }
    let later = start + RATE_WINDOW;
    assert!(
        admission.before_handshake(&relayed(99_999), false, later),
        "the table has room again once its windows pass"
    );
}

#[test]
fn relayed_dials_hold_at_most_half_the_handshake_slots() {
    assert_eq!(relayed_slot_share(64), 32);
    assert_eq!(relayed_slot_share(1), 1);
    let relay = relayed(1);
    let ip = direct(1);
    assert!(!slots_full(&relay, 31, 31, 64));
    assert!(slots_full(&relay, 32, 32, 64), "the relayed share is held");
    assert!(
        !slots_full(&ip, 32, 32, 64),
        "a direct member still finds a slot"
    );
    assert!(slots_full(&ip, 64, 32, 64));
    assert!(slots_full(&relay, 64, 0, 64));
}

#[test]
fn relayed_entries_never_evict_a_direct_sources_window() {
    let mut admission = Admission::new(8, COOLDOWN);
    let now = Instant::now();
    let direct = direct(9);
    for _ in 0..8 {
        assert!(admission.before_handshake(&direct, false, now));
    }
    assert!(!admission.before_handshake(&direct, false, now));
    for index in 0..4096 {
        admission.before_handshake(&relayed(index), false, now);
    }
    assert!(
        !admission.before_handshake(&direct, false, now),
        "the direct flooder got a fresh rate inside the same window"
    );
}
