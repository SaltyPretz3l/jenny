//! The root pin (W4): the root's shape, the open, the checks by handle, the
//! identity, and the pin table.
//!
//! The root path is the one path string in the design, and it is the trusted
//! configured root. Nothing below the root is opened here.
#![forbid(unsafe_code)]

use std::sync::{Mutex, PoisonError};

use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
};

use super::policy::{check_token, check_volume, SystemProbe};
use super::sys::{self, FileInformation, OwnedHandle, SysError};
use crate::abi::{Reason, Refusal, Status, PIN_TABLE_ENTRIES};
use crate::names::validate_segment;
use crate::pins::{Kind, Table, TableError};

/// A directory's identity: the volume serial number and the file index, the
/// pair Node and Python report as `dev` and `ino`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub device: u64,
    pub inode: u64,
}

impl Identity {
    fn of(info: &FileInformation) -> Self {
        Self {
            device: u64::from(info.volume_serial),
            inode: info.file_index,
        }
    }
}

/// An open, checked root. While it lives, the root and its ancestors cannot be
/// renamed or deleted: the handle is not shared for delete.
#[derive(Debug)]
pub struct RootPin {
    handle: OwnedHandle,
    identity: Identity,
}

impl RootPin {
    pub fn identity(&self) -> Identity {
        self.identity
    }
}

/// The roots whose self-check passed in this process, by identity. The check
/// enumerates a directory, so it runs once per root and not on every tool
/// call; everything else `open_root` decides still runs on each open. Only a
/// pass is remembered, and the list is bounded: the oldest entry makes room.
static CHECKED_ROOTS: Mutex<Vec<Identity>> = Mutex::new(Vec::new());
/// More roots than one process pins in practice; a forgotten root is checked
/// again, which costs one enumeration.
const CHECKED_ROOTS_MAX: usize = 256;

fn already_checked(identity: Identity) -> bool {
    let checked = CHECKED_ROOTS.lock().unwrap_or_else(PoisonError::into_inner);
    checked.contains(&identity)
}

fn remember_checked(identity: Identity) {
    let mut checked = CHECKED_ROOTS.lock().unwrap_or_else(PoisonError::into_inner);
    if checked.contains(&identity) {
        return;
    }
    if checked.len() == CHECKED_ROOTS_MAX {
        checked.remove(0);
    }
    checked.push(identity);
}

/// The pins the exports hand out.
pub static PINS: Table<RootPin> = Table::new(Kind::Pin, PIN_TABLE_ENTRIES);

pub(crate) const BACKSLASH: u16 = 0x5C;
const COLON: u16 = 0x3A;
/// `\\?\`
const EXTENDED_PREFIX: [u16; 4] = [0x5C, 0x5C, 0x3F, 0x5C];
/// `UNC\`, what follows the prefix in the final path of a network file.
const UNC_PREFIX: [u16; 4] = [0x55, 0x4E, 0x43, 0x5C];
/// A path the system could not take anyway.
pub const MAX_ROOT_UNITS: usize = 32_000;

/// A failed system call, with the system's code.
pub(crate) fn io(error: SysError) -> Refusal {
    Refusal::system(Status::IoFailed, error.0)
}

/// A root is `X:\` followed by one or more plain components: no drive or
/// volume root, no UNC path, no `\\?\` or `\\.\` form, nothing relative, no
/// trailing separator, no `.` or `..`. The `\\?\` open takes every component
/// literally, so each must pass the segment rules.
pub fn check_root_shape(root: &[u16]) -> Result<(), Refusal> {
    let invalid = Refusal::of(Status::RootInvalid);
    let [letter, COLON, BACKSLASH, components @ ..] = root else {
        return Err(invalid);
    };
    let is_letter = matches!(letter, 0x41..=0x5A | 0x61..=0x7A);
    if !is_letter || components.is_empty() || root.len() > MAX_ROOT_UNITS {
        return Err(invalid);
    }
    for component in components.split(|&unit| unit == BACKSLASH) {
        validate_segment(component).map_err(|_| invalid)?;
    }
    Ok(())
}

