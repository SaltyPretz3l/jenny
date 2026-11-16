//! Atomic write and conditional replacement (W7), in the order of the spec's
//! "Atomic write and conditional replacement" sequence.
//!
//! The temp is made in the pinned parent with `FILE_CREATE` and is shared for
//! read only, so nobody can rename, replace or delete it while the write
//! holds it; it is renamed by handle into that same parent. On every path
//! where the rename did not happen, the temp is deleted by handle.
#![forbid(unsafe_code)]

use std::thread;
use std::time::Duration;

use windows_sys::Wdk::Storage::FileSystem::{FILE_CREATE, FILE_NON_DIRECTORY_FILE};
use windows_sys::Win32::Foundation::{
    ERROR_INVALID_DATA, STATUS_INVALID_INFO_CLASS, STATUS_INVALID_PARAMETER, STATUS_NOT_SUPPORTED,
    STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND, STATUS_SHARING_VIOLATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_READONLY, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
};

use super::root::{io, pinned_handle, RootPin};
use super::sys::file::{self as sysfile, Open, RenameClass};
use super::sys::{OwnedHandle, SysError};
use super::walk::{self, FileIdentity, Target};
use crate::abi::{Reason, Refusal, Status};
use crate::pins::Table;

/// The waits before each retry of a rename that met a sharing violation:
/// five retries, 620 ms in all, then `busy`.
const RETRY_WAITS_MS: [u64; 5] = [20, 40, 80, 160, 320];
/// The largest read of the expected-bytes comparison.
const COMPARE_CHUNK: usize = 1024 * 1024;

/// What the caller expects at the leaf before the write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Expectation<'a> {
    /// No file by that name.
    MustNotExist,
    /// Anything, or nothing.
    NoExpectation,
    /// A regular file with exactly these bytes.
    Bytes(&'a [u8]),
}

/// How a write that was not refused ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    NotMatched,
    Replaced,
}

/// Which flush a `flush` hook follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flush {
    /// The temp's, before the rename.
    Temp,
    /// The renamed file's, after the rename.
    Renamed,
}

/// The `before_rename` hook: given the temp's name.
pub type BeforeRename<'a> = &'a mut dyn FnMut(&[u16]);
/// The `flush` hook: told which flush it follows.
pub type FlushHook<'a> = &'a mut dyn FnMut(Flush) -> Result<(), SysError>;

/// Test seams. Reachable only from Rust: no export takes or sets one.
#[derive(Default)]
pub struct WriteHooks<'a> {
    /// Runs once the temp is written and flushed, before the leaf is queried
    /// again.
    pub before_rename: Option<BeforeRename<'a>>,
    /// Runs after each real flush that succeeded; an `Err` counts as that
    /// flush failing.
    pub flush: Option<FlushHook<'a>>,
}

/// The leaf as the write found it.
struct Leaf {
    identity: FileIdentity,
    /// The on-disk spelling, which the rename keeps.
    on_disk: Vec<u16>,
}

/// Opens the leaf for its attributes. `None` when there is no such name; a
/// directory, or a junction, is `not_regular`.
fn open_leaf(parent: &OwnedHandle, leaf: &[u16]) -> Result<Option<OwnedHandle>, Refusal> {
    match sysfile::open_relative(parent, leaf, Target::QueryFile.open()) {
        Ok(handle) => Ok(Some(handle)),
        Err(SysError(code)) if code as i32 == STATUS_OBJECT_NAME_NOT_FOUND => Ok(None),
        Err(error) => Err(walk::refuse_open(error, Refusal::of(Status::NotFound))),
    }
}

/// Step 2: the leaf, refused unless it is missing or a regular file (W6)
/// under its own name and not read-only.
fn query_leaf(parent: &OwnedHandle, leaf: &[u16]) -> Result<Option<Leaf>, Refusal> {
    let Some(handle) = open_leaf(parent, leaf)? else {
        return Ok(None);
    };
    let identity = walk::read_regular(&handle)?;
    let on_disk = walk::check_name(&handle, leaf)?;
    if identity.info.attributes & FILE_ATTRIBUTE_READONLY != 0 {
        return Err(Refusal::path(Reason::TargetReadOnly));
    }
    Ok(Some(Leaf { identity, on_disk }))
}

/// Step 6: the leaf's identity now, `None` when it is gone.
fn leaf_identity(parent: &OwnedHandle, leaf: &[u16]) -> Result<Option<FileIdentity>, Refusal> {
    open_leaf(parent, leaf)?
        .map(|handle| FileIdentity::read(&handle))
        .transpose()
}

