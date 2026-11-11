//! Joins one QUIC bidirectional stream to one loopback TCP socket, both directions, with
//! backpressure (every write is awaited before the next read).
//!
//! - peer FIN on the QUIC receive half: shut down the TCP write half;
//! - TCP end of input: finish the QUIC send half, then wait until the peer acknowledged it;
//! - an error on either side: reset and stop the QUIC halves and drop the socket;
//! - drain: stop the QUIC receive half (no more peer bytes reach the socket) but keep
//!   carrying socket bytes to the peer until the socket ends; never shut the TCP write
//!   half down while draining;
//! - close: as an error.

use std::time::Duration;

use iroh::endpoint::{Connection, RecvStream, SendStream, VarInt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::watch;

const CHUNK_BYTES: usize = 64 * 1024;
/// Once one direction is over, how long the other may stay open before the stream is reset.
/// Bounds a half-open stream that a peer never finishes.
const HALF_OPEN_LIMIT: Duration = Duration::from_secs(10);

/// QUIC settings both modes share: no datagrams, no unidirectional streams, and receive and
/// send windows sized for chat and model streams instead of the library's bulk defaults, so
/// a peer (admitted or not yet) cannot make the bridge buffer more than a few MiB.
pub fn bounded_transport() -> iroh::endpoint::QuicTransportConfigBuilder {
    iroh::endpoint::QuicTransportConfig::builder()
        .max_concurrent_uni_streams(VarInt::from_u32(0))
        .stream_receive_window(VarInt::from_u32(512 * 1024))
        .receive_window(VarInt::from_u32(4 * 1024 * 1024))
        .send_window(4 * 1024 * 1024)
        .datagram_receive_buffer_size(None)
}

/// Connection close codes on the wire, shared by both modes.
pub const CODE_CLOSED: u32 = 0;
pub const CODE_REFUSED: u32 = 1;

/// Closes a connection with `code` (`CODE_REFUSED` or `CODE_CLOSED`) and its fixed reason.
pub fn close_connection(conn: &Connection, code: u32) {
    let reason: &[u8] = if code == CODE_REFUSED {
        b"refused"
    } else {
        b"closed"
    };
    conn.close(VarInt::from_u32(code), reason);
}

/// What a stream should do now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamMode {
    Live,
    Drain,
    Close,
}

/// A watched value that tells streams what to do.
pub trait StreamSignal: Send + Sync + 'static {
    fn mode(&self) -> StreamMode;
}

/// Waits until the mode leaves `Live`. A dropped sender counts as `Close`.
pub async fn not_live<S: StreamSignal>(signal: &mut watch::Receiver<S>) -> StreamMode {
    match signal
        .wait_for(|value| value.mode() != StreamMode::Live)
        .await
    {
        Ok(value) => value.mode(),
        Err(_) => StreamMode::Close,
    }
}

/// Waits until the mode is `Close`. A dropped sender counts as `Close`.
pub async fn closed<S: StreamSignal>(signal: &mut watch::Receiver<S>) {
    let _ = signal
        .wait_for(|value| value.mode() == StreamMode::Close)
        .await;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Half {
    Done,
    Failed,
}

/// Resets both QUIC halves with `code`; errors mean the half was already closed.
pub fn reset_stream(send: &mut SendStream, recv: &mut RecvStream, code: u32) {
    let _ = send.reset(VarInt::from_u32(code));
    let _ = recv.stop(VarInt::from_u32(code));
}

/// Peer to socket.
async fn upstream<S: StreamSignal>(
    recv: &mut RecvStream,
    socket: &mut OwnedWriteHalf,
    signal: &mut watch::Receiver<S>,
) -> Half {
    let mut buf = vec![0u8; CHUNK_BYTES];
    loop {
        let read = tokio::select! {
            biased;
            mode = not_live(signal) => return on_signal(mode, recv),
            read = recv.read(&mut buf) => read,
        };
        match read {
            Ok(Some(count)) => {
                tokio::select! {
                    biased;
                    mode = not_live(signal) => return on_signal(mode, recv),
                    written = socket.write_all(&buf[..count]) => {
                        if written.is_err() {
                            return Half::Failed;
                        }
                    }
                }
            }
            Ok(None) => {
                // The peer finished its side: half-close the socket's write side.
                let _ = socket.shutdown().await;
                return Half::Done;
            }
            Err(_) => return Half::Failed,
        }
    }
}

fn on_signal(mode: StreamMode, recv: &mut RecvStream) -> Half {
    match mode {
        StreamMode::Drain => {
            // No more bytes from the peer; the socket's write side stays open.
            let _ = recv.stop(VarInt::from_u32(0));
            Half::Done
        }
        _ => Half::Failed,
    }
}

/// Socket to peer.
async fn downstream<S: StreamSignal>(
    socket: &mut OwnedReadHalf,
    send: &mut SendStream,
    signal: &mut watch::Receiver<S>,
) -> Half {
    let mut buf = vec![0u8; CHUNK_BYTES];
    loop {
        let read = tokio::select! {
            biased;
            _ = closed(signal) => return Half::Failed,
            read = socket.read(&mut buf) => read,
        };
        match read {
            Ok(0) => break,
            Ok(count) => {
                tokio::select! {
                    biased;
                    _ = closed(signal) => return Half::Failed,
                    written = send.write_all(&buf[..count]) => {
                        if written.is_err() {
                            return Half::Failed;
                        }
                    }
                }
            }
            Err(_) => return Half::Failed,
        }
    }
    if send.finish().is_err() {
        return Half::Failed;
    }
    tokio::select! {
        biased;
        _ = closed(signal) => Half::Failed,
        stopped = send.stopped() => match stopped {
            // Acknowledged in full, or the peer stopped reading: either way it is over.
            Ok(_) => Half::Done,
            Err(_) => Half::Failed,
        },
    }
}

/// Pipes until both directions are done or either failed. Returns true when it ended
/// cleanly. The socket is dropped on return.
pub async fn pipe<S: StreamSignal>(
    mut send: SendStream,
    mut recv: RecvStream,
    socket: TcpStream,
    signal: watch::Receiver<S>,
) -> bool {
    let (mut socket_read, mut socket_write) = socket.into_split();
    let clean = {
        let mut up_signal = signal.clone();
        let mut down_signal = signal;
        let up = upstream(&mut recv, &mut socket_write, &mut up_signal);
        let down = downstream(&mut socket_read, &mut send, &mut down_signal);
        tokio::pin!(up, down);
        let mut up_done = false;
        let mut down_done = false;
        let half_open = tokio::time::sleep(Duration::MAX);
        tokio::pin!(half_open);
        loop {
            tokio::select! {
                _ = &mut half_open, if up_done != down_done => break false,
                half = &mut up, if !up_done => {
                    if half == Half::Failed {
                        break false;
                    }
                    up_done = true;
                }
                half = &mut down, if !down_done => {
                    if half == Half::Failed {
                        break false;
                    }
                    down_done = true;
                }
            }
            if up_done && down_done {
                break true;
            }
            if up_done != down_done {
                half_open
                    .as_mut()
                    .reset(tokio::time::Instant::now() + HALF_OPEN_LIMIT);
            }
        }
    };
    if !clean {
        reset_stream(&mut send, &mut recv, 0);
    }
    clean
}
