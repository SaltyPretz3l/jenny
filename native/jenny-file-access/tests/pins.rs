//! The token tables, on any system: stale, repeated, wrong-kind and
//! never-issued tokens are refused, the table is bounded, a value is dropped
//! exactly once, and a poisoned lock is never recovered.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use jenny_file_access::abi::{Status, FILE_TABLE_ENTRIES, PIN_TABLE_ENTRIES};
use jenny_file_access::pins::{Kind, Table, TableError};

/// Counts its drops, the way a handle counts its closes.
struct Counted(Arc<AtomicUsize>);

impl Drop for Counted {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn counted() -> (Counted, Arc<AtomicUsize>) {
    let drops = Arc::new(AtomicUsize::new(0));
    (Counted(Arc::clone(&drops)), drops)
}

#[test]
fn a_token_reaches_its_value_until_it_is_removed() {
    let table: Table<u32> = Table::new(Kind::Pin, PIN_TABLE_ENTRIES);
    let token = table.insert(7).expect("a free slot");
    assert_ne!(token, 0);
    assert_eq!(table.with(token, |value| *value + 1), Ok(8));
    assert_eq!(table.live(), Ok(1));
    assert_eq!(table.remove(token), Ok(7));
    assert_eq!(table.live(), Ok(0));
}

#[test]
fn a_stale_token_is_refused_after_its_slot_is_reused() {
    let table: Table<u32> = Table::new(Kind::Pin, PIN_TABLE_ENTRIES);
    let first = table.insert(1).expect("a free slot");
    assert_eq!(table.remove(first), Ok(1));
    let second = table.insert(2).expect("the slot is free again");
    assert_ne!(first, second, "a reused slot issues a different token");
    assert_eq!(table.with(first, |value| *value), Err(TableError::Invalid));
    assert_eq!(table.remove(first), Err(TableError::Invalid));
    assert_eq!(
        table.with(second, |value| *value),
        Ok(2),
        "the stale token touched nothing"
    );
}

#[test]
fn a_repeated_close_is_refused_and_drops_nothing_twice() {
    let table: Table<Counted> = Table::new(Kind::Pin, PIN_TABLE_ENTRIES);
    let (value, drops) = counted();
    let token = table.insert(value).expect("a free slot");
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    drop(table.remove(token).expect("the first close"));
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    assert!(
        matches!(table.remove(token), Err(TableError::Invalid)),
        "the second close"
    );
    assert_eq!(drops.load(Ordering::SeqCst), 1, "nothing was closed again");
}

#[test]
fn a_token_of_another_kind_is_refused() {
    let pins: Table<u32> = Table::new(Kind::Pin, PIN_TABLE_ENTRIES);
    let files: Table<u32> = Table::new(Kind::File, FILE_TABLE_ENTRIES);
    let pin = pins.insert(1).expect("a pin");
    let file = files.insert(2).expect("a file");
    assert_ne!(pin, file, "same slot and generation, different kind");
    assert_eq!(pins.with(file, |value| *value), Err(TableError::Invalid));
    assert_eq!(pins.remove(file), Err(TableError::Invalid));
    assert_eq!(files.with(pin, |value| *value), Err(TableError::Invalid));
    assert_eq!(files.remove(pin), Err(TableError::Invalid));
    assert_eq!(
        (pins.live(), files.live()),
        (Ok(1), Ok(1)),
        "nothing was closed"
    );
}

#[test]
fn never_issued_tokens_are_refused_without_touching_memory() {
    let table: Table<u32> = Table::new(Kind::Pin, PIN_TABLE_ENTRIES);
    let token = table.insert(9).expect("a free slot");
    let mut candidates = vec![0, 1, u64::MAX, u64::MAX - 1, token + 1, token ^ (1 << 16)];
    // A reserved bit, a huge index, another generation, an address-like value.
    candidates.extend([
        token | (1 << 48),
        token | 0xFFFF,
        token + (1 << 16),
        0x0000_7FF6_1234_5678,
    ]);
    // Every single-bit change of a live token names nothing.
    candidates.extend((0..64).map(|bit| token ^ (1 << bit)));
    // A spread of values from a fixed sequence.
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    for _ in 0..10_000 {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        candidates.push(state);
    }
    for candidate in candidates {
        if candidate == token {
            continue;
        }
        assert_eq!(
            table.with(candidate, |value| *value),
            Err(TableError::Invalid),
            "{candidate:#x}"
        );
        assert_eq!(
            table.remove(candidate),
            Err(TableError::Invalid),
            "{candidate:#x}"
        );
    }
    assert_eq!(
        table.with(token, |value| *value),
        Ok(9),
        "the live token still works"
    );
}

#[test]
fn a_full_table_refuses_and_drops_the_value_it_was_given() {
    let table: Table<Counted> = Table::new(Kind::Pin, PIN_TABLE_ENTRIES);
    let mut tokens = Vec::new();
    for _ in 0..PIN_TABLE_ENTRIES {
        tokens.push(table.insert(counted().0).expect("a free slot"));
    }
    assert_eq!(table.live(), Ok(PIN_TABLE_ENTRIES));
    assert_eq!(table.has_room(), Ok(false));
    let (extra, drops) = counted();
    assert_eq!(table.insert(extra), Err(TableError::Full));
    assert_eq!(
        drops.load(Ordering::SeqCst),
        1,
        "the refused value was closed, not leaked"
    );
    assert_eq!(table.live(), Ok(PIN_TABLE_ENTRIES));

    let freed = tokens.pop().expect("a token");
    drop(table.remove(freed).expect("a live token"));
    assert_eq!(table.has_room(), Ok(true));
    let again = table.insert(counted().0).expect("one slot is free again");
    assert_ne!(again, freed);
    assert!(matches!(table.remove(freed), Err(TableError::Invalid)));
}

#[test]
fn table_errors_map_to_the_interface_statuses() {
    assert_eq!(TableError::Invalid.status(), Status::InvalidArgument);
    assert_eq!(TableError::Full.status(), Status::InvalidArgument);
    assert_eq!(TableError::Poisoned.status(), Status::Internal);
    assert_eq!(TableError::Poisoned.refusal().status, Status::Internal);
}

/// A thread panics while it holds the lock. No later call recovers the guard
/// and carries on: each reports the poisoned table, which the boundary turns
/// into `internal`.
#[test]
fn a_poisoned_lock_is_never_recovered() {
    let table: Arc<Table<u32>> = Arc::new(Table::new(Kind::Pin, PIN_TABLE_ENTRIES));
    let token = table.insert(3).expect("a free slot");
    let worker = Arc::clone(&table);
    let joined = std::thread::spawn(move || {
        let _ = worker.with(token, |_| panic!("a panic while the table lock is held"));
    })
    .join();
    assert!(joined.is_err(), "the thread panicked");
    assert_eq!(table.with(token, |value| *value), Err(TableError::Poisoned));
    assert_eq!(table.insert(4), Err(TableError::Poisoned));
    assert_eq!(table.remove(token), Err(TableError::Poisoned));
    assert_eq!(table.live(), Err(TableError::Poisoned));
    assert_eq!(table.has_room(), Err(TableError::Poisoned));
}
