//! Bulk streams: a model on its way through the team must not slow chat.
//!
//! The member bridge has a second loopback port. A socket accepted there becomes a stream
//! whose first byte is the class byte [`CLASS_BULK`] and whose send half is sent after
//! every ordinary stream's data. The host bridge reads each stream's first byte: the class
//! byte marks the stream bulk on the host's send half too and is not forwarded; any other
//! byte belongs to the request (a member bridge that knows no classes) and is forwarded.
//!
//! Priority orders what waits to be sent; it frees no flow-control credit. The member
//! bridge therefore also caps how many bulk streams are open at once
//! ([`MAX_BULK_STREAMS`]), so stalled bulk streams cannot hold the whole connection window.

use std::time::Duration;

use iroh::endpoint::{RecvStream, SendStream};
use tokio::sync::watch;

use crate::pipe::{not_live, StreamSignal};

/// The first byte of a bulk stream. Never the first byte of an HTTP request.
pub(crate) const CLASS_BULK: u8 = 0x01;
/// Bulk streams one member connection may have open at once. Each can hold a 512 KiB
/// stream window of the 4 MiB connection window (`pipe.rs`): six hold 3 MiB at most, so
/// 1 MiB is always left for ordinary streams.
pub(crate) const MAX_BULK_STREAMS: u32 = 6;
/// Every send stream starts at 0 and higher is sent first: bulk data waits for ordinary data.
const BULK_PRIORITY: i32 = -1;
/// How long a stream may take to send the first byte of its request before it is reset.
const FIRST_BYTE_WINDOW: Duration = Duration::from_secs(3);

/// Sends this half's data after every ordinary stream's. An error means the stream is
/// already closed.
pub(crate) fn mark_bulk(send: &SendStream) {
    let _ = send.set_priority(BULK_PRIORITY);
}

/// How a stream began.
pub(crate) struct Head {
    /// The stream opened with the class byte, which is not part of the request.
    pub(crate) bulk: bool,
    /// The first byte of the request itself.
    pub(crate) byte: u8,
}

async fn one_byte(recv: &mut RecvStream) -> Option<u8> {
    let mut byte = [0u8; 1];
    match recv.read(&mut byte).await {
        Ok(Some(1)) => Some(byte[0]),
        _ => None,
    }
}

/// Reads a stream's class byte, when it has one, and the first byte of its request. `None`
/// when no request byte came inside the window, the peer ended or reset the stream first,
/// or the stream is no longer live: the caller resets it and opens no loopback socket.
pub(crate) async fn read_head<S: StreamSignal>(
    recv: &mut RecvStream,
    signal: &mut watch::Receiver<S>,
) -> Option<Head> {
    let head = async {
        let byte = one_byte(recv).await?;
        if byte != CLASS_BULK {
            return Some(Head { bulk: false, byte });
        }
        let byte = one_byte(recv).await?;
        Some(Head { bulk: true, byte })
    };
    tokio::select! {
        biased;
        _ = not_live(signal) => None,
        head = tokio::time::timeout(FIRST_BYTE_WINDOW, head) => head.ok().flatten(),
    }
}