/// Runs the whole decision for one root, in the spec's order, and returns the
/// open root. Every refusal closes what was opened.
pub fn open_root<P: SystemProbe>(
    probe: &P,
    root: &[u16],
    expected: Identity,
) -> Result<RootPin, Refusal> {
    // 1. The checks that need no handle.
    if !probe.api_present() {
        return Err(Refusal::of(Status::ApiMissing));
    }
    let token = probe.token().map_err(io)?;
    check_token(&token).map_err(Refusal::of)?;

    // 2. The root's shape.
    check_root_shape(root)?;

    // 3. The one open by path.
    let path: Vec<u16> = EXTENDED_PREFIX
        .iter()
        .chain(root)
        .copied()
        .chain([0])
        .collect();
    let handle = probe.open_root(&path).map_err(io)?;

    // 4. By handle: the volume, the attributes, the final path.
    let volume = probe.volume(&handle).map_err(io)?;
    check_volume(&volume).map_err(|_| Refusal::of(Status::VolumeUnsupported))?;
    let info = sys::file_information(&handle).map_err(io)?;
    let directory = info.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    let reparse_point = info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    if !directory || reparse_point {
        return Err(Refusal::of(Status::RootInvalid));
    }
    let final_path = sys::final_path(&handle).map_err(io)?;
    let Some(final_root) = final_path.strip_prefix(&EXTENDED_PREFIX) else {
        return Err(Refusal::of(Status::RootInvalid));
    };
    if final_root.starts_with(&UNC_PREFIX) {
        return Err(Refusal::of(Status::VolumeUnsupported));
    }
    if !sys::equal_ignore_case(final_root, root).map_err(io)? {
        return Err(Refusal::of(Status::RootInvalid));
    }

    // 5. The identity. A root with no recorded identity is refused.
    let identity = Identity::of(&info);
    if expected.device == 0 || expected.inode == 0 || expected != identity {
        return Err(Refusal::of(Status::RootIdentity));
    }

    // 6. The read-only self-check, once per root in this process. The identity
    // above was read from this handle, so a root that is not the one that
    // passed is checked itself.
    if !already_checked(identity) {
        probe
            .self_check(&handle)
            .map_err(|error| Refusal::system(Status::SelfcheckFailed, error.0))?;
        remember_checked(identity);
    }
    Ok(RootPin { handle, identity })
}

/// Opens a root and stores it. A full table closes the root again.
pub fn pin_root<P: SystemProbe>(
    probe: &P,
    table: &Table<RootPin>,
    root: &[u16],
    expected: Identity,
) -> Result<u64, Refusal> {
    let pin = open_root(probe, root, expected)?;
    table.insert(pin).map_err(TableError::refusal)
}

/// A duplicate of a pinned root for one operation, with the pinned identity.
///
/// The duplicate is made under the table's lock, so a close on another thread
/// cannot close a handle in use. The identity is then read again by handle,
/// which shows only that the handle still answers: a root whose volume went
/// away fails here with `io_failed`. A duplicate names the same open
/// directory, whose volume and index do not change, so the comparison is not
/// expected to differ; should it, the answer is `root_changed`. What keeps a
/// swapped mount point or a changed path out is that every later open is
/// relative to this handle, not this read.
pub fn pinned_handle(
    table: &Table<RootPin>,
    token: u64,
) -> Result<(OwnedHandle, Identity), Refusal> {
    let (copy, pinned) = table
        .with(token, |pin| (pin.handle.duplicate(), pin.identity))
        .map_err(TableError::refusal)?;
    let copy = copy.map_err(io)?;
    let info = sys::file_information(&copy).map_err(io)?;
    if Identity::of(&info) != pinned {
        return Err(Refusal::path(Reason::RootChanged));
    }
    Ok((copy, pinned))
}

pub fn pin_identity(table: &Table<RootPin>, token: u64) -> Result<Identity, Refusal> {
    pinned_handle(table, token).map(|(_, identity)| identity)
}

/// Closes the root handle and frees the slot. A second close is refused and
/// closes nothing.
pub fn pin_close(table: &Table<RootPin>, token: u64) -> Result<(), Refusal> {
    table.remove(token).map(drop).map_err(TableError::refusal)
}
