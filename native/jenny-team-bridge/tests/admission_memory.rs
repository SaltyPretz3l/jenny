//! What the two admission tables cost at their bounds, measured with a counting allocator.
//! Its own test binary, so no other test shares the allocator's counters.

use std::alloc::{GlobalAlloc, Layout, System};
use std::net::{IpAddr, Ipv6Addr};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::{Duration, Instant};

use jenny_team_bridge::admission::{Admission, Source, MAX_COOLED_KEYS, MAX_SOURCES};

struct Counting;

static LIVE: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            let size = isize::try_from(layout.size()).unwrap_or(isize::MAX);
            let live = LIVE.fetch_add(size, Ordering::SeqCst) + size;
            PEAK.fetch_max(live, Ordering::SeqCst);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        let size = isize::try_from(layout.size()).unwrap_or(isize::MAX);
        LIVE.fetch_sub(size, Ordering::SeqCst);
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Distinct IPv6 /64 networks: the largest source key.
fn source(index: u64) -> Source {
    let mut octets = [0u8; 16];
    octets[..8].copy_from_slice(&index.to_be_bytes());
    Source::direct(IpAddr::V6(Ipv6Addr::from(octets)))
}

fn key(index: u64) -> [u8; 32] {
    let mut key = [0u8; 32];
    key[..8].copy_from_slice(&index.to_be_bytes());
    key
}

/// Ceiling for both full tables together; the measured figure is printed and recorded in
/// the spec's "5-1 as built".
const CEILING_BYTES: isize = 3 * 1024 * 1024;

#[test]
fn both_tables_at_their_bounds_cost_bounded_memory() {
    let now = Instant::now();
    let before = LIVE.load(Ordering::SeqCst);
    let mut admission = Admission::new(8, Duration::from_secs(60));
    PEAK.store(before, Ordering::SeqCst);
    // Twice the bound in each table: half of every round is evicted again.
    for index in 0..(2 * MAX_SOURCES as u64) {
        admission.allow_handshake(source(index), now);
    }
    for index in 0..(2 * MAX_COOLED_KEYS as u64) {
        admission.refused(key(index), now);
    }
    assert_eq!(admission.sizes(), (MAX_SOURCES, MAX_COOLED_KEYS));
    let full = LIVE.load(Ordering::SeqCst) - before;
    let peak = PEAK.load(Ordering::SeqCst) - before;
    eprintln!(
        "admission memory: {MAX_SOURCES} sources and {MAX_COOLED_KEYS} keys hold {full} bytes (peak {peak})"
    );
    assert!(full <= CEILING_BYTES, "{full} bytes held");
    assert!(peak <= CEILING_BYTES, "{peak} bytes at the peak");

    // More of the same never grows it.
    for index in (2 * MAX_SOURCES as u64)..(4 * MAX_SOURCES as u64) {
        admission.allow_handshake(source(index), now);
        admission.refused(key(index), now);
    }
    let after = LIVE.load(Ordering::SeqCst) - before;
    // A few B-tree nodes may move; the tables themselves do not grow.
    assert!(
        after <= full + 16 * 1024,
        "{after} bytes after more inserts, {full} before"
    );
}
