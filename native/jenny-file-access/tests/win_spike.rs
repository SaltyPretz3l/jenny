//! Four facts about this system that the design rests on, kept as tests.
//! What they are and what was found is in the spec, "3b-2a as built"
//! (`docs/plans/TEAM_WINDOWS_FILE_ACCESS_SPEC.md`).
#![cfg(windows)]

mod common;

use std::fs::{self, File};
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::AsRawHandle;

use common::{
    extended, identity_of, make_junction, note, nt_open, open_directory, rename_is_denied, wide,
    TempDir,
};
use jenny_file_access::win::sys::{self, Module};
use windows_sys::Wdk::Storage::FileSystem::{FILE_DIRECTORY_FILE, FILE_OPEN};
use windows_sys::Win32::Foundation::{HANDLE, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE};
use windows_sys::Win32::Storage::FileSystem::{
    FileIdInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_TRAVERSE,
};

/// ntstatus.h: the open met a reparse point it was told not to follow.
const STATUS_REPARSE_POINT_ENCOUNTERED: u32 = 0xC000_050B;

#[test]
fn fact_1_a_root_opens_by_its_extended_path_and_denies_rename() {
    let temp = TempDir::new("spike1");
    let root = temp.dir("root");
    let handle = sys::open_root_directory(&extended(&root)).expect("the \\\\?\\ open");
    let info = sys::file_information(&handle).expect("attributes by handle");
    assert_ne!(info.attributes & FILE_ATTRIBUTE_DIRECTORY, 0);
    assert_eq!(info.attributes & FILE_ATTRIBUTE_REPARSE_POINT, 0);
    let final_path = sys::final_path(&handle).expect("the final path");
    assert_eq!(
        final_path,
        extended(&root).split_last().expect("a terminator").1
    );
    assert!(
        rename_is_denied(&root, &temp.path().join("moved")),
        "no delete sharing"
    );
    drop(handle);
    fs::rename(&root, temp.path().join("moved")).expect("free after the handle closes");

    // The same open reaches a root far past MAX_PATH.
    let segment = "s".repeat(120);
    let deep = temp.dir(&format!(r"{segment}\{segment}\{segment}"));
    assert!(wide(&deep).len() > 260);
    let handle = sys::open_root_directory(&extended(&deep)).expect("a long \\\\?\\ open");
    assert_eq!(
        sys::final_path(&handle).expect("the final path").len(),
        wide(&deep).len() + 4
    );

    // The wrapper refuses a path that is not terminated exactly once.
    assert!(
        sys::open_root_directory(&wide(&root)).is_err(),
        "no terminator"
    );
    let mut doubled = extended(&deep);
    doubled.push(0);
    assert!(
        sys::open_root_directory(&doubled).is_err(),
        "two terminators"
    );
}

/// One relative open of a directory, as a walk makes it: `RootDirectory` is
/// the parent, the name is one component.
fn open_child(parent: &File, name: &str, attributes: u32) -> Result<File, u32> {
    nt_open(
        parent,
        name,
        FILE_LIST_DIRECTORY | FILE_TRAVERSE,
        FILE_OPEN,
        FILE_DIRECTORY_FILE,
        attributes,
    )
}

