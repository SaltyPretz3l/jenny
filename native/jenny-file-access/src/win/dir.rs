//! Listing a directory by handle, and the root's self-check.
//!
//! A listing walks to its directory, opens a handle of its own and enumerates
//! that handle. Entries are reported as the file system gives them: a reparse
//! point is a non-directory of unknown size, never followed.
#![forbid(unsafe_code)]

use std::mem::offset_of;

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_INVALID_DATA, STATUS_ACCESS_DENIED,
    STATUS_DELETE_PENDING,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_BOTH_DIR_INFO,
};

use super::root::{io, pinned_handle, RootPin};
use super::sys::file as sysfile;
use super::sys::{OwnedHandle, SysError};
use super::walk::{self, Target};
use crate::abi::{Reason, Refusal, Status};
use crate::listing::{record_flags, ListingWriter};
use crate::names::{split_segments, validate_segment};
use crate::pins::Table;

const DOT: u16 = 0x2E;
/// One enumeration call's buffer: 64 KiB, 8-byte aligned.
const CHUNK_WORDS: usize = 8 * 1024;

/// One directory entry as the enumeration reports it.
struct Entry {
    attributes: u32,
    size: i64,
    name: Vec<u16>,
}

impl Entry {
    fn dots(&self) -> bool {
        matches!(self.name.as_slice(), [DOT] | [DOT, DOT])
    }

    fn reparse_point(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    fn directory(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_DIRECTORY != 0 && !self.reparse_point()
    }
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn i64_at(bytes: &[u8], at: usize) -> Option<i64> {
    Some(i64::from_le_bytes(
        bytes.get(at..at.checked_add(8)?)?.try_into().ok()?,
    ))
}

/// Calls `visit` on each `FILE_ID_BOTH_DIR_INFO` record of one buffer, read
/// in place, until it returns false (then `Ok(false)`). Every offset and
/// length is bounds checked; a record that does not fit, or an offset that
/// does not move forward, is malformed.
fn parse(
    bytes: &[u8],
    mut visit: impl FnMut(Entry) -> Result<bool, Refusal>,
) -> Result<bool, Refusal> {
    let malformed = || io(SysError(ERROR_INVALID_DATA));
    let mut at = 0usize;
    loop {
        let field = |offset: usize| at.checked_add(offset).ok_or_else(malformed);
        let attributes = u32_at(
            bytes,
            field(offset_of!(FILE_ID_BOTH_DIR_INFO, FileAttributes))?,
        );
        let size = i64_at(bytes, field(offset_of!(FILE_ID_BOTH_DIR_INFO, EndOfFile))?);
        let length = u32_at(
            bytes,
            field(offset_of!(FILE_ID_BOTH_DIR_INFO, FileNameLength))?,
        );
        let next = u32_at(bytes, at);
        let (Some(attributes), Some(size), Some(length), Some(next)) =
            (attributes, size, length, next)
        else {
            return Err(malformed());
        };
        let start = field(offset_of!(FILE_ID_BOTH_DIR_INFO, FileName))?;
        let name_bytes = start
            .checked_add(length as usize)
            .and_then(|end| bytes.get(start..end))
            .filter(|name| name.len() % 2 == 0)
            .ok_or_else(malformed)?;
        let name = name_bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&pair| u16::from_le_bytes(pair))
            .collect();
        let entry = Entry {
            attributes,
            size,
            name,
        };
        if !visit(entry)? {
            return Ok(false);
        }
        if next == 0 {
            return Ok(true);
        }
        at = at
            .checked_add(next as usize)
            .filter(|&next_at| next_at < bytes.len())
            .ok_or_else(malformed)?;
    }
}

/// Calls `visit` on every entry but `.` and `..`, in directory order, until it
/// returns false or the directory ends.
fn each_entry(
    directory: &OwnedHandle,
    mut visit: impl FnMut(&Entry) -> Result<bool, Refusal>,
) -> Result<(), Refusal> {
    let mut chunk = vec![0u64; CHUNK_WORDS];
    let mut restart = true;
    while sysfile::directory_records(directory, restart, &mut chunk).map_err(io)? {
        restart = false;
        let records = sysfile::record_bytes(&chunk);
        let go_on = parse(records, |entry| {
            if entry.dots() {
                Ok(true)
            } else {
                visit(&entry)
            }
        })?;
        if !go_on {
            return Ok(());
        }
    }
    Ok(())
}

/// What a listing wrote, and what the whole listing needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Listing {
    pub bytes_used: usize,
    pub bytes_needed: usize,
    pub entries: u32,
    /// False when the buffer was too small for every record.
    pub complete: bool,
}

