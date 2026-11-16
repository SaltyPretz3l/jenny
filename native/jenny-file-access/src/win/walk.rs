//! The segment walk below a pinned root (and the write's creating walk), the
//! on-disk name comparison, the regular-file open and its identity (W6), and
//! the table of open files.
//!
//! Every open names one component relative to a directory handle the walk
//! holds, and every handle is checked by handle before the walk goes on: a
//! reparse point is refused, never traversed, and a name the file system
//! resolved to another spelling (an 8.3 alias) is refused.
#![forbid(unsafe_code)]

use std::cell::Cell;

use windows_sys::Wdk::Storage::FileSystem::{
    FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
};
use windows_sys::Win32::Foundation::{
    STATUS_FILE_IS_A_DIRECTORY, STATUS_NOT_A_DIRECTORY, STATUS_OBJECT_NAME_COLLISION,
    STATUS_OBJECT_NAME_INVALID, STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND,
    STATUS_REPARSE_POINT_ENCOUNTERED,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
};

use super::root::{io, pinned_handle, RootPin, BACKSLASH};
use super::sys::file::{self as sysfile, Open};
use super::sys::{self, FileInformation, OwnedHandle, SysError, TakenHandle};
use crate::abi::{Reason, Refusal, Status, FILE_TABLE_ENTRIES};
use crate::names::split_segments;
use crate::pins::{Kind, Table, TableError};

/// Everything W6 names about a file, read by handle: the ids, size, last
/// write time, change time, link count and attributes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileIdentity {
    pub info: FileInformation,
    pub change_time: i64,
}

impl FileIdentity {
    pub fn read(handle: &OwnedHandle) -> Result<Self, Refusal> {
        Ok(Self {
            info: sys::file_information(handle).map_err(io)?,
            change_time: sysfile::change_time(handle).map_err(io)?,
        })
    }

    pub fn directory(&self) -> bool {
        self.info.attributes & FILE_ATTRIBUTE_DIRECTORY != 0
    }

    pub fn reparse_point(&self) -> bool {
        self.info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
}

/// What a component is opened as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// A directory the walk goes through or lists.
    Directory,
    /// A file whose content is read.
    ReadFile,
    /// A file whose attributes are read, and nothing else.
    QueryFile,
}

impl Target {
    pub const fn open(self) -> Open {
        let (access, options) = match self {
            Target::Directory => (
                FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
                FILE_DIRECTORY_FILE,
            ),
            Target::ReadFile => (
                FILE_READ_DATA | FILE_READ_ATTRIBUTES,
                FILE_NON_DIRECTORY_FILE,
            ),
            Target::QueryFile => (FILE_READ_ATTRIBUTES, FILE_NON_DIRECTORY_FILE),
        };
        Open {
            access,
            share: FILE_SHARE_READ | FILE_SHARE_WRITE,
            disposition: FILE_OPEN,
            options,
        }
    }
}

/// What a failed relative open means. `missing` is the answer for a name
/// that does not exist: `not_found` for a leaf that is read, a refusal for a
/// directory the walk needs.
pub fn refuse_open(error: SysError, missing: Refusal) -> Refusal {
    match error.0 as i32 {
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND => missing,
        // A file where the walk needs a directory.
        STATUS_NOT_A_DIRECTORY => Refusal::path(Reason::MissingDirectory),
        STATUS_FILE_IS_A_DIRECTORY => Refusal::path(Reason::NotRegular),
        STATUS_REPARSE_POINT_ENCOUNTERED => Refusal::path(Reason::ReparsePoint),
        STATUS_OBJECT_NAME_INVALID => Refusal::path(Reason::NameInvalid),
        _ => io(error),
    }
}

/// The final component of an open file's on-disk long name. A short name or
/// another spelling that opened it is not what comes back.
fn on_disk_name(handle: &OwnedHandle) -> Result<Vec<u16>, Refusal> {
    let path = sys::final_path(handle).map_err(io)?;
    let start = path
        .iter()
        .rposition(|&unit| unit == BACKSLASH)
        .map_or(0, |at| at + 1);
    Ok(path.get(start..).unwrap_or_default().to_vec())
}

