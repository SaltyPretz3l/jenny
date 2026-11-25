//! Stranger pressure, bounded before the parent is asked (`docs/plans/TEAM_INTERNET_SPEC.md`,
//! I7): a per-source handshake rate, a refused-key cooldown, and the counts behind the one
//! summary log line. The waiting cap is counted here and enforced where connections register.
//!
//! The two tables have no timers: an entry ages out when the table is next used, and a full
//! table evicts its oldest entry. The caller passes the clock, so tests control time.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::Hash;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use iroh::endpoint::IncomingAddr;
use serde_json::json;
use tokio::sync::watch;

use crate::control::Out;
use crate::host::{stopping, Shared};

/// The rate window: at most `max_handshakes_per_source` handshakes per source in it.
pub const RATE_WINDOW: Duration = Duration::from_secs(10);
/// The most sources the rate table remembers.
pub const MAX_SOURCES: usize = 4096;
/// The most relayed sources (claimed endpoint ids) their own rate table remembers. A full
/// table refuses a new relayed source instead of evicting one, so fresh claimed ids cannot buy
/// fresh allowances: at most this many times the per-source rate per window come through the
/// relay, and direct sources are never touched.
pub const MAX_RELAYED_SOURCES: usize = 64;
/// The most keys the parent may name as known (review C3): its admitted devices and live
/// invites, far fewer than this on a team of eight.
pub const MAX_KNOWN_KEYS: usize = 128;
/// The most refused keys the cooldown table remembers.
pub const MAX_COOLED_KEYS: usize = 4096;
/// How often the summary line may be written.
pub const SUMMARY_INTERVAL: Duration = Duration::from_secs(1);

/// The defaults, which are also the ceilings: a `start` line may lower them, never raise them.
pub const MAX_WAITING: u32 = 16;
pub const MAX_HANDSHAKES_PER_SOURCE: u32 = 8;
pub const REFUSED_COOLDOWN_MS: u32 = 60_000;

/// Who a handshake is counted against.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Source {
    /// A direct IPv4 address.
    V4([u8; 4]),
    /// The /64 network of a direct IPv6 address: one host usually holds a whole /64.
    V6Net([u8; 8]),
    /// The endpoint id a relay names for a relayed connection (claimed, not proven).
    Relayed([u8; 32]),
}

impl Source {
    pub fn direct(ip: IpAddr) -> Self {
        match ip.to_canonical() {
            IpAddr::V4(v4) => Source::V4(v4.octets()),
            IpAddr::V6(v6) => {
                let mut net = [0u8; 8];
                net.copy_from_slice(&v6.octets()[..8]);
                Source::V6Net(net)
            }
        }
    }
}

/// Why an incoming connection was ignored or turned away before the parent was asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    Rate,
    Cooldown,
    WaitingCap,
    HandshakeCap,
}

/// What was ignored or refused since the last summary, by cause.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub rate: u64,
    pub cooldown: u64,
    pub waiting_cap: u64,
    pub handshake_cap: u64,
}

impl Counts {
    pub fn any(&self) -> bool {
        *self != Counts::default()
    }
}

/// A map with at most `bound` entries that remembers insertion order: a full map evicts the
/// entry inserted (or renewed) longest ago.
struct Aged<K, V> {
    entries: HashMap<K, (u64, V)>,
    order: BTreeMap<u64, K>,
    next: u64,
    bound: usize,
}