/// Lists the directory `list` names below `root` (the root itself when the
/// list is empty): at most `max_entries` records, in directory order.
pub fn list(
    root: OwnedHandle,
    list: &[u16],
    max_entries: u32,
    buffer: &mut [u8],
) -> Result<Listing, Refusal> {
    let segments = split_segments(list).map_err(|error| error.refusal())?;
    let directory = if segments.is_empty() {
        walk::reopen_directory(&root)?
    } else {
        walk::walk(root, &segments)?
    };
    let mut writer = ListingWriter::new(buffer);
    let mut seen = 0u32;
    // The limit is checked before each entry is taken, so a scan stops at
    // `max_entries` without reading the rest of the chunk.
    each_entry(&directory, |entry| {
        if seen == max_entries {
            return Ok(false);
        }
        seen += 1;
        let directory = entry.directory();
        let size_known = !directory && !entry.reparse_point();
        let size = if size_known {
            u64::try_from(entry.size).unwrap_or(0)
        } else {
            0
        };
        let flags = record_flags(directory, entry.reparse_point(), size_known);
        writer
            .push(flags, size, &entry.name)
            .map_err(|_| io(SysError(ERROR_INVALID_DATA)))?;
        Ok(true)
    })?;
    Ok(Listing {
        bytes_used: writer.bytes_used(),
        bytes_needed: writer.bytes_needed(),
        entries: writer.entry_count(),
        complete: writer.complete(),
    })
}

/// `jfa_list` on a pin.
pub fn list_pinned(
    pins: &Table<RootPin>,
    pin: u64,
    segments: &[u16],
    max_entries: u32,
    buffer: &mut [u8],
) -> Result<Listing, Refusal> {
    let (root, _) = pinned_handle(pins, pin)?;
    list(root, segments, max_entries, buffer)
}

/// A listed entry that is gone, delete-pending or renamed by the time it is
/// opened: another program's own file came and went, which says nothing about
/// the walk (R12-F02). A name mismatch counts: the listed name is the long
/// name, so the opened file's final path names another entry only when it
/// was renamed or deleted after the listing (a file deleted with POSIX
/// semantics reports its new place under `$Extend`), and the open and the
/// by-handle reads behind that answer have run. Every other refusal, a
/// refused `OBJ_DONT_REPARSE` among them, is a real failure of the check.
fn vanished(refusal: &Refusal) -> bool {
    refusal.status == Status::NotFound
        || refusal.reason == Reason::AliasMismatch
        || refusal.system == STATUS_DELETE_PENDING as u32
        || refusal.system == ERROR_FILE_NOT_FOUND
}

/// An entry the opener's own access list refuses (a file or folder the owner
/// locked, or one another program made private). The check proves the library
/// works on this root, not that every entry is open to it, so such an entry
/// says nothing about the root: it is passed over like a vanished one.
fn denied(refusal: &Refusal) -> bool {
    refusal.system == STATUS_ACCESS_DENIED as u32 || refusal.system == ERROR_ACCESS_DENIED
}

/// Runs `attempt`, and once more when it failed: an entry swapped for a link
/// or another kind of file while the check ran fails that attempt, and the
/// second one settles it. A second failure is the answer, for this call only;
/// nothing is remembered.
fn retry_once<T, E>(mut attempt: impl FnMut() -> Result<T, E>) -> Result<T, E> {
    attempt().or_else(|_| attempt())
}

