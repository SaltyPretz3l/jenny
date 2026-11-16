//! The mapping task alone, on paused tokio time, with a counting fake mapper and a recorder of
//! external addresses (TEAM_INTERNET_SPEC I3, I5).

mod common;

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::num::NonZeroU16;
use std::sync::Arc;
use std::time::Duration;

use common::fake_mapper::{FakeMapper, Gate, Recorder};
use jenny_team_bridge::control::Out;
use jenny_team_bridge::portmap::{
    run, Task, COALESCE, DEACTIVATE_BOUND, PROBE_BOUND, PROCURE_EVERY, UNAVAILABLE_AFTER,
};
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

const PORT: u16 = 41641;
const MS: Duration = Duration::from_millis(1);

struct Running {
    fake: Arc<FakeMapper>,
    recorder: Arc<Recorder>,
    addresses: watch::Sender<()>,
    stop: watch::Sender<bool>,
    lines: mpsc::Receiver<String>,
    task: JoinHandle<()>,
}

fn start(answers: bool) -> Running {
    start_with(FakeMapper::new(answers))
}

fn start_with(fake: Arc<FakeMapper>) -> Running {
    let recorder = Arc::new(Recorder::default());
    let (addresses, addresses_rx) = watch::channel(());
    let (stop, stop_rx) = watch::channel(false);
    let (tx, lines) = mpsc::channel(64);
    let task = tokio::spawn(run(Task {
        mapper: fake.clone(),
        port: NonZeroU16::new(PORT).expect("port"),
        external: recorder.clone(),
        addresses: addresses_rx,
        out: Out::new(tx),
        stop: stop_rx,
    }));
    Running {
        fake,
        recorder,
        addresses,
        stop,
        lines,
        task,
    }
}

impl Running {
    /// Lets the task run what is ready without moving the clock.
    async fn settle(&self) {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    /// Moves the clock by `by`, then lets the task run.
    async fn advance(&self, by: Duration) {
        tokio::time::sleep(by).await;
        self.settle().await;
    }

    /// Requests made so far: the first sets the local port, each later one procures.
    fn requests(&self) -> usize {
        self.fake.ports().len() + self.fake.procures()
    }

    /// The `mapping` lines written so far, as (state, external).
    fn states(&mut self) -> Vec<(String, Value)> {
        let mut seen = vec![];
        while let Ok(line) = self.lines.try_recv() {
            let line: Value = serde_json::from_str(&line).expect("json");
            assert_eq!(line["t"], "mapping", "only mapping lines: {line}");
            seen.push((
                line["state"].as_str().expect("state").to_string(),
                line["external"].clone(),
            ));
        }
        seen
    }
}

fn state(name: &str) -> (String, Value) {
    (name.to_string(), Value::Null)
}

fn mapped(addr: &str) -> (String, Value) {
    ("mapped".to_string(), Value::String(addr.to_string()))
}

fn v4(last: u8, port: u16) -> SocketAddrV4 {
    SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, last), port)
}

#[tokio::test(start_paused = true)]
async fn the_first_request_comes_after_the_probe_and_one_every_five_minutes() {
    let mut running = start(true);
    running.settle().await;
    assert_eq!(running.fake.probes(), 1, "a probe first");
    assert_eq!(
        running.fake.ports(),
        vec![PORT],
        "setting the port is the request"
    );
    assert_eq!(running.fake.procures(), 0, "no second request at start");
    assert_eq!(running.states(), vec![state("requesting")]);
    running
        .advance(PROCURE_EVERY - Duration::from_secs(1))
        .await;
    assert_eq!(running.requests(), 1, "nothing before five minutes");
    running.advance(Duration::from_secs(2)).await;
    assert_eq!((running.fake.probes(), running.fake.procures()), (2, 1));
    running.advance(PROCURE_EVERY).await;
    assert_eq!((running.fake.probes(), running.fake.procures()), (3, 2));
    assert_eq!(running.fake.ports(), vec![PORT], "the port is set once");
}

#[tokio::test(start_paused = true)]
async fn a_probe_that_never_answers_delays_the_request_by_the_bound_and_no_longer() {
    let mut running = start_with(FakeMapper::with(Gate::Never, Gate::Open));
    running.settle().await;
    assert_eq!(running.fake.probes(), 1);
    assert_eq!(
        running.states(),
        vec![state("requesting")],
        "the line does not wait"
    );
    running.advance(PROBE_BOUND - MS).await;
    assert_eq!(running.requests(), 0, "still waiting for the probe");
    running.advance(MS).await;
    assert_eq!(running.fake.ports(), vec![PORT], "asked at the bound");
    // The unavailable deadline counts from the start of the cycle, not from the request.
    running.advance(UNAVAILABLE_AFTER - PROBE_BOUND - MS).await;
    assert_eq!(running.states(), vec![]);
    running.advance(MS).await;
    assert_eq!(running.states(), vec![state("unavailable")]);
}

