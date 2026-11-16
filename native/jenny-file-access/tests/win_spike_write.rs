//! Slice 3b-3's facts about renaming and deleting by handle, kept as tests.
//! They call the system directly, not through the library. What was found is
//! in the spec, "3b-2b and 3b-3 as built"
//! (`docs/plans/TEAM_WINDOWS_FILE_ACCESS_SPEC.md`).
#![cfg(windows)]

mod common;

use std::fs::{self, File, OpenOptions};
use std::mem::offset_of;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use common::{note, units_of, TempDir};
use windows_sys::Wdk::Storage::FileSystem::{
    FileRenameInformation, FileRenameInformationEx, NtSetInformationFile,
};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfoEx, FileRenameInfo, FileRenameInfoEx, SetFileInformationByHandle, DELETE,
    FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_WRITE, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
    FILE_RENAME_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
    SYNCHRONIZE,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

const REPLACE: u32 = 0x1;
const POSIX: u32 = 0x2;

/// A directory handle as the walk holds one: no delete sharing.
fn directory(path: &Path) -> File {
    OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .expect("the directory opens")
}

/// A new file as the temp is made: write and delete access, shared for read only.
fn temp_file(path: &Path, content: &[u8]) -> File {
    fs::write(path, content).expect("the file is written");
    OpenOptions::new()
        .access_mode(FILE_GENERIC_WRITE | DELETE)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .expect("the file opens")
}

#[derive(Clone, Copy, Debug)]
enum Via {
    /// `SetFileInformationByHandle` with `FileRenameInfoEx` or `FileRenameInfo`.
    Kernel32 { extended: bool },
    /// `NtSetInformationFile` with `FileRenameInformationEx` or `FileRenameInformation`.
    Nt { extended: bool },
}

/// Renames `file` to `name` inside `root` by handle. `Err` is the Win32 error
/// for kernel32 and the NTSTATUS for ntdll.
fn rename(file: &File, root: &File, name: &str, via: Via, flags: u32) -> Result<(), u32> {
    let units = units_of(name);
    // kernel32 refuses less than the structure's size plus the name's bytes.
    let bytes = size_of::<FILE_RENAME_INFO>() + units.len() * 2;
    let mut words = vec![0u64; bytes.div_ceil(8)];
    let base = words.as_mut_ptr().cast::<u8>();
    let extended = matches!(
        via,
        Via::Kernel32 { extended: true } | Via::Nt { extended: true }
    );
    // SAFETY: the buffer is 8-byte aligned and holds `bytes` bytes: the
    // structure's fixed part, the name and a terminator.
    unsafe {
        let info = base.cast::<FILE_RENAME_INFO>();
        if extended {
            (*info).Anonymous.Flags = flags;
        } else {
            (*info).Anonymous.ReplaceIfExists = flags & REPLACE != 0;
        }
        (*info).RootDirectory = root.as_raw_handle() as HANDLE;
        (*info).FileNameLength = u32::try_from(units.len() * 2).expect("short");
        let name_at = base
            .add(offset_of!(FILE_RENAME_INFO, FileName))
            .cast::<u16>();
        std::ptr::copy_nonoverlapping(units.as_ptr(), name_at, units.len());
    }
    let handle = file.as_raw_handle() as HANDLE;
    let length = u32::try_from(bytes).expect("short");
    match via {
        Via::Kernel32 { extended } => {
            let class = if extended {
                FileRenameInfoEx
            } else {
                FileRenameInfo
            };
            // SAFETY: both handles are open and the buffer is valid for `length` bytes.
            let ok = unsafe { SetFileInformationByHandle(handle, class, base.cast(), length) };
            if ok == 0 {
                let error = std::io::Error::last_os_error().raw_os_error();
                return Err(error.map_or(u32::MAX, |code| code as u32));
            }
        }
        Via::Nt { extended } => {
            let class = if extended {
                FileRenameInformationEx
            } else {
                FileRenameInformation
            };
            let mut io = IO_STATUS_BLOCK::default();
            // SAFETY: both handles are open, `io` is a local and the buffer is
            // valid for `length` bytes.
            let status =
                unsafe { NtSetInformationFile(handle, &mut io, base.cast(), length, class) };
            if status != 0 {
                return Err(status as u32);
            }
        }
    }
    Ok(())
}

const NT_EX: Via = Via::Nt { extended: true };

