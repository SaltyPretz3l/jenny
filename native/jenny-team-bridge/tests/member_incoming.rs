//! What unsolicited QUIC connection attempts cost a running member bridge (review round two,
//! R11-F03): a member accepts nothing, so each attempt must be dropped at once, not parked.
// new-test-file: a counting global allocator needs a test binary of its own, so no other test
// shares its counters (as in `admission_memory.rs`).

mod common;

use std::alloc::{GlobalAlloc, Layout, System};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Duration;

use common::raw::{addresses_of, client_endpoint, host_endpoint, public_key, ALPN};
use common::*;
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr, TransportAddr};
use tokio::task::JoinSet;

struct Counting;

static LIVE: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            let size = isize::try_from(layout.size()).unwrap_or(isize::MAX);
            LIVE.fetch_add(size, Ordering::SeqCst);
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

const ATTEMPTS: usize = 1000;
/// What the member may still hold after the attempts are over: noise from the runtime and the
/// one live connection, far below one parked attempt per Initial.
const CEILING_BYTES: isize = 256 * 1024;

/// The member's UDP address, as the host sees its connection.
fn member_address(conn: &Connection) -> SocketAddr {
    let paths = conn.paths();
    let chosen = paths
        .iter()
        .find(|path| path.is_selected())
        .expect("a selected path");
    match chosen.remote_addr() {
        TransportAddr::Ip(address) => *address,
        other => panic!("not an IP path: {other:?}"),
    }
}

/// `count` connection attempts at once, each given up after a second.
async fn attempts(flooder: &Endpoint, target: &EndpointAddr, count: usize) {
    let mut all = JoinSet::new();
    for _ in 0..count {
        let flooder = flooder.clone();
        let target = target.clone();
        all.spawn(async move {
            let attempt = flooder.connect(target, ALPN);
            let _ = tokio::time::timeout(Duration::from_secs(1), attempt).await;
        });
    }
    while all.join_next().await.is_some() {}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unsolicited_connection_attempts_leave_the_member_holding_nothing() {
    let host_keys = keys();
    let host = host_endpoint(&host_keys.secret).await;
    let (mut member, member_keys, _launch) =
        start_member(&host_keys.public, &addresses_of(&host), member_limits()).await;
    let incoming = within("the member's dial", host.accept())
        .await
        .expect("an incoming connection");
    let conn = within("the handshake", async { incoming.await })
        .await
        .expect("handshake");
    member.expect_state("online").await;
    let target = EndpointAddr::from_parts(
        public_key(&member_keys.public),
        [TransportAddr::Ip(member_address(&conn))],
    );

    // A first round lets every lazily built table exist before the count is taken.
    let warm = client_endpoint(&random32(), IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    attempts(&warm, &target, 8).await;
    warm.close().await;
    drop(warm);
    tokio::time::sleep(Duration::from_millis(500)).await;

    let before = LIVE.load(Ordering::SeqCst);
    let flooder = client_endpoint(&random32(), IpAddr::V4(Ipv4Addr::LOCALHOST)).await;
    attempts(&flooder, &target, ATTEMPTS).await;
    flooder.close().await;
    drop(flooder);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let held = LIVE.load(Ordering::SeqCst) - before;
    eprintln!("member incoming: {ATTEMPTS} unsolicited attempts leave {held} bytes held");
    assert!(
        held <= CEILING_BYTES,
        "{held} bytes still held after {ATTEMPTS} attempts"
    );
    assert!(
        !member.history_has(|line| line["state"] == "offline"),
        "the member's own connection is untouched"
    );
    drop(conn);
}