#[tokio::test(start_paused = true)]
async fn a_stop_during_the_probe_wait_deactivates_and_reports_off() {
    let mut running = start_with(FakeMapper::with(Gate::Never, Gate::Open));
    running.advance(Duration::from_secs(1)).await;
    let stopped_at = Instant::now();
    running.stop.send_replace(true);
    (&mut running.task).await.expect("the task ends");
    assert_eq!(
        stopped_at.elapsed(),
        Duration::ZERO,
        "the stop ends the wait at once"
    );
    assert_eq!(running.requests(), 0, "nothing asked after the stop");
    assert_eq!(running.fake.deactivates(), 1);
    assert_eq!(running.states(), vec![state("requesting"), state("off")]);
}

#[tokio::test(start_paused = true)]
async fn address_changes_coalesce_into_one_request_two_seconds_after_the_last() {
    let running = start(true);
    running.settle().await;
    assert_eq!(running.requests(), 1);
    for _ in 0..3 {
        running.addresses.send_replace(());
        running.advance(Duration::from_millis(400)).await;
    }
    // The last change was 400 ms ago.
    running
        .advance(COALESCE - Duration::from_millis(400) - MS)
        .await;
    assert_eq!(running.requests(), 1, "nothing before the quiet time");
    running.advance(MS).await;
    assert_eq!(running.requests(), 2, "three changes, one request");
    assert_eq!(running.fake.probes(), 2, "probed before it");
    running.advance(Duration::from_secs(60)).await;
    assert_eq!(running.requests(), 2);
}

#[tokio::test(start_paused = true)]
async fn no_request_follows_an_address_change_while_mapped() {
    let mut running = start(true);
    running.settle().await;
    running.fake.map(Some(v4(1, 9000)));
    running.settle().await;
    assert_eq!(
        running.states(),
        vec![state("requesting"), mapped("198.51.100.1:9000")]
    );
    let (requests, probes) = (running.requests(), running.fake.probes());
    for _ in 0..3 {
        running.addresses.send_replace(());
        running.advance(COALESCE * 2).await;
    }
    // Nor the five-minute tick: the crate ignores a request while it holds a mapping.
    running.advance(PROCURE_EVERY).await;
    assert_eq!(
        (running.requests(), running.fake.probes()),
        (requests, probes)
    );
}

#[tokio::test(start_paused = true)]
async fn a_lapse_makes_exactly_one_request() {
    let mut running = start(true);
    running.settle().await;
    let addr = v4(2, 9001);
    running.fake.map(Some(addr));
    running.settle().await;
    running.states();
    let before = running.requests();
    running.fake.map(None);
    running.settle().await;
    assert_eq!(running.states(), vec![state("requesting")]);
    assert_eq!(
        running.recorder.events().last(),
        Some(&(false, SocketAddr::V4(addr)))
    );
    // Taking the address back changes the bridge's addresses: one more change to coalesce.
    running.addresses.send_replace(());
    running.advance(COALESCE * 3).await;
    assert_eq!(running.requests(), before + 1, "one request for the lapse");
    running.advance(UNAVAILABLE_AFTER).await;
    assert_eq!(running.requests(), before + 1);
    assert_eq!(running.states(), vec![state("unavailable")]);
}

#[tokio::test(start_paused = true)]
async fn an_address_that_cannot_be_the_routers_outside_one_is_no_mapping() {
    for bad in [
        Ipv4Addr::UNSPECIFIED,
        Ipv4Addr::LOCALHOST,
        Ipv4Addr::new(224, 0, 0, 1),
        Ipv4Addr::BROADCAST,
        Ipv4Addr::new(169, 254, 10, 20),
    ] {
        let mut running = start(true);
        running.settle().await;
        running.states();
        running.fake.map(Some(SocketAddrV4::new(bad, 9000)));
        running.settle().await;
        assert_eq!(running.states(), vec![], "{bad}: no mapped line");
        assert_eq!(
            running.recorder.events(),
            vec![],
            "{bad}: not handed to iroh"
        );
        running.advance(UNAVAILABLE_AFTER).await;
        assert_eq!(running.states(), vec![state("unavailable")], "{bad}");
        assert_eq!(running.requests(), 1, "{bad}: no extra request");

        // After a good mapping, a bad address takes it back and asks nothing.
        let good = v4(3, 9002);
        running.fake.map(Some(good));
        running.settle().await;
        running.states();
        running.fake.map(Some(SocketAddrV4::new(bad, 9000)));
        running.advance(COALESCE * 2).await;
        assert_eq!(running.states(), vec![state("requesting")], "{bad}");
        assert_eq!(
            running.recorder.events(),
            vec![(true, SocketAddr::V4(good)), (false, SocketAddr::V4(good))],
            "{bad}"
        );
        assert_eq!(running.requests(), 1, "{bad}: still no extra request");
        running.advance(UNAVAILABLE_AFTER).await;
        assert_eq!(running.states(), vec![state("unavailable")], "{bad}");
    }
}