fn is_reparse_point(file: &File) -> bool {
    let attributes = file
        .metadata()
        .expect("attributes by handle")
        .file_attributes();
    attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn describe(result: &Result<File, u32>) -> String {
    match result {
        Ok(file) if is_reparse_point(file) => {
            "opens the link itself (reparse attribute set)".into()
        }
        Ok(_) => "opens a plain directory".into(),
        Err(status) => format!("fails with NTSTATUS {status:#010X}"),
    }
}

#[test]
fn fact_2_obj_dont_reparse_composes_with_open_reparse_point() {
    let temp = TempDir::new("spike2");
    temp.dir("plain");
    let target = temp.dir("target");
    fs::write(target.join("secret.txt"), b"outside").expect("a file behind the link");
    make_junction(&temp.path().join("link"), &target);
    let parent = open_directory(temp.path(), false, 0);
    let both = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE;

    // An ordinary directory opens with both flags: they compose.
    let plain = open_child(&parent, "plain", both);
    assert!(
        matches!(&plain, Ok(file) if !is_reparse_point(file)),
        "{}",
        describe(&plain)
    );
    // Case-insensitive, as the walk needs.
    assert!(open_child(&parent, "PLAIN", both).is_ok());

    // Without OBJ_DONT_REPARSE, open-reparse-point opens the junction itself.
    let without = open_child(&parent, "link", OBJ_CASE_INSENSITIVE);
    assert!(
        matches!(&without, Ok(file) if is_reparse_point(file)),
        "{}",
        describe(&without)
    );

    // With both, a junction is never traversed: either the open is refused
    // outright, or it yields the link itself, which the attribute check sees.
    let with = open_child(&parent, "link", both);
    match &with {
        Ok(file) => assert!(is_reparse_point(file), "the junction was followed"),
        Err(status) => assert_eq!(
            *status, STATUS_REPARSE_POINT_ENCOUNTERED,
            "an unexpected status"
        ),
    }
    // The one finding no assertion fixes: which of the two outcomes this
    // system gives.
    note("SPIKE", "fact 2", &format!(
        "relative NtCreateFile with FILE_OPEN_REPARSE_POINT: OBJ_DONT_REPARSE on a plain directory \
         {}; on a junction without OBJ_DONT_REPARSE it {}; on a junction with OBJ_DONT_REPARSE it {}",
        describe(&plain), describe(&without), describe(&with)
    ));
}

#[test]
fn fact_3_windows_sys_carries_nt_create_file() {
    // This file calls `windows_sys::Wdk::Storage::FileSystem::NtCreateFile`,
    // so compiling it is the finding. The library's own presence check agrees.
    assert!(sys::procedure_present(Module::Ntdll, c"NtCreateFile"));
    assert!(!sys::procedure_present(
        Module::Ntdll,
        c"NtCreateFileThatDoesNotExist"
    ));
    assert!(
        !sys::procedure_present(Module::Kernel32, c"NtCreateFile"),
        "it lives in ntdll"
    );
}

#[test]
fn fact_4_ids_by_handle_equal_the_ids_std_reports() {
    let temp = TempDir::new("spike4");
    let root = temp.dir("root");
    let handle = sys::open_root_directory(&extended(&root)).expect("the root opens");
    let info = sys::file_information(&handle).expect("ids by handle");
    drop(handle);

    // Stable std gives the attributes but not the ids: `volume_serial_number`
    // and `file_index` of `MetadataExt` need the unstable `windows_by_handle`.
    let directory = open_directory(&root, false, 0);
    let metadata = directory.metadata().expect("std metadata");
    assert_eq!(metadata.file_attributes(), info.attributes);

    // The test's own raw call, through std's handle, agrees with the wrapper.
    let own = identity_of(&root);
    assert_eq!(
        (own.device, own.inode),
        (u64::from(info.volume_serial), info.file_index)
    );

    // The system's other id query: a 64-bit volume serial and a 128-bit id.
    let mut wide_ids = FILE_ID_INFO::default();
    // SAFETY: the handle is open; `wide_ids` is a local of the type the class
    // fills and its exact size is passed.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            directory.as_raw_handle() as HANDLE,
            FileIdInfo,
            std::ptr::from_mut(&mut wide_ids).cast(),
            u32::try_from(size_of::<FILE_ID_INFO>()).expect("a small structure"),
        )
    };
    assert_ne!(ok, 0, "FileIdInfo");
    let id = u128::from_le_bytes(wide_ids.FileId.Identifier);
    assert_eq!(
        id,
        u128::from(info.file_index),
        "on NTFS the 128-bit id is the file index"
    );
    let serial = wide_ids.VolumeSerialNumber;
    assert_eq!(
        serial as u32, info.volume_serial,
        "the low half of the 64-bit serial"
    );

    // Two directories on one volume share the serial and differ in the index.
    let other = identity_of(&temp.dir("other"));
    assert_eq!(other.device, own.device);
    assert_ne!(other.inode, own.inode);
}