/// The root's read-only self-check: list the root from a handle of its own,
/// then open and close, through the walk, the first entry that is a plain
/// file or directory with a valid name and is still there. An entry that
/// vanished between the listing and the open, or that its access list denies,
/// is passed over for the next one. A root with no such entry passes. A
/// failure is tried once more before it is reported.
pub fn self_check(root: &OwnedHandle) -> Result<(), SysError> {
    retry_once(|| self_check_once(root))
}

fn self_check_once(root: &OwnedHandle) -> Result<(), SysError> {
    let failed = |refusal: Refusal| SysError(refusal.system);
    let directory = walk::reopen_directory(root).map_err(failed)?;
    let mut opened = Ok(());
    each_entry(&directory, |entry| {
        if entry.reparse_point() || validate_segment(&entry.name).is_err() {
            return Ok(true);
        }
        let target = if entry.directory() {
            Target::Directory
        } else {
            Target::QueryFile
        };
        opened = walk::open_child(
            &directory,
            &entry.name,
            target,
            Refusal::of(Status::NotFound),
        )
        .map(drop);
        match &opened {
            Err(refusal) if vanished(refusal) || denied(refusal) => {
                opened = Ok(());
                Ok(true)
            }
            _ => Ok(false),
        }
    })
    .map_err(failed)?;
    opened.map_err(failed)
}

#[cfg(test)]
mod tests {
    use windows_sys::Win32::Foundation::{STATUS_ACCESS_DENIED, STATUS_INVALID_PARAMETER};

    use super::{
        denied, io, retry_once, vanished, SysError, ERROR_FILE_NOT_FOUND, STATUS_DELETE_PENDING,
    };
    use crate::abi::{Reason, Refusal, Status};

    /// An entry that came and went is passed over; a refused open flag, a
    /// denied open or a reparse point at the name still fails the check.
    #[test]
    fn only_an_entry_that_vanished_is_passed_over() {
        assert!(vanished(&Refusal::of(Status::NotFound)));
        assert!(vanished(&Refusal::path(Reason::AliasMismatch)));
        assert!(vanished(&io(SysError(STATUS_DELETE_PENDING as u32))));
        assert!(vanished(&io(SysError(ERROR_FILE_NOT_FOUND))));
        assert!(!vanished(&io(SysError(STATUS_INVALID_PARAMETER as u32))));
        assert!(!vanished(&io(SysError(STATUS_ACCESS_DENIED as u32))));
        assert!(!vanished(&Refusal::path(Reason::ReparsePoint)));
        assert!(!vanished(&Refusal::path(Reason::NotRegular)));
    }

    /// Only an access-denied open is passed over for being denied: a refused
    /// open flag, a link at the name or another kind of file still fails.
    #[test]
    fn only_an_access_denied_entry_is_passed_over_as_denied() {
        assert!(denied(&io(SysError(STATUS_ACCESS_DENIED as u32))));
        assert!(denied(&io(SysError(5))));
        assert!(!denied(&io(SysError(STATUS_INVALID_PARAMETER as u32))));
        assert!(!denied(&Refusal::path(Reason::ReparsePoint)));
        assert!(!denied(&Refusal::path(Reason::NotRegular)));
        assert!(!denied(&Refusal::of(Status::NotFound)));
    }

    /// A swapped entry fails the first attempt and the second settles it; a
    /// second failure is reported after exactly two attempts, never a third.
    #[test]
    fn a_failed_check_is_tried_once_more_and_no_further() {
        let mut calls = 0;
        let settled = retry_once(|| {
            calls += 1;
            if calls == 1 {
                Err("swapped")
            } else {
                Ok(())
            }
        });
        assert_eq!((settled, calls), (Ok(()), 2));
        let mut calls = 0;
        let failed: Result<(), &str> = retry_once(|| {
            calls += 1;
            Err("still swapped")
        });
        assert_eq!((failed, calls), (Err("still swapped"), 2));
        let mut calls = 0;
        assert_eq!(
            retry_once(|| {
                calls += 1;
                Ok::<_, ()>(())
            }),
            Ok(())
        );
        assert_eq!(calls, 1);
    }
}
