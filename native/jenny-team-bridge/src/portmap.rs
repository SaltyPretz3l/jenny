//! Port mapping while internet joining is on (TEAM_INTERNET_SPEC I2, I3, I5, slice 5-2): one
//! task asks the home router to forward the direct UDP port, reports `mapping` lines to the
//! parent, hands the mapped address to iroh and asks the router to delete the mapping at stop.
//! This is the only file that names the `portmapper` crate; the real client is built in
//! [`router`] and nowhere else.

use std::fmt::Debug;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::num::NonZeroU16;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::watch;
use tokio::time::{sleep_until, timeout, Instant};

use crate::control::Out;
use crate::host::stopping;

/// How often the bridge asks again while it runs (I5).
pub const PROCURE_EVERY: Duration = Duration::from_secs(5 * 60);
/// With no external address this long after a request, the mapping is `unavailable`.
pub const UNAVAILABLE_AFTER: Duration = Duration::from_secs(10);
/// How long a request waits for the router probe's answer before it goes out anyway.
pub const PROBE_BOUND: Duration = Duration::from_secs(3);
/// Address changes this close together make one request, this long after the last.
pub const COALESCE: Duration = Duration::from_secs(2);
/// How long the stop waits for the delete to go out, so a silent router cannot hold it.
pub const DEACTIVATE_BOUND: Duration = Duration::from_secs(2);

/// A boxed future, so the traits stay object safe without another crate.
pub type Pending<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// The calls the bridge makes on a port mapping client; tests use a fake.
pub trait Mapper: Send + Sync + Debug {
    /// Asks which protocols the router speaks; resolves when the answer is in. The caller
    /// bounds it.
    fn probe(&self) -> Pending<'_>;
    fn update_local_port(&self, port: NonZeroU16);
    fn procure_mapping(&self);
    fn watch_external_address(&self) -> watch::Receiver<Option<SocketAddrV4>>;
    /// Asks the router to delete the mapping; resolves once that request has gone out as far
    /// as the client can tell. The caller bounds it.
    fn deactivate(&self) -> Pending<'_>;
}

/// Where a mapped address is announced: the endpoint in the bridge, a recorder in tests.
pub trait External: Send + Sync {
    fn add(&self, addr: SocketAddr) -> Pending<'_>;
    fn remove(&self, addr: SocketAddr) -> Pending<'_>;
}

impl External for iroh::Endpoint {
    fn add(&self, addr: SocketAddr) -> Pending<'_> {
        Box::pin(self.add_external_addr(addr))
    }

    fn remove(&self, addr: SocketAddr) -> Pending<'_> {
        Box::pin(async move {
            self.remove_external_addr(&addr).await;
        })
    }
}

#[derive(Debug)]
struct Router(portmapper::Client);

impl Mapper for Router {
    fn probe(&self) -> Pending<'_> {
        let answer = self.0.probe();
        Box::pin(async move {
            let _ = answer.await;
        })
    }

    fn update_local_port(&self, port: NonZeroU16) {
        self.0.update_local_port(port);
    }

    fn procure_mapping(&self) {
        self.0.procure_mapping();
    }

    fn watch_external_address(&self) -> watch::Receiver<Option<SocketAddrV4>> {
        self.0.watch_external_address()
    }

    fn deactivate(&self) -> Pending<'_> {
        let mut external = self.0.watch_external_address();
        let mapped = external.borrow().is_some();
        // A local port of `None`: the service drops the mapping and sends the router a delete
        // (`portmapper-0.19.3/src/lib.rs:235-244`, `:593-622`).
        self.0.deactivate();
        Box::pin(async move {
            if mapped {
                // The service clears the address and then awaits the router's release, with no
                // signal when that is done (`lib.rs:489-496`): the client stays alive (this
                // future never resolves) until the caller's bound ends it and drops the client.
                let _ = external.wait_for(Option::is_none).await;
                std::future::pending::<()>().await;
            }
        })
    }
}

/// The one place the real client is built, with the crate's defaults
/// (`portmapper-0.19.3/src/lib.rs:130-140`): each request goes to the protocol the last probe
/// found (PCP, then NAT-PMP, then UPnP, `lib.rs:640-664`), so the task probes first.
pub fn router() -> Arc<dyn Mapper> {
    Arc::new(Router(portmapper::Client::new(
        portmapper::Config::default(),
    )))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Requesting,
    Mapped(SocketAddrV4),
    Unavailable,
    Off,
}

fn line(phase: Phase) -> Value {
    let (state, external) = match phase {
        Phase::Requesting => ("requesting", Value::Null),
        Phase::Mapped(addr) => ("mapped", json!(addr.to_string())),
        Phase::Unavailable => ("unavailable", Value::Null),
        Phase::Off => ("off", Value::Null),
    };
    json!({ "t": "mapping", "state": state, "external": external })
}

/// The mapping task: one per bridge, started only when the `start` line asks for it.
pub struct Task {
    pub mapper: Arc<dyn Mapper>,
    pub port: NonZeroU16,
    pub external: Arc<dyn External>,
    /// Marked changed on every change of the bridge's `addresses`.
    pub addresses: watch::Receiver<()>,
    pub out: Out,
    pub stop: watch::Receiver<bool>,
}