/// Whether the file holds exactly `expected`: reads the expected length plus
/// one byte at most per pass, and never more than one chunk (1 MiB) past it.
fn content_equals(handle: &OwnedHandle, expected: &[u8]) -> Result<bool, Refusal> {
    let mut chunk = vec![0u8; COMPARE_CHUNK.min(expected.len().saturating_add(1))];
    let mut rest = expected;
    loop {
        let read = sysfile::read_up_to(handle, &mut chunk).map_err(io)?;
        if read == 0 {
            return Ok(rest.is_empty());
        }
        let got = chunk
            .get(..read)
            .ok_or_else(|| io(SysError(ERROR_INVALID_DATA)))?;
        match rest.split_at_checked(read) {
            Some((want, after)) if want == got => rest = after,
            // Longer than expected, or different.
            _ => return Ok(false),
        }
    }
}

/// Step 3, as `_matches_expected` does it: identity, bytes, identity again.
fn expectation_holds(
    parent: &OwnedHandle,
    leaf: &[u16],
    found: Option<&Leaf>,
    expectation: Expectation<'_>,
) -> Result<bool, Refusal> {
    let (expected, found) = match (expectation, found) {
        (Expectation::NoExpectation, _) => return Ok(true),
        (Expectation::MustNotExist, found) => return Ok(found.is_none()),
        (Expectation::Bytes(_), None) => return Ok(false),
        (Expectation::Bytes(expected), Some(found)) => (expected, found),
    };
    let (handle, identity) = match walk::open_regular(parent, leaf, Target::ReadFile) {
        Ok(opened) => opened,
        Err(refusal) if refusal.status == Status::NotFound => return Ok(false),
        Err(refusal) => return Err(refusal),
    };
    if identity != found.identity || !content_equals(&handle, expected)? {
        return Ok(false);
    }
    Ok(FileIdentity::read(&handle)? == found.identity)
}

/// The temp file, deleted by handle when dropped unless it was renamed.
struct Temp {
    handle: OwnedHandle,
    name: Vec<u16>,
    renamed: bool,
}

impl Drop for Temp {
    fn drop(&mut self) {
        if !self.renamed {
            // A cleanup failure never changes the result (step 10).
            let _ = sysfile::delete_on_close(&self.handle);
        }
    }
}

/// `.host-<32 hex>.tmp`, the digits from the system random source.
fn temp_name() -> Result<Vec<u16>, Refusal> {
    let mut random = [0u8; 16];
    sysfile::random_bytes(&mut random).map_err(io)?;
    let digits: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(".host-{digits}.tmp").encode_utf16().collect())
}

/// Step 4: a new file in the parent, held with write and delete access and
/// shared for read only.
fn create_temp(parent: &OwnedHandle) -> Result<Temp, Refusal> {
    let name = temp_name()?;
    let open = Open {
        access: FILE_GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
        share: FILE_SHARE_READ,
        disposition: FILE_CREATE,
        options: FILE_NON_DIRECTORY_FILE,
    };
    let handle = sysfile::open_relative(parent, &name, open).map_err(io)?;
    Ok(Temp {
        handle,
        name,
        renamed: false,
    })
}

fn flush(handle: &OwnedHandle, stage: Flush, hooks: &mut WriteHooks<'_>) -> Result<(), SysError> {
    sysfile::flush(handle)?;
    match hooks.flush.as_mut() {
        Some(hook) => hook(stage),
        None => Ok(()),
    }
}

/// What step 6 answers for a changed leaf: refused with no expectation,
/// else not matched.
fn changed(expectation: Expectation<'_>) -> Result<Outcome, Refusal> {
    match expectation {
        Expectation::NoExpectation => Err(Refusal::path(Reason::None)),
        Expectation::MustNotExist | Expectation::Bytes(_) => Ok(Outcome::NotMatched),
    }
}

/// Step 7: the temp is still the file that was written: the same file
/// (volume and file index), one link, regular. Its times may move: an
/// attribute-only open is outside its sharing mode.
fn temp_unchanged(temp: &Temp, written: &FileIdentity) -> Result<(), Refusal> {
    let now = walk::read_regular(&temp.handle)?;
    let same = |identity: &FileIdentity| (identity.info.volume_serial, identity.info.file_index);
    if same(&now) != same(written) {
        return Err(Refusal::path(Reason::None));
    }
    Ok(())
}

