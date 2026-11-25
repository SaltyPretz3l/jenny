//! A per-key share of the host's slots (review X3-F03): one key holds at most two admitted
//! connections, two waiting for their answer and sixteen streams, so one device cannot lock
//! every member out.

use std::collections::HashMap;

use crate::host::{ConnEntry, ConnSignal};

/// Admitted connections one key may hold: a member device needs one, and a second covers a
/// reconnect while the old connection is still open. A key may also have as many waiting for
/// their answer; only an admitted connection ever takes an admitted one's slot (review H11).
const MAX_CONNECTIONS_PER_KEY: usize = 2;
/// Streams one key may hold across its connections: one member device's connection of 16.
const MAX_STREAMS_PER_KEY: u32 = 16;

/// What a new connection of a key finds.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Share {
    /// Under its waiting share: the new connection is registered and asked.
    Room,
    /// As `Room`, and the key holds its share of admitted connections with none waiting: once
    /// admitted, the new one takes the oldest one's slot ([`displaced`]), so its registration
    /// may count that slot as freed.
    Replaces,
    /// Its waiting share is held: the new connection is closed as the waiting cap closes one,
    /// and nothing of the key's is touched.
    Full,
}

/// Waiting or admitted. A connection told to close, drain or refuse is leaving.
fn holds_share(entry: &ConnEntry) -> bool {
    matches!(
        *entry.signal.borrow(),
        ConnSignal::Waiting | ConnSignal::Admit(_)
    )
}

fn is_admitted(entry: &ConnEntry) -> bool {
    matches!(*entry.signal.borrow(), ConnSignal::Admit(_))
}

/// The connections that hold a connection slot: waiting or admitted, never one leaving
/// (closing, refused or draining), whose own task ends it within its bound (review H11).
pub(crate) fn live_connections(conns: &HashMap<u64, ConnEntry>) -> usize {
    conns.values().filter(|entry| holds_share(entry)).count()
}

pub(crate) fn share(conns: &HashMap<u64, ConnEntry>, key: &[u8; 32]) -> Share {
    let (mut waiting, mut admitted) = (0, 0);
    for entry in conns.values().filter(|entry| entry.key == *key) {
        match *entry.signal.borrow() {
            ConnSignal::Waiting => waiting += 1,
            ConnSignal::Admit(_) => admitted += 1,
            _ => {}
        }
    }
    if waiting >= MAX_CONNECTIONS_PER_KEY {
        Share::Full
    } else if waiting == 0 && admitted >= MAX_CONNECTIONS_PER_KEY {
        Share::Replaces
    } else {
        Share::Room
    }
}

/// Once connection `id` of `key` is admitted: the key's oldest other admitted connection when
/// the key now holds more than its share of admitted ones, which gives its slot to `id`. A
/// connection still waiting never displaces one (review H11). Connection ids only grow, so the
/// smallest is the oldest.
pub(crate) fn displaced(conns: &HashMap<u64, ConnEntry>, key: &[u8; 32], id: u64) -> Option<u64> {
    let others: Vec<u64> = conns
        .iter()
        .filter(|(other, entry)| **other != id && entry.key == *key && is_admitted(entry))
        .map(|(other, _)| *other)
        .collect();
    if others.len() >= MAX_CONNECTIONS_PER_KEY {
        others.into_iter().min()
    } else {
        None
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

    // Review H11: a reconnect that is still waiting for its answer never pushes out the key's
    // live admitted link; only waiting connections count toward the waiting share.
    #[test]
    fn a_waiting_reconnect_never_displaces_an_admitted_link() {
        let key = [7; 32];
        let one_each = table(vec![
            (1, entry(7, ADMIT, 0)),
            (2, entry(7, ConnSignal::Waiting, 0)),
        ]);
        assert_eq!(share(&one_each, &key), Share::Room);
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
        assert_eq!(share(&mixed, &key), Share::Room, "one is already waiting");
        assert_eq!(displaced(&mixed, &key, 3), Some(5), "once 3 is admitted");
        let both = table(vec![(5, entry(7, ADMIT, 0)), (9, entry(7, ADMIT, 0))]);
        assert_eq!(share(&both, &key), Share::Replaces);
        assert_eq!(displaced(&both, &key, 12), Some(5));
        assert_eq!(displaced(&both, &key, 9), None, "9 and 5 are its share");
    }

    #[test]
    fn only_waiting_and_admitted_connections_hold_a_slot() {
        let conns = table(vec![
            (1, entry(7, ADMIT, 0)),
            (2, entry(8, ConnSignal::Waiting, 0)),
            (3, entry(9, ConnSignal::Close, 0)),
            (4, entry(9, ConnSignal::Refuse, 0)),
            (
                5,
                entry(9, ConnSignal::Drain(tokio::time::Instant::now()), 0),
            ),
        ]);
        assert_eq!(live_connections(&conns), 2);
    }
}
