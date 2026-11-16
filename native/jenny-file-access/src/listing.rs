//! The listing record encoder. Pure.
//!
//! A listing crosses the boundary as one buffer of records. A record is
//! little-endian and unpadded: flags (`u32`), size (`u64`), the name's length in
//! UTF-16 code units (`u16`), then the name's code units.
#![forbid(unsafe_code)]

use crate::abi::{
    LISTING_FLAG_DIRECTORY, LISTING_FLAG_REPARSE_POINT, LISTING_FLAG_SIZE_KNOWN,
    LISTING_HEADER_BYTES,
};

/// The flags of one record.
pub const fn record_flags(directory: bool, reparse_point: bool, size_known: bool) -> u32 {
    let mut flags = 0;
    if directory {
        flags |= LISTING_FLAG_DIRECTORY;
    }
    if reparse_point {
        flags |= LISTING_FLAG_REPARSE_POINT;
    }
    if size_known {
        flags |= LISTING_FLAG_SIZE_KNOWN;
    }
    flags
}

/// A name longer than a record's length field can say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NameTooLong;

/// Fills a caller's buffer with records, in the order they are pushed.
///
/// A record that does not fit is counted, not written, and no later record is
/// written either, so the buffer always holds a prefix of the listing.
/// `bytes_needed` keeps growing: it is the size the whole listing needs.
pub struct ListingWriter<'a> {
    buffer: &'a mut [u8],
    used: usize,
    needed: usize,
    entries: u32,
}

impl<'a> ListingWriter<'a> {
    pub fn new(buffer: &'a mut [u8]) -> Self {
        Self {
            buffer,
            used: 0,
            needed: 0,
            entries: 0,
        }
    }

    /// Adds one record. `Ok(false)` means it did not fit.
    pub fn push(&mut self, flags: u32, size: u64, name: &[u16]) -> Result<bool, NameTooLong> {
        let name_units = u16::try_from(name.len()).map_err(|_| NameTooLong)?;
        let length = LISTING_HEADER_BYTES + 2 * name.len();
        let fits_so_far = self.needed == self.used;
        self.needed = self.needed.saturating_add(length);
        if !fits_so_far {
            return Ok(false);
        }
        let Some(record) = self.buffer.get_mut(self.used..self.needed) else {
            return Ok(false);
        };
        let header = flags
            .to_le_bytes()
            .into_iter()
            .chain(size.to_le_bytes())
            .chain(name_units.to_le_bytes());
        let units = name.iter().flat_map(|unit| unit.to_le_bytes());
        for (slot, byte) in record.iter_mut().zip(header.chain(units)) {
            *slot = byte;
        }
        self.used = self.needed;
        self.entries = self.entries.saturating_add(1);
        Ok(true)
    }

    /// Bytes written to the buffer.
    pub fn bytes_used(&self) -> usize {
        self.used
    }

    /// Bytes every pushed record needs together.
    pub fn bytes_needed(&self) -> usize {
        self.needed
    }

    /// Records written to the buffer.
    pub fn entry_count(&self) -> u32 {
        self.entries
    }

    /// True when every pushed record was written.
    pub fn complete(&self) -> bool {
        self.used == self.needed
    }
}