#[test]
fn fact_8_only_ntdll_renames_into_a_directory_handle() {
    let temp = TempDir::new("spike8");
    let parent = temp.dir("parent");
    let elsewhere = temp.dir("elsewhere");
    fs::write(parent.join("target.txt"), b"old").expect("a target");
    let root = directory(&parent);
    let both = REPLACE | POSIX;

    // kernel32 refuses a rename that names a root directory, in both classes.
    let file = temp_file(&elsewhere.join("a.tmp"), b"new");
    for extended in [true, false] {
        let via = Via::Kernel32 { extended };
        assert_eq!(rename(&file, &root, "t.txt", via, both), Err(87), "{via:?}");
    }
    // ntdll takes it, and replaces an existing name, with either class.
    assert_eq!(rename(&file, &root, "target.txt", NT_EX, both), Ok(()));
    drop(file);
    assert_eq!(
        fs::read(parent.join("target.txt")).expect("replaced"),
        b"new"
    );
    assert!(!elsewhere.join("a.tmp").exists(), "it moved");
    let file = temp_file(&elsewhere.join("b.tmp"), b"newer");
    let plain = Via::Nt { extended: false };
    assert_eq!(rename(&file, &root, "target.txt", plain, both), Ok(()));
    drop(file);
    assert_eq!(
        fs::read(parent.join("target.txt")).expect("replaced"),
        b"newer"
    );

    // Without the replace flag an existing name is a collision.
    let file = temp_file(&elsewhere.join("c.tmp"), b"c");
    let collision = rename(&file, &root, "target.txt", NT_EX, POSIX);
    assert_eq!(collision, Err(0xC000_0035), "STATUS_OBJECT_NAME_COLLISION");
    note(
        "SPIKE",
        "fact 8",
        "SetFileInformationByHandle refuses a rename with RootDirectory (87, both classes); \
         NtSetInformationFile takes it with FileRenameInformationEx and FileRenameInformation; \
         no replace flag gives STATUS_OBJECT_NAME_COLLISION",
    );
}

#[test]
fn fact_9_a_held_or_read_only_target_refuses_the_replacement() {
    let temp = TempDir::new("spike9");
    let parent = temp.dir("parent");
    let root = directory(&parent);
    let both = REPLACE | POSIX;
    let target = parent.join("target.txt");
    fs::write(&target, b"old").expect("a target");

    // Held open without delete sharing.
    let holder = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&target)
        .expect("held");
    let file = temp_file(&parent.join("a.tmp"), b"new");
    let held = rename(&file, &root, "target.txt", NT_EX, both);
    let held_plain = rename(
        &file,
        &root,
        "target.txt",
        Via::Nt { extended: false },
        both,
    );
    drop(holder);
    // Held with delete sharing: POSIX semantics replace it anyway.
    let sharing = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(&target)
        .expect("held, sharing delete");
    assert_eq!(rename(&file, &root, "target.txt", NT_EX, both), Ok(()));
    drop((sharing, file));
    assert_eq!(fs::read(&target).expect("replaced"), b"new");

    // Read only.
    let mut permissions = fs::metadata(&target).expect("metadata").permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&target, permissions.clone()).expect("read only");
    let file = temp_file(&parent.join("b.tmp"), b"newer");
    let read_only = rename(&file, &root, "target.txt", NT_EX, both);
    assert_eq!(fs::read(&target).expect("unchanged"), b"new");
    #[allow(clippy::permissions_set_readonly_false)] // Lets the temp directory go.
    permissions.set_readonly(false);
    fs::set_permissions(&target, permissions).expect("writable again");
    note(
        "SPIKE",
        "fact 9",
        &format!(
            "a target held without delete sharing: extended {held:x?}, plain {held_plain:x?}; \
             held with delete sharing: replaced; read only: {read_only:x?}"
        ),
    );
    // POSIX semantics turn a held target into a sharing violation, which the
    // write retries; the older class says access denied.
    assert_eq!(held, Err(0xC000_0043), "STATUS_SHARING_VIOLATION");
    assert_eq!(held_plain, Err(0xC000_0022), "STATUS_ACCESS_DENIED");
    assert_eq!(read_only, Err(0xC000_0022), "STATUS_ACCESS_DENIED");
}

#[test]
fn fact_10_a_delete_by_handle_removes_the_name_when_the_handle_closes() {
    let temp = TempDir::new("spike10");
    let path = temp.path().join("x.tmp");
    let file = temp_file(&path, b"x");
    let mut info = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    // SAFETY: the handle is open with delete access; `info` is a local of the
    // class's type and its exact size is passed.
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as HANDLE,
            FileDispositionInfoEx,
            std::ptr::from_mut(&mut info).cast(),
            u32::try_from(size_of::<FILE_DISPOSITION_INFO_EX>()).expect("small"),
        )
    };
    assert_ne!(ok, 0, "{}", std::io::Error::last_os_error());
    // The name stays, delete pending, until this handle closes.
    assert!(
        File::open(&path).is_err(),
        "a pending delete opens for nobody"
    );
    drop(file);
    assert!(fs::read_dir(temp.path()).expect("lists").next().is_none());
}