impl<K: Copy + Eq + Hash, V> Aged<K, V> {
    fn new(bound: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: BTreeMap::new(),
            next: 0,
            bound,
        }
    }

    fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.entries.get_mut(key).map(|(_, value)| value)
    }

    /// Inserts or renews `key` as the newest entry.
    fn insert(&mut self, key: K, value: V) {
        if let Some((seq, _)) = self.entries.remove(&key) {
            self.order.remove(&seq);
        } else if self.entries.len() >= self.bound {
            if let Some((_, oldest)) = self.order.pop_first() {
                self.entries.remove(&oldest);
            }
        }
        let seq = self.next;
        self.next += 1;
        self.order.insert(seq, key);
        self.entries.insert(key, (seq, value));
    }

    fn remove(&mut self, key: &K) {
        if let Some((seq, _)) = self.entries.remove(key) {
            self.order.remove(&seq);
        }
    }

    /// Removes the oldest entries while `expired` holds for them.
    fn prune(&mut self, expired: impl Fn(&V) -> bool) {
        while let Some((&seq, key)) = self.order.first_key_value() {
            match self.entries.get(key) {
                Some((_, value)) if !expired(value) => return,
                _ => {
                    let key = *key;
                    self.order.remove(&seq);
                    self.entries.remove(&key);
                }
            }
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn is_full(&self) -> bool {
        self.entries.len() >= self.bound
    }
}

#[derive(Clone, Copy)]
struct Window {
    start: Instant,
    count: u32,
}

/// The rate and cooldown tables and the summary counts. Lives in the host's state, under its
/// lock. Entries are ordered by when they were inserted, which is also when they expire,
/// because every entry of a table lives for the same time.
pub struct Admission {
    per_source: u32,
    cooldown: Duration,
    rates: Aged<Source, Window>,
    /// Relayed sources, apart from `rates` so they can never evict a direct source.
    relayed_rates: Aged<Source, Window>,
    /// The keys the parent named as known (review C3): a relayed connection claiming one is
    /// counted here, apart from `relayed_rates`, so strangers filling that table cannot lock a
    /// member out. Each keeps its own rate, and its cooldown.
    known: HashSet<[u8; 32]>,
    known_rates: Aged<Source, Window>,
    cooled: Aged<[u8; 32], Instant>,
    counts: Counts,
}

/// What a full rate table does with a source it does not know.
#[derive(Clone, Copy, PartialEq, Eq)]
enum WhenFull {
    EvictOldest,
    Refuse,
}

impl Admission {
    pub fn new(per_source: u32, cooldown: Duration) -> Self {
        Self {
            per_source,
            cooldown,
            rates: Aged::new(MAX_SOURCES),
            relayed_rates: Aged::new(MAX_RELAYED_SOURCES),
            known: HashSet::new(),
            known_rates: Aged::new(MAX_KNOWN_KEYS),
            cooled: Aged::new(MAX_COOLED_KEYS),
            counts: Counts::default(),
        }
    }

    /// Replaces the known keys wholesale with at most [`MAX_KNOWN_KEYS`] of `keys`. A key that
    /// leaves the set loses its known window; a key new to it has its cooldown cleared, since
    /// the parent now admits it (an invite was just redeemed for it).
    pub fn set_known(&mut self, keys: impl IntoIterator<Item = [u8; 32]>) {
        let next: HashSet<[u8; 32]> = keys.into_iter().take(MAX_KNOWN_KEYS).collect();
        for key in self.known.difference(&next) {
            self.known_rates.remove(&Source::Relayed(*key));
        }
        for key in next.difference(&self.known) {
            self.cooled.remove(key);
        }
        self.known = next;
    }

    /// True when a relayed connection claims a key the parent named as known.
    pub fn is_known_relayed(&self, remote: &IncomingAddr) -> bool {
        match remote {
            IncomingAddr::Relay { endpoint_id, .. } => self.known.contains(endpoint_id.as_bytes()),
            _ => false,
        }
    }

    /// Counts one handshake from `source`. False when the source is over its rate, or is an
    /// unknown relayed source the full relayed table has no room for: the caller ignores the
    /// connection (no packet back, so a member never reads it as a refusal). A relayed source
    /// claiming a known key is counted in its own table, which only known keys enter.
    pub fn allow_handshake(&mut self, source: Source, now: Instant) -> bool {
        let per_source = self.per_source;
        let (table, when_full) = match source {
            Source::Relayed(key) if self.known.contains(&key) => {
                (&mut self.known_rates, WhenFull::EvictOldest)
            }
            Source::Relayed(_) => (&mut self.relayed_rates, WhenFull::Refuse),
            Source::V4(_) | Source::V6Net(_) => (&mut self.rates, WhenFull::EvictOldest),
        };
        let allowed = count_in(table, when_full, per_source, source, now);
        if !allowed {
            self.note(Cause::Rate);
        }
        allowed
    }

    /// The check before the handshake. With every handshake slot taken the connection is
    /// ignored first and spends no rate, so a member retransmitting into a full host is not
    /// over its own rate once a slot frees. Then a relayed connection whose claimed key is
    /// cooling is ignored, then the source's rate applies. A connection with an address of
    /// any other kind (no custom transport is configured) is ignored. False means ignore it.
    pub fn before_handshake(
        &mut self,
        remote: &IncomingAddr,
        slots_full: bool,
        now: Instant,
    ) -> bool {
        if slots_full {
            self.note(Cause::HandshakeCap);
            return false;
        }
        let source = match remote {
            IncomingAddr::Ip(address) => Source::direct(address.ip()),
            IncomingAddr::Relay { endpoint_id, .. } => {
                let key = *endpoint_id.as_bytes();
                if self.is_cooling(&key, now) {
                    self.note(Cause::Cooldown);
                    return false;
                }
                Source::Relayed(key)
            }
            _ => return false,
        };
        self.allow_handshake(source, now)
    }

    /// The parent refused `key`: it is not asked about again until the cooldown ends.
    pub fn refused(&mut self, key: [u8; 32], now: Instant) {
        self.cooled.insert(key, now + self.cooldown);
    }

    /// A `drop`, or a `device` or `invite` answer, clears the key.
    pub fn clear(&mut self, key: &[u8; 32]) {
        self.cooled.remove(key);
    }

    pub fn is_cooling(&mut self, key: &[u8; 32], now: Instant) -> bool {
        self.cooled.prune(|until| *until <= now);
        self.cooled.get_mut(key).is_some()
    }

    pub fn note(&mut self, cause: Cause) {
        let count = match cause {
            Cause::Rate => &mut self.counts.rate,
            Cause::Cooldown => &mut self.counts.cooldown,
            Cause::WaitingCap => &mut self.counts.waiting_cap,
            Cause::HandshakeCap => &mut self.counts.handshake_cap,
        };
        *count = count.saturating_add(1);
    }

    /// The counts since the last call, which start again at zero.
    pub fn take_counts(&mut self) -> Counts {
        std::mem::take(&mut self.counts)
    }

    /// How many sources and refused keys are remembered.
    pub fn sizes(&self) -> (usize, usize) {
        (self.rates.len(), self.cooled.len())
    }

    /// How many relayed sources are remembered.
    pub fn relayed_sources(&self) -> usize {
        self.relayed_rates.len()
    }
}

/// One handshake from `source` against `table`'s window for it; false when over the rate, or
/// when the table is full, does not know the source and refuses newcomers.
fn count_in(
    table: &mut Aged<Source, Window>,
    when_full: WhenFull,
    per_source: u32,
    source: Source,
    now: Instant,
) -> bool {
    table.prune(|window| now.saturating_duration_since(window.start) >= RATE_WINDOW);
    let refuse_new = when_full == WhenFull::Refuse && table.is_full();
    match table.get_mut(&source) {
        Some(window) if window.count >= per_source => false,
        Some(window) => {
            window.count += 1;
            true
        }
        None if refuse_new => false,
        None => {
            table.insert(
                source,
                Window {
                    start: now,
                    count: 1,
                },
            );
            true
        }
    }
}

/// The handshake slots relayed connections may hold together: half of them (at least one), so
/// direct members always keep the other half however many relayed dials stall.
pub fn relayed_slot_share(max_handshakes: u32) -> u32 {
    (max_handshakes / 2).max(1)
}

/// True when a connection from `remote` finds no handshake slot: every slot is held, or it
/// is relayed and the relayed share is held.
pub fn slots_full(
    remote: &IncomingAddr,
    held: u32,
    relayed_held: u32,
    max_handshakes: u32,
) -> bool {
    held >= max_handshakes
        || (matches!(remote, IncomingAddr::Relay { .. })
            && relayed_held >= relayed_slot_share(max_handshakes))
}

/// Writes the summary line when anything was ignored or refused: counts by cause, never an
/// address, a key or a byte of payload. The counts are taken before the await, so the lock
/// is never held across it.
pub(crate) async fn flush_summary(shared: &Shared) {
    let counts = shared.lock().admission.take_counts();
    send_summary(&shared.out, counts).await;
}

/// Writes the summary as a `log` line, but waits for room in the channel to the parent where
/// `Out::log` would drop the line when it is full: a full channel is when the counts matter.
/// At most one line a second, so waiting cannot flood the parent; nothing is lost unless the
/// output is muted (the parent is gone).
pub async fn send_summary(out: &Out, counts: Counts) {
    if counts.any() {
        out.send(json!({
            "t": "log",
            "event": "team.bridge.refusal_summary",
            "fields": {
                "rate": counts.rate,
                "cooldown": counts.cooldown,
                "waiting_cap": counts.waiting_cap,
                "handshake_cap": counts.handshake_cap,
            },
        }))
        .await;
    }
}

/// At most one summary line per [`SUMMARY_INTERVAL`] until the bridge stops; shutdown writes
/// the last one itself once the accept loop is done.
pub(crate) async fn summary_loop(shared: Arc<Shared>, mut stop: watch::Receiver<bool>) {
    let mut tick = tokio::time::interval(SUMMARY_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await;
    loop {
        tokio::select! {
            biased;
            _ = stopping(&mut stop) => return,
            _ = tick.tick() => flush_summary(&shared).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(index: u32) -> [u8; 32] {
        let mut key = [0u8; 32];
        key[..4].copy_from_slice(&index.to_be_bytes());
        key
    }

    // Review C3: strangers filling the relayed table with fresh claimed ids lock no member out.
    #[test]
    fn a_full_relayed_table_still_lets_a_known_key_in_on_its_own_rate() {
        let now = Instant::now();
        let mut admission = Admission::new(8, Duration::from_secs(60));
        let member = [0xee; 32];
        admission.set_known([member]);
        for index in 0..MAX_RELAYED_SOURCES as u32 {
            assert!(admission.allow_handshake(Source::Relayed(key(index)), now));
        }
        assert!(
            !admission.allow_handshake(Source::Relayed(key(99_999)), now),
            "an unknown newcomer is refused as before"
        );
        for _ in 0..8 {
            assert!(
                admission.allow_handshake(Source::Relayed(member), now),
                "a known key is still let in"
            );
        }
        assert!(
            !admission.allow_handshake(Source::Relayed(member), now),
            "a known key keeps its own rate"
        );
        assert_eq!(
            admission.relayed_sources(),
            MAX_RELAYED_SOURCES,
            "the known key took no stranger's slot"
        );
    }

    #[test]
    fn a_known_key_keeps_its_cooldown_until_it_becomes_newly_known() {
        let now = Instant::now();
        let mut admission = Admission::new(8, Duration::from_secs(60));
        let device = [0xdd; 32];
        admission.set_known([[0x01; 32]]);
        admission.refused(device, now);
        admission.set_known([[0x01; 32], device]);
        assert!(
            !admission.is_cooling(&device, now),
            "a redeem made the key known: its cooldown is cleared"
        );
        admission.refused(device, now);
        admission.set_known([[0x01; 32], device]);
        assert!(
            admission.is_cooling(&device, now),
            "a key already known keeps its cooldown"
        );
        admission.set_known([[0x02; 32]]);
        for index in 0..MAX_RELAYED_SOURCES as u32 {
            admission.allow_handshake(Source::Relayed(key(index)), now);
        }
        assert!(
            !admission.allow_handshake(Source::Relayed([0x01; 32]), now),
            "a key that left the set is a stranger again"
        );
    }

    #[test]
    fn at_most_max_known_keys_are_kept() {
        let mut admission = Admission::new(8, Duration::from_secs(60));
        admission.set_known((0..(MAX_KNOWN_KEYS as u32 + 50)).map(key));
        assert_eq!(admission.known.len(), MAX_KNOWN_KEYS);
    }
}