#[tokio::test(start_paused = true)]
async fn the_same_address_twice_stays_announced_and_a_return_is_announced_again() {
    let mut running = start(true);
    running.settle().await;
    let addr = v4(4, 9003);
    running.fake.map(Some(addr));
    running.settle().await;
    running.fake.map(Some(addr));
    running.settle().await;
    assert_eq!(
        running.recorder.events(),
        vec![(true, SocketAddr::V4(addr))]
    );
    running.fake.map(None);
    running.settle().await;
    running.fake.map(Some(addr));
    running.settle().await;
    assert_eq!(
        running.recorder.events(),
        vec![
            (true, SocketAddr::V4(addr)),
            (false, SocketAddr::V4(addr)),
            (true, SocketAddr::V4(addr)),
        ]
    );
    assert_eq!(
        running.states(),
        vec![
            state("requesting"),
            mapped("198.51.100.4:9003"),
            state("requesting"),
            mapped("198.51.100.4:9003"),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn unavailable_after_ten_seconds_and_it_keeps_asking() {
    let mut running = start(true);
    running.settle().await;
    running.advance(UNAVAILABLE_AFTER - MS).await;
    assert_eq!(running.states(), vec![state("requesting")]);
    running.advance(MS).await;
    assert_eq!(running.states(), vec![state("unavailable")]);
    running.advance(PROCURE_EVERY).await;
    assert_eq!(running.fake.procures(), 1, "it keeps asking");
    assert_eq!(
        running.states(),
        vec![],
        "a line on a change, not per request"
    );

    running.fake.map(Some(v4(1, 9000)));
    running.settle().await;
    assert_eq!(running.states(), vec![mapped("198.51.100.1:9000")]);
}

#[tokio::test(start_paused = true)]
async fn mapped_adds_the_address_and_a_change_removes_the_old_one() {
    let mut running = start(true);
    running.settle().await;
    running.states();
    let first = v4(1, 9000);
    running.fake.map(Some(first));
    running.settle().await;
    assert_eq!(running.states(), vec![mapped("198.51.100.1:9000")]);
    assert_eq!(
        running.recorder.events(),
        vec![(true, SocketAddr::V4(first))]
    );

    let second = v4(2, 9001);
    running.fake.map(Some(second));
    running.settle().await;
    assert_eq!(running.states(), vec![mapped("198.51.100.2:9001")]);
    assert_eq!(
        running.recorder.events(),
        vec![
            (true, SocketAddr::V4(first)),
            (true, SocketAddr::V4(second)),
            (false, SocketAddr::V4(first)),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn stop_deactivates_within_the_bound_when_the_router_never_answers() {
    let mut running = start(false);
    running.settle().await;
    running.fake.map(Some(v4(3, 9002)));
    running.settle().await;
    running.states();
    let stopped_at = Instant::now();
    running.stop.send_replace(true);
    (&mut running.task).await.expect("the task ends");
    let took = stopped_at.elapsed();
    assert!(
        took >= DEACTIVATE_BOUND && took < DEACTIVATE_BOUND + Duration::from_millis(100),
        "bounded at {DEACTIVATE_BOUND:?}: {took:?}"
    );
    assert_eq!(running.fake.deactivates(), 1);
    assert_eq!(running.states(), vec![state("off")]);
    assert_eq!(
        running.recorder.events().last(),
        Some(&(false, SocketAddr::V4(v4(3, 9002))))
    );
}

#[tokio::test(start_paused = true)]
async fn stop_with_an_answering_router_is_immediate() {
    let mut running = start(true);
    running.settle().await;
    let stopped_at = Instant::now();
    running.stop.send_replace(true);
    (&mut running.task).await.expect("the task ends");
    assert!(stopped_at.elapsed() < Duration::from_millis(10));
    assert_eq!(running.fake.deactivates(), 1);
    assert_eq!(running.states(), vec![state("requesting"), state("off")]);
}