/// Refuses a handle whose on-disk name is not the requested segment, case
/// folded: an 8.3 alias or a spelling the name rules never judged. Returns
/// the on-disk spelling, which a replacing write keeps.
pub fn check_name(handle: &OwnedHandle, requested: &[u16]) -> Result<Vec<u16>, Refusal> {
    let on_disk = on_disk_name(handle)?;
    if !sys::equal_ignore_case(&on_disk, requested).map_err(io)? {
        return Err(Refusal::path(Reason::AliasMismatch));
    }
    Ok(on_disk)
}

/// Checks what was opened against what was asked for, by handle.
fn check_opened(
    handle: &OwnedHandle,
    name: &[u16],
    target: Target,
) -> Result<FileIdentity, Refusal> {
    let identity = FileIdentity::read(handle)?;
    if identity.reparse_point() {
        return Err(Refusal::path(Reason::ReparsePoint));
    }
    if identity.directory() != (target == Target::Directory) {
        return Err(Refusal::path(if target == Target::Directory {
            Reason::MissingDirectory
        } else {
            Reason::NotRegular
        }));
    }
    check_name(handle, name)?;
    Ok(identity)
}

/// Opens one component of `parent` as `target` and checks it by handle.
pub fn open_child(
    parent: &OwnedHandle,
    name: &[u16],
    target: Target,
    missing: Refusal,
) -> Result<(OwnedHandle, FileIdentity), Refusal> {
    let handle = sysfile::open_relative(parent, name, target.open())
        .map_err(|error| refuse_open(error, missing))?;
    let identity = check_opened(&handle, name, target)?;
    Ok((handle, identity))
}

/// The W6 rule on what a handle names: not a directory, no reparse point, a
/// disk file, exactly one link.
fn check_regular(handle: &OwnedHandle, identity: &FileIdentity) -> Result<(), Refusal> {
    if identity.reparse_point() {
        return Err(Refusal::path(Reason::ReparsePoint));
    }
    let disk = sysfile::is_disk_file(handle).map_err(io)?;
    if identity.directory() || !disk || identity.info.links != 1 {
        return Err(Refusal::path(Reason::NotRegular));
    }
    Ok(())
}

/// Reads an open file's identity and applies W6 to it.
pub fn read_regular(handle: &OwnedHandle) -> Result<FileIdentity, Refusal> {
    let identity = FileIdentity::read(handle)?;
    check_regular(handle, &identity)?;
    Ok(identity)
}

/// Opens a regular file below `parent` (W6). A missing leaf is `not_found`.
pub fn open_regular(
    parent: &OwnedHandle,
    name: &[u16],
    target: Target,
) -> Result<(OwnedHandle, FileIdentity), Refusal> {
    let (handle, identity) = open_child(parent, name, target, Refusal::of(Status::NotFound))?;
    check_regular(&handle, &identity)?;
    Ok((handle, identity))
}

/// The pinned directory itself, as a handle of its own: a listing never
/// enumerates on a duplicate of the pin, whose position every duplicate shares.
pub fn reopen_directory(directory: &OwnedHandle) -> Result<OwnedHandle, Refusal> {
    sysfile::open_relative(directory, &[], Target::Directory.open()).map_err(io)
}

/// Walks `segments` as directories from `root`, one handle at a time; each
/// parent is closed once its child is open. No segment names the root itself.
pub fn walk(root: OwnedHandle, segments: &[&[u16]]) -> Result<OwnedHandle, Refusal> {
    let missing = Refusal::path(Reason::MissingDirectory);
    let mut current = root;
    for segment in segments {
        current = open_child(&current, segment, Target::Directory, missing)?.0;
    }
    Ok(current)
}

/// The creating walk (the write's step 1): as `walk`, but a missing directory
/// is made (mkdir, W8: `FILE_CREATE` with the directory option, inheriting
/// the parent's access list) and then checked like any other. A name someone
/// else creates in between is opened instead.
pub fn walk_creating(root: OwnedHandle, segments: &[&[u16]]) -> Result<OwnedHandle, Refusal> {
    let mut current = root;
    for segment in segments {
        current = open_or_create(&current, segment)?;
    }
    Ok(current)
}

