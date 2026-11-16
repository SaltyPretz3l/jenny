//! Generation-checked token tables for pins and open files. Pure.
//!
//! A token is a number, never an address: the table's kind in the top byte, a
//! slot generation, and a slot index. A token is looked up, bounds checked and
//! compared; nothing is ever dereferenced from one. A stale, repeated,
//! wrong-kind or never-issued token is refused.
#![forbid(unsafe_code)]

use std::sync::Mutex;

use crate::abi::{Refusal, Status};

/// What a table holds. The value is the top byte of every token it issues.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Pin = 0x50,
    File = 0x46,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableError {
    /// The token names nothing this table holds now.
    Invalid,
    /// Every slot is in use.
    Full,
    /// A thread panicked while it held the lock. The table stays unusable.
    Poisoned,
}

impl TableError {
    pub const fn status(self) -> Status {
        match self {
            TableError::Invalid | TableError::Full => Status::InvalidArgument,
            TableError::Poisoned => Status::Internal,
        }
    }

    pub const fn refusal(self) -> Refusal {
        Refusal::of(self.status())
    }
}

const KIND_SHIFT: u32 = 56;
const GENERATION_SHIFT: u32 = 16;
const INDEX_MASK: u64 = 0xFFFF;
/// Bits 48 to 55 are never set in a token.
const RESERVED_MASK: u64 = 0x00FF_0000_0000_0000;
/// A slot whose generation reached this value is never issued again.
const RETIRED: u32 = u32::MAX;

struct Slot<T> {
    /// The generation of the value held now, or of the next one.
    generation: u32,
    value: Option<T>,
}

/// At most `capacity` values behind one mutex. A poisoned lock is never
/// recovered: every later call reports `Poisoned`.
pub struct Table<T> {
    kind: Kind,
    capacity: usize,
    slots: Mutex<Vec<Slot<T>>>,
}

impl<T> Table<T> {
    /// `capacity` is at most 65536, the range of the token's index field.
    pub const fn new(kind: Kind, capacity: usize) -> Self {
        Self {
            kind,
            capacity,
            slots: Mutex::new(Vec::new()),
        }
    }

    fn token(&self, generation: u32, index: usize) -> u64 {
        (u64::from(self.kind as u8) << KIND_SHIFT)
            | (u64::from(generation) << GENERATION_SHIFT)
            | (index as u64 & INDEX_MASK)
    }

    /// The slot index and generation a token names, if it has this table's shape.
    fn decode(&self, token: u64) -> Option<(usize, u32)> {
        let kind = (token >> KIND_SHIFT) as u8;
        let generation = (token >> GENERATION_SHIFT) as u32;
        if kind != self.kind as u8 || token & RESERVED_MASK != 0 || generation == 0 {
            return None;
        }
        Some(((token & INDEX_MASK) as usize, generation))
    }

    /// Whether an `insert` now would find a slot: lets a caller refuse a full
    /// table before it does the work whose result it would store.
    pub fn has_room(&self) -> Result<bool, TableError> {
        let slots = self.slots.lock().map_err(|_| TableError::Poisoned)?;
        let reusable = slots
            .iter()
            .any(|slot| slot.value.is_none() && slot.generation != RETIRED);
        Ok(reusable || (slots.len() < self.capacity && slots.len() <= INDEX_MASK as usize))
    }

    /// Stores a value and returns its token. A full table drops the value.
    pub fn insert(&self, value: T) -> Result<u64, TableError> {
        let mut slots = self.slots.lock().map_err(|_| TableError::Poisoned)?;
        let free = slots
            .iter_mut()
            .enumerate()
            .find(|(_, slot)| slot.value.is_none() && slot.generation != RETIRED);
        if let Some((index, slot)) = free {
            slot.value = Some(value);
            return Ok(self.token(slot.generation, index));
        }
        let index = slots.len();
        if index >= self.capacity || index > INDEX_MASK as usize {
            return Err(TableError::Full);
        }
        slots.push(Slot {
            generation: 1,
            value: Some(value),
        });
        Ok(self.token(1, index))
    }

    /// Runs `body` on the value a token names, under the lock.
    pub fn with<R>(&self, token: u64, body: impl FnOnce(&T) -> R) -> Result<R, TableError> {
        let (index, generation) = self.decode(token).ok_or(TableError::Invalid)?;
        let slots = self.slots.lock().map_err(|_| TableError::Poisoned)?;
        match slots.get(index) {
            Some(Slot {
                generation: held,
                value: Some(value),
            }) if *held == generation => Ok(body(value)),
            _ => Err(TableError::Invalid),
        }
    }

    /// Takes the value out and frees its slot. The token is stale from here on.
    pub fn remove(&self, token: u64) -> Result<T, TableError> {
        let (index, generation) = self.decode(token).ok_or(TableError::Invalid)?;
        let mut slots = self.slots.lock().map_err(|_| TableError::Poisoned)?;
        let slot = slots.get_mut(index).ok_or(TableError::Invalid)?;
        if slot.generation != generation {
            return Err(TableError::Invalid);
        }
        let value = slot.value.take().ok_or(TableError::Invalid)?;
        slot.generation = slot.generation.saturating_add(1);
        Ok(value)
    }

    /// How many values the table holds now.
    pub fn live(&self) -> Result<usize, TableError> {
        let slots = self.slots.lock().map_err(|_| TableError::Poisoned)?;
        Ok(slots.iter().filter(|slot| slot.value.is_some()).count())
    }
}

#[cfg(test)]
mod tests {
    use super::{Kind, Slot, Table, TableError, RETIRED};

    /// A one-slot table whose slot starts at a chosen generation. No caller
    /// can reach a generation this high, so the test writes the field.
    fn table_at(generation: u32, value: Option<u8>) -> Table<u8> {
        let table = Table::new(Kind::Pin, 1);
        let pushed = table
            .slots
            .lock()
            .map(|mut slots| slots.push(Slot { generation, value }))
            .is_ok();
        assert!(pushed);
        table
    }

    #[test]
    fn a_slot_is_issued_at_its_last_generation_and_then_never_again() {
        let table = table_at(RETIRED - 1, None);
        let last = table.token(RETIRED - 1, 0);
        assert_eq!(table.insert(7), Ok(last), "the last generation is issued");
        assert_eq!(table.remove(last), Ok(7));
        assert_eq!(
            table.insert(8),
            Err(TableError::Full),
            "the slot is retired"
        );
        assert_eq!(table.with(last, |_| ()), Err(TableError::Invalid));
        assert_eq!(table.remove(last), Err(TableError::Invalid));
        assert_eq!(table.live(), Ok(0));
    }

    /// A value held at the retired generation is a state `insert` never
    /// makes. Were it made, the generation must stay where it is: one that
    /// wrapped would put the slot back in use.
    #[test]
    fn a_generation_never_wraps() {
        let table = table_at(RETIRED, Some(7));
        assert_eq!(table.remove(table.token(RETIRED, 0)), Ok(7));
        assert_eq!(table.insert(8), Err(TableError::Full));
    }
}
