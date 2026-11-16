//! Bulk streams yield to ordinary streams: a model part on its way does not slow chat.
//!
//! Two things are measured on this crate's loopback harness. Priority: a large ordinary
//! payload beside flat-out streams, with those streams ordinary and then bulk, on the same
//! connection (a small request is not slow beside moving streams of either class: the
//! library takes turns between streams of one priority). Flow-control credit: priority
//! frees none, so the member's cap on open bulk streams is what lets a small request
//! through beside bulk streams whose reader has stopped.
//!
//! The tests take turns ([`SERIAL`]): each floods the CPU and the bounds are about time.

mod common;

use std::time::{Duration, Instant};

use common::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

const CHUNK: usize = 64 * 1024;
const PAYLOAD: usize = 2 * 1024 * 1024;
const HOST_PREAMBLE: usize = 72;

/// One test at a time in this binary.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Copy, PartialEq)]
enum Way {
    /// Member to host: the member bridge's send half decides.
    Up,
    /// Host to member: the host bridge's send half decides.
    Down,
}

/// Writes without end until the far side goes away.
fn flood(mut socket: TcpStream) -> JoinHandle<()> {
    tokio::spawn(async move {
        let chunk = vec![7u8; CHUNK];
        while socket.write_all(&chunk).await.is_ok() {}
    })
}

/// Reads at `pace` (bytes per 50 ms; `None` reads as fast as it can).
fn drain(mut socket: TcpStream, pace: Option<usize>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            let want = match pace {
                Some(bytes) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    bytes
                }
                None => CHUNK,
            };
            if matches!(socket.read(&mut buf[..want]).await, Ok(0) | Err(_)) {
                return;
            }
        }
    })
}

/// Streams that carry bytes one way without end. Dropping it ends them.
struct Load(Vec<JoinHandle<()>>);

impl Drop for Load {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

async fn load(pair: &mut Pair, port: u16, streams: usize, way: Way, pace: Option<usize>) -> Load {
    let mut tasks = Vec::new();
    for _ in 0..streams {
        let mut near = client(port, &pair.launch).await;
        near.write_all(b"P").await.expect("first request byte");
        let far = pair.http.next_socket().await;
        let (writer, reader) = match way {
            Way::Up => (near, far),
            Way::Down => (far, near),
        };
        tasks.push(flood(writer));
        tasks.push(drain(reader, pace));
    }
    // Let the streams fill their windows before anything is measured.
    tokio::time::sleep(Duration::from_millis(300)).await;
    Load(tasks)
}

/// One exchange on the ordinary port: `up` bytes to the host, `down` bytes back.
async fn exchange(pair: &mut Pair, up: usize, down: usize) -> Duration {
    let started = Instant::now();
    let mut near = client(pair.port, &pair.launch).await;
    let request = tokio::spawn(async move {
        near.write_all(&vec![b'G'; up]).await.expect("request");
        let mut answer = vec![0u8; down];
        near.read_exact(&mut answer).await.expect("answer");
    });
    let mut far = pair.http.next_socket().await;
    let mut seen = vec![0u8; HOST_PREAMBLE + up];
    far.read_exact(&mut seen)
        .await
        .expect("request at the host");
    far.write_all(&vec![b'A'; down]).await.expect("answer");
    within("the exchange", request).await.expect("request task");
    started.elapsed()
}

async fn median(pair: &mut Pair, tries: usize, up: usize, down: usize) -> Duration {
    let mut times = Vec::new();
    for _ in 0..tries {
        times.push(exchange(pair, up, down).await);
    }
    times.sort();
    times[tries / 2]
}

/// Eight bulk sockets that each carry bytes one way to a reader that never reads. Six
/// become streams (the member's bulk cap) and sit at their flow-control limit; returns
/// what must stay open, and how many reached the host.
async fn stalled_bulk(pair: &mut Pair, way: Way) -> (Load, Vec<TcpStream>, usize) {
    let mut tasks = Vec::new();
    let mut idle = Vec::new();
    let before = pair.http.count();
    let mut near = Vec::new();
    for _ in 0..8 {
        let mut socket = client(pair.bulk_port, &pair.launch).await;
        socket.write_all(b"P").await.expect("first request byte");
        near.push(socket);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let reached = pair.http.count() - before;
    let mut far = Vec::new();
    for _ in 0..reached {
        far.push(pair.http.next_socket().await);
    }
    let (writers, readers) = match way {
        Way::Up => (near, far),
        Way::Down => (far, near),
    };
    tasks.extend(writers.into_iter().map(flood));
    idle.extend(readers);
    // Let every stream fill its window and the sockets' buffers.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    (Load(tasks), idle, reached)
}

/// The slice's purpose. With the bulk cap removed all eight sockets become streams, their
/// windows hold the whole connection window, and the small request never completes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn small_request_completes_beside_stalled_bulk_streams() {
    let _turn = SERIAL.lock().await;
    for way in [Way::Up, Way::Down] {
        let mut pair = pair().await;
        let (_load, _idle, reached) = stalled_bulk(&mut pair, way).await;
        let took = median(&mut pair, 5, 64, 64).await;
        println!("small request beside {reached} stalled bulk streams: median {took:?}");
        assert_eq!(reached, 6, "the bulk cap");
        assert!(took < Duration::from_millis(500), "median {took:?}");
    }
}

/// The same load on the ordinary port and on the bulk port, turn about; returns the two
/// medians of a large one-way payload on the ordinary port.
async fn compare(way: Way) -> (Duration, Duration) {
    let mut pair = pair().await;
    let (up, down) = match way {
        Way::Up => (PAYLOAD, 1),
        Way::Down => (1, PAYLOAD),
    };
    let mut ordinary = Vec::new();
    let mut bulk = Vec::new();
    for _ in 0..3 {
        for (port, times) in [(pair.port, &mut ordinary), (pair.bulk_port, &mut bulk)] {
            let running = load(&mut pair, port, 3, way, None).await;
            for _ in 0..3 {
                times.push(exchange(&mut pair, up, down).await);
            }
            drop(running);
            pair.host
                .wait_for("the load's streams to end", |line| {
                    line["t"] == "stats" && line["streams"] == 0
                })
                .await;
        }
    }
    ordinary.sort();
    bulk.sort();
    (ordinary[ordinary.len() / 2], bulk[bulk.len() / 2])
}

/// Passes when the payload beside bulk-class load takes at most 60% of the time it takes
/// beside the same load on ordinary streams. Two attempts, for a busy machine.
async fn bulk_yields(way: Way) {
    let mut seen = Vec::new();
    for _ in 0..2 {
        let (ordinary, bulk) = compare(way).await;
        println!("2 MiB beside three flat-out streams: ordinary-class load {ordinary:?}, bulk-class load {bulk:?}");
        if bulk.as_secs_f64() <= ordinary.as_secs_f64() * 0.6 {
            return;
        }
        seen.push((ordinary, bulk));
    }
    panic!("bulk streams did not yield: {seen:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ordinary_upload_overtakes_bulk_uploads() {
    let _turn = SERIAL.lock().await;
    bulk_yields(Way::Up).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ordinary_download_overtakes_bulk_downloads() {
    let _turn = SERIAL.lock().await;
    bulk_yields(Way::Down).await;
}