fn open_or_create(parent: &OwnedHandle, name: &[u16]) -> Result<OwnedHandle, Refusal> {
    let open = || sysfile::open_relative(parent, name, Target::Directory.open());
    let opened = match open() {
        Err(SysError(code)) if code as i32 == STATUS_OBJECT_NAME_NOT_FOUND => {
            let create = Open {
                disposition: FILE_CREATE,
                ..Target::Directory.open()
            };
            match sysfile::open_relative(parent, name, create) {
                Err(SysError(code)) if code as i32 == STATUS_OBJECT_NAME_COLLISION => open(),
                created => created,
            }
        }
        other => other,
    };
    let missing = Refusal::path(Reason::MissingDirectory);
    let handle = opened.map_err(|error| refuse_open(error, missing))?;
    check_opened(&handle, name, Target::Directory)?;
    Ok(handle)
}

/// Splits a segment list into its parents and its leaf. An empty list names
/// the root, which only a listing accepts.
pub fn split_leaf(list: &[u16]) -> Result<(Vec<&[u16]>, &[u16]), Refusal> {
    let mut segments = split_segments(list).map_err(|error| error.refusal())?;
    let leaf = segments.pop().ok_or(Refusal::of(Status::InvalidArgument))?;
    Ok((segments, leaf))
}

/// Whose the original handle of an open file is.
#[derive(Debug, Default)]
enum Original {
    /// The library's, until `jfa_file_take`.
    Held(OwnedHandle),
    /// The caller's. Closed by the library only on `reclaim`.
    Taken(TakenHandle),
    /// Only while a take swaps the value.
    #[default]
    Moving,
}

/// A regular file opened for reading: the original handle, and a duplicate
/// of it that names the same open file for the re-check after the read.
pub struct OpenFile {
    original: Cell<Original>,
    duplicate: OwnedHandle,
}

/// The open files the exports hand out.
pub static FILES: Table<OpenFile> = Table::new(Kind::File, FILE_TABLE_ENTRIES);

/// Walks to the leaf's parent and opens the leaf as a regular file.
fn open_file(root: OwnedHandle, list: &[u16]) -> Result<OpenFile, Refusal> {
    let (parents, leaf) = split_leaf(list)?;
    let parent = walk(root, &parents)?;
    let (handle, _) = open_regular(&parent, leaf, Target::ReadFile)?;
    let duplicate = handle.duplicate().map_err(io)?;
    Ok(OpenFile {
        original: Cell::new(Original::Held(handle)),
        duplicate,
    })
}

/// `jfa_open_file`: opens a regular file below a pin and stores it.
pub fn file_open(
    pins: &Table<RootPin>,
    files: &Table<OpenFile>,
    pin: u64,
    list: &[u16],
) -> Result<u64, Refusal> {
    // A full table is refused before the walk, not after it.
    if !files.has_room().map_err(TableError::refusal)? {
        return Err(TableError::Full.refusal());
    }
    let (root, _) = pinned_handle(pins, pin)?;
    let file = open_file(root, list)?;
    files.insert(file).map_err(TableError::refusal)
}

/// `jfa_file_take`: hands the original handle out, once.
pub fn file_take(files: &Table<OpenFile>, token: u64) -> Result<usize, Refusal> {
    let taken = files.with(token, |file| match file.original.take() {
        Original::Held(handle) => {
            let taken = handle.release();
            let value = taken.value();
            file.original.set(Original::Taken(taken));
            Ok(value)
        }
        other => {
            file.original.set(other);
            Err(Refusal::of(Status::InvalidArgument))
        }
    });
    taken.map_err(TableError::refusal)?
}

/// `jfa_file_check`: the W6 rule again, on a copy of the library's duplicate.
pub fn file_check(files: &Table<OpenFile>, token: u64) -> Result<(), Refusal> {
    let copy = files
        .with(token, |file| file.duplicate.duplicate())
        .map_err(TableError::refusal)?
        .map_err(io)?;
    read_regular(&copy).map(drop)
}

/// `jfa_file_close`: frees the token and closes the duplicate. The original
/// is closed too if it was never taken; a taken one only when `reclaim`.
pub fn file_close(files: &Table<OpenFile>, token: u64, reclaim: bool) -> Result<(), Refusal> {
    let file = files.remove(token).map_err(TableError::refusal)?;
    match file.original.into_inner() {
        Original::Taken(taken) if reclaim => taken.reclaim(),
        // A held handle closes as it drops; a taken one is the caller's and
        // dropping its record closes nothing.
        Original::Held(_) | Original::Taken(_) | Original::Moving => {}
    }
    Ok(())
}
