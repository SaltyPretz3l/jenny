//! A counting fake of the port mapping client, and a recorder of external addresses.

use std::net::{SocketAddr, SocketAddrV4};
use std::num::NonZeroU16;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use jenny_team_bridge::portmap::{External, Mapper, Pending};
use tokio::sync::watch;

/// How a fake call resolves: at once, never (a silent router), or when the test opens it.
#[derive(Debug, Clone)]
pub enum Gate {
    Open,
    Never,
    Held(watch::Receiver<bool>),
}

impl Gate {
    /// A held gate and the switch that opens it.
    pub fn held() -> (Self, watch::Sender<bool>) {
        let (open, held) = watch::channel(false);
        (Gate::Held(held), open)
    }

    async fn pass(self) {
        match self {
            Gate::Open => {}
            Gate::Never => std::future::pending::<()>().await,
            Gate::Held(mut held) => {
                let _ = held.wait_for(|open| *open).await;
            }
        }
    }
}

#[derive(Debug)]
pub struct FakeMapper {
    ports: Mutex<Vec<u16>>,
    procures: AtomicUsize,
    probes: AtomicUsize,
    deactivates: AtomicUsize,
    external: watch::Sender<Option<SocketAddrV4>>,
    probe: Gate,
    deactivate: Gate,
}

impl FakeMapper {
    /// Probes answer at once; `deactivate` answers at once, or never when `answers` is false.
    pub fn new(answers: bool) -> Arc<Self> {
        Self::with(Gate::Open, if answers { Gate::Open } else { Gate::Never })
    }

    pub fn with(probe: Gate, deactivate: Gate) -> Arc<Self> {
        Arc::new(Self {
            ports: Mutex::new(Vec::new()),
            procures: AtomicUsize::new(0),
            probes: AtomicUsize::new(0),
            deactivates: AtomicUsize::new(0),
            external: watch::channel(None).0,
            probe,
            deactivate,
        })
    }

    pub fn procures(&self) -> usize {
        self.procures.load(Ordering::SeqCst)
    }

    pub fn probes(&self) -> usize {
        self.probes.load(Ordering::SeqCst)
    }

    pub fn deactivates(&self) -> usize {
        self.deactivates.load(Ordering::SeqCst)
    }

    pub fn ports(&self) -> Vec<u16> {
        self.ports.lock().expect("ports").clone()
    }

    /// Every call the bridge made, so "touched nothing" is one assertion.
    pub fn calls(&self) -> usize {
        self.procures() + self.probes() + self.deactivates() + self.ports().len()
    }

    /// What the router "maps": the external address the fake reports.
    pub fn map(&self, addr: Option<SocketAddrV4>) {
        self.external.send_replace(addr);
    }
}

impl Mapper for FakeMapper {
    fn probe(&self) -> Pending<'_> {
        self.probes.fetch_add(1, Ordering::SeqCst);
        Box::pin(self.probe.clone().pass())
    }

    fn update_local_port(&self, port: NonZeroU16) {
        self.ports.lock().expect("ports").push(port.get());
    }

    fn procure_mapping(&self) {
        self.procures.fetch_add(1, Ordering::SeqCst);
    }

    fn watch_external_address(&self) -> watch::Receiver<Option<SocketAddrV4>> {
        self.external.subscribe()
    }

    fn deactivate(&self) -> Pending<'_> {
        self.deactivates.fetch_add(1, Ordering::SeqCst);
        Box::pin(self.deactivate.clone().pass())
    }
}

/// Records each `add` and `remove` of an external address, in order.
#[derive(Debug, Default)]
pub struct Recorder {
    events: Mutex<Vec<(bool, SocketAddr)>>,
}

impl Recorder {
    pub fn events(&self) -> Vec<(bool, SocketAddr)> {
        self.events.lock().expect("events").clone()
    }
}

impl External for Recorder {
    fn add(&self, addr: SocketAddr) -> Pending<'_> {
        self.events.lock().expect("events").push((true, addr));
        Box::pin(async {})
    }

    fn remove(&self, addr: SocketAddr) -> Pending<'_> {
        self.events.lock().expect("events").push((false, addr));
        Box::pin(async {})
    }
}