/// Runs until `stop`: asks at start, every [`PROCURE_EVERY`] and once after a burst of address
/// changes, each time only while no mapping is held and after a bounded probe; sends a
/// `mapping` line on each change of state; deactivates (bounded) and sends `off`.
pub async fn run(task: Task) {
    let Task {
        mapper,
        port,
        external,
        mut addresses,
        out,
        mut stop,
    } = task;
    let mut router = mapper.watch_external_address();
    let mut sent = None;
    // The address handed to iroh, if any.
    let mut announced: Option<SocketAddrV4> = None;
    // The crate holds a mapping, usable or not, and ignores a request (`lib.rs:626-629`).
    let mut held = false;
    let mut unavailable_at = Some(Instant::now() + UNAVAILABLE_AFTER);
    // A request owed for address changes, made once they have been quiet for [`COALESCE`].
    let mut owed: Option<Instant> = None;
    let (mut router_open, mut addresses_open) = (true, true);
    report(&out, &mut sent, Phase::Requesting).await;
    // Setting the local port is the first request (`lib.rs:593-622`): no second one follows.
    let mut stopped = !request(&*mapper, &mut stop, Some(port)).await;
    addresses.borrow_and_update();
    let mut next_request = Instant::now() + PROCURE_EVERY;
    while !stopped {
        // One timer: the next request, the owed one or the unavailable deadline.
        let deadline = [owed, unavailable_at]
            .into_iter()
            .flatten()
            .fold(next_request, Instant::min);
        tokio::select! {
            biased;
            _ = stopping(&mut stop) => break,
            changed = router.changed(), if router_open => {
                if changed.is_err() {
                    router_open = false;
                    continue;
                }
                let now = *router.borrow_and_update();
                // A lapse asks once, coalesced with the address change our own remove causes.
                let lapsed = held && now.is_none();
                held = now.is_some();
                if lapsed {
                    owed = Some(Instant::now() + COALESCE);
                } else if held {
                    owed = None;
                }
                match now.filter(|addr| usable(*addr.ip())) {
                    Some(addr) => {
                        if announced != Some(addr) {
                            external.add(addr.into()).await;
                            if let Some(old) = announced.replace(addr) {
                                external.remove(old.into()).await;
                            }
                        }
                        unavailable_at = None;
                        report(&out, &mut sent, Phase::Mapped(addr)).await;
                    }
                    None => {
                        // No mapping, or an address that cannot be the router's outside one:
                        // a new cycle that ends `unavailable` at its deadline.
                        if let Some(old) = announced.take() {
                            external.remove(old.into()).await;
                            unavailable_at = Some(Instant::now() + UNAVAILABLE_AFTER);
                            report(&out, &mut sent, Phase::Requesting).await;
                        }
                    }
                }
            }
            changed = addresses.changed(), if addresses_open => {
                if changed.is_err() {
                    addresses_open = false;
                    continue;
                }
                addresses.borrow_and_update();
                if !held {
                    owed = Some(Instant::now() + COALESCE);
                }
            }
            _ = sleep_until(deadline) => {
                let now = Instant::now();
                if unavailable_at.is_some_and(|at| at <= now) {
                    unavailable_at = None;
                    report(&out, &mut sent, Phase::Unavailable).await;
                }
                let due = owed.is_some_and(|at| at <= now) || next_request <= now;
                if due {
                    owed = None;
                    if !held {
                        stopped = !request(&*mapper, &mut stop, None).await;
                        addresses.borrow_and_update();
                    }
                    next_request = Instant::now() + PROCURE_EVERY;
                }
            }
        }
    }
    let _ = timeout(DEACTIVATE_BOUND, mapper.deactivate()).await;
    if let Some(old) = announced.take() {
        external.remove(old.into()).await;
    }
    report(&out, &mut sent, Phase::Off).await;
}

/// One request: a probe first, so the crate can pick PCP or NAT-PMP (`lib.rs:640-664`), waited
/// for at most [`PROBE_BOUND`], then the port (the first request) or a procure. False when a
/// stop came first; nothing is asked then.
async fn request(
    mapper: &dyn Mapper,
    stop: &mut watch::Receiver<bool>,
    port: Option<NonZeroU16>,
) -> bool {
    tokio::select! {
        biased;
        _ = stopping(stop) => return false,
        _ = timeout(PROBE_BOUND, mapper.probe()) => {}
    }
    match port {
        Some(port) => mapper.update_local_port(port),
        None => mapper.procure_mapping(),
    }
    true
}

/// False for an address no router's outside address can be: unspecified (a router whose WAN is
/// down), loopback, multicast, broadcast or link-local. Private and shared (100.64/10)
/// addresses pass: slice 5-5 reads them as "behind another router".
fn usable(ip: Ipv4Addr) -> bool {
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_link_local())
}

/// Sends the `mapping` line when the state changed: a line on a change, not per request.
async fn report(out: &Out, sent: &mut Option<Phase>, phase: Phase) {
    if *sent != Some(phase) {
        *sent = Some(phase);
        out.send(line(phase)).await;
    }
}
