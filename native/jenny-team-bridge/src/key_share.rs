//! A per-key share of the host's slots (review X3-F03): one key holds at most two connections
//! and sixteen streams, so one device cannot lock every member out.

use std::collections::HashMap;

use crate::host::{ConnEntry, ConnSignal};

/// Connections one key may hold, waiting or admitted: a member device needs one, and a second
/// covers a reconnect while the old connection is still open.
const MAX_CONNECTIONS_PER_KEY: usize = 2;
/// Streams one key may hold across its connections: one member device's connection of 16.
const MAX_STREAMS_PER_KEY: u32 = 16;

/// What a new connection of a key finds.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Share {
    /// Under its share: the new connection is registered as usual.
    Room,
    /// At its share: the key's oldest admitted connection gives its slot to the new one.
    Replace(u64),
    /// At its share with nothing admitted: the new connection is closed as the waiting cap
    /// closes one, and nothing of the key's is touched.
    Full,
}

/// Waiting or admitted. A connection told to close, drain or refuse is leaving.
fn holds_share(entry: &ConnEntry) -> bool {
    matches!(
        *entry.signal.borrow(),
        ConnSignal::Waiting | ConnSignal::Admit(_)
    )
}

/// Connection ids only grow, so the smallest admitted id is the oldest admitted connection.
pub(crate) fn share(conns: &HashMap<u64, ConnEntry>, key: &[u8; 32]) -> Share {
    let mut held = 0;
    let mut oldest_admitted: Option<u64> = None;
    for (id, entry) in conns.iter() {
        if entry.key != *key || !holds_share(entry) {
            continue;
        }
        held += 1;
        let admitted = matches!(*entry.signal.borrow(), ConnSignal::Admit(_));
        if admitted && oldest_admitted.is_none_or(|old| *id < old) {
            oldest_admitted = Some(*id);
        }
    }
    if held < MAX_CONNECTIONS_PER_KEY {
        Share::Room
    } else {
        oldest_admitted.map_or(Share::Full, Share::Replace)
    }
}

/// The key's streams across the connections that hold its share, as [`share`] counts them.
fn key_streams(conns: &HashMap<u64, ConnEntry>, key: &[u8; 32]) -> u32 {
    conns
        .values()
        .filter(|entry| entry.key == *key && holds_share(entry))
        .map(|entry| entry.streams)
        .sum()
}

/// True when the key may open one more stream.
pub(crate) fn stream_room(conns: &HashMap<u64, ConnEntry>, key: &[u8; 32]) -> bool {
    key_streams(conns, key) < MAX_STREAMS_PER_KEY
}

#[cfg(test)]
mod tests {
    use tokio::sync::watch;

    use super::*;
    use crate::messages::AdmitKind;

    fn entry(key: u8, signal: ConnSignal, streams: u32) -> ConnEntry {
        ConnEntry {
            key: [key; 32],
            signal: watch::channel(signal).0,
            streams,
        }
    }

    fn table(entries: Vec<(u64, ConnEntry)>) -> HashMap<u64, ConnEntry> {
        entries.into_iter().collect()
    }

    const ADMIT: ConnSignal = ConnSignal::Admit(AdmitKind::Device);

    #[test]
    fn a_leaving_connection_holds_none_of_the_key_streams() {
        let conns = table(vec![
            (1, entry(7, ConnSignal::Close, 16)),
            (2, entry(7, ADMIT, 0)),
        ]);
        assert!(
            stream_room(&conns, &[7; 32]),
            "a closing connection's 16 do not count"
        );
        let conns = table(vec![(1, entry(7, ADMIT, 10)), (2, entry(7, ADMIT, 6))]);
        assert!(!stream_room(&conns, &[7; 32]), "16 across two connections");
        assert!(stream_room(&conns, &[8; 32]), "another key is not counted");
    }

    #[test]
    fn only_an_admitted_connection_is_replaced_and_the_oldest_one() {
        let key = [7; 32];
        let room = table(vec![
            (1, entry(7, ADMIT, 0)),
            (2, entry(7, ConnSignal::Close, 0)),
        ]);
        assert_eq!(share(&room, &key), Share::Room);
        let waiting = table(vec![
            (1, entry(7, ConnSignal::Waiting, 0)),
            (2, entry(7, ConnSignal::Waiting, 0)),
        ]);
        assert_eq!(share(&waiting, &key), Share::Full);
        let mixed = table(vec![
            (3, entry(7, ConnSignal::Waiting, 0)),
            (5, entry(7, ADMIT, 0)),
            (9, entry(7, ADMIT, 0)),
        ]);
        assert_eq!(share(&mixed, &key), Share::Replace(5));
    }
}