/// The temp, the parent it was made in, and what the rename must find.
struct Rename<'a> {
    temp: &'a Temp,
    written: FileIdentity,
    parent: &'a OwnedHandle,
    leaf: &'a [u16],
    /// The leaf as step 2 found it; `None` when it was missing.
    found: Option<&'a Leaf>,
    expectation: Expectation<'a>,
}

impl Rename<'_> {
    /// Steps 6 and 7. `Some` is the answer when the leaf changed.
    fn recheck(&self) -> Result<Option<Outcome>, Refusal> {
        let before = self.found.map(|found| found.identity);
        if leaf_identity(self.parent, self.leaf)? != before {
            return changed(self.expectation).map(Some);
        }
        temp_unchanged(self.temp, &self.written)?;
        Ok(None)
    }

    /// Steps 6 to 8. Steps 6 and 7 run before the first rename and again
    /// before every retry, so a wait never renames over a leaf that changed
    /// during it. Replace is on only for a leaf that was there, under its
    /// on-disk spelling: a name that appears later is never overwritten.
    fn run(&self) -> Result<Option<Outcome>, Refusal> {
        let name = self
            .found
            .map_or(self.leaf, |found| found.on_disk.as_slice());
        let replace = self.found.is_some();
        let mut class = RenameClass::Extended;
        let mut waits = RETRY_WAITS_MS.iter();
        loop {
            if let Some(answer) = self.recheck()? {
                return Ok(Some(answer));
            }
            let code =
                match sysfile::rename_into(&self.temp.handle, self.parent, name, replace, class) {
                    Ok(()) => return Ok(None),
                    Err(SysError(code)) => code as i32,
                };
            match code {
                STATUS_INVALID_INFO_CLASS | STATUS_INVALID_PARAMETER | STATUS_NOT_SUPPORTED
                    if class == RenameClass::Extended =>
                {
                    class = RenameClass::Plain;
                }
                STATUS_OBJECT_NAME_COLLISION if !replace => {
                    return changed(self.expectation).map(Some)
                }
                STATUS_SHARING_VIOLATION => match waits.next() {
                    Some(&wait) => thread::sleep(Duration::from_millis(wait)),
                    None => return Err(Refusal::system(Status::Busy, code as u32)),
                },
                _ => return Err(io(SysError(code as u32))),
            }
        }
    }
}

/// The write, below an open root. `durability_uncertain` comes back as a
/// refusal whose status says so: the new content is then in place.
pub fn write_atomic(
    root: OwnedHandle,
    list: &[u16],
    content: &[u8],
    expectation: Expectation<'_>,
    hooks: &mut WriteHooks<'_>,
) -> Result<Outcome, Refusal> {
    // 1. Every name is validated before the walk creates anything.
    let (parents, leaf) = walk::split_leaf(list)?;
    let parent = walk::walk_creating(root, &parents)?;
    // 2 and 3.
    let found = query_leaf(&parent, leaf)?;
    if !expectation_holds(&parent, leaf, found.as_ref(), expectation)? {
        return Ok(Outcome::NotMatched);
    }
    // 4 and 5.
    let mut temp = create_temp(&parent)?;
    sysfile::write_all(&temp.handle, content).map_err(io)?;
    flush(&temp.handle, Flush::Temp, hooks).map_err(io)?;
    let written = walk::read_regular(&temp.handle)?;
    if let Some(hook) = hooks.before_rename.as_mut() {
        hook(&temp.name);
    }
    // 6 to 8.
    let rename = Rename {
        temp: &temp,
        written,
        parent: &parent,
        leaf,
        found: found.as_ref(),
        expectation,
    };
    if let Some(answer) = rename.run()? {
        return Ok(answer);
    }
    temp.renamed = true;
    // 9.
    flush(&temp.handle, Flush::Renamed, hooks)
        .map_err(|error| Refusal::system(Status::DurabilityUncertain, error.0))?;
    Ok(Outcome::Replaced)
}

/// `jfa_write_atomic` on a pin.
pub fn write_pinned(
    pins: &Table<RootPin>,
    pin: u64,
    list: &[u16],
    content: &[u8],
    expectation: Expectation<'_>,
) -> Result<Outcome, Refusal> {
    let (root, _) = pinned_handle(pins, pin)?;
    write_atomic(root, list, content, expectation, &mut WriteHooks::default())
}
