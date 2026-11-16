//! Slice 3b-2b's spike fact 6, kept as a test: what a relative `NtCreateFile`
//! answers. It calls the system directly, not through the library. Facts 5
//! (the directory class) and 7 (the change time) were dropped: the listing
//! tests and the write's rewrite test cover them. What was found is in the
//! spec, "3b-2b and 3b-3 as built" (`docs/plans/TEAM_WINDOWS_FILE_ACCESS_SPEC.md`).
#![cfg(windows)]

mod common;

use std::fs::{self, File};
use std::mem::offset_of;
use std::os::windows::io::AsRawHandle;

use common::{note, nt_open, open_directory, TempDir, WALK_ATTRIBUTES};
use windows_sys::Wdk::Storage::FileSystem::{
    FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
};
use windows_sys::Win32::Foundation::{
    HANDLE, STATUS_FILE_IS_A_DIRECTORY, STATUS_NOT_A_DIRECTORY, STATUS_OBJECT_NAME_COLLISION,
    STATUS_OBJECT_NAME_INVALID, STATUS_OBJECT_NAME_NOT_FOUND,
};
use windows_sys::Win32::Storage::FileSystem::{
    FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx, FILE_ID_BOTH_DIR_INFO,
    FILE_LIST_DIRECTORY, FILE_READ_DATA,
};

/// Every entry of one `FileIdBothDirectory*` buffer, sorted by name:
/// attributes, size and name. `None` at the end of the directory.
fn directory_entries(directory: &File, class: i32) -> Option<Vec<(u32, i64, String)>> {
    let mut buffer = vec![0u64; 2048];
    // SAFETY: the handle is open; the buffer is 8-byte aligned and its exact
    // size in bytes is passed.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            directory.as_raw_handle() as HANDLE,
            class,
            buffer.as_mut_ptr().cast(),
            u32::try_from(buffer.len() * 8).expect("a small buffer"),
        )
    };
    if ok == 0 {
        let error = std::io::Error::last_os_error().raw_os_error();
        assert_eq!(error, Some(18), "ERROR_NO_MORE_FILES");
        return None;
    }
    let bytes: Vec<u8> = buffer.iter().flat_map(|word| word.to_le_bytes()).collect();
    let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().expect("u32"));
    let (mut at, mut entries) = (0usize, Vec::new());
    loop {
        let attributes = u32_at(at + offset_of!(FILE_ID_BOTH_DIR_INFO, FileAttributes));
        let size_at = at + offset_of!(FILE_ID_BOTH_DIR_INFO, EndOfFile);
        let size = i64::from_le_bytes(bytes[size_at..size_at + 8].try_into().expect("i64"));
        let length = u32_at(at + offset_of!(FILE_ID_BOTH_DIR_INFO, FileNameLength)) as usize;
        let name_at = at + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
        let name: Vec<u16> = bytes[name_at..name_at + length]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&pair| u16::from_le_bytes(pair))
            .collect();
        entries.push((attributes, size, String::from_utf16_lossy(&name)));
        let next = u32_at(at) as usize;
        if next == 0 {
            entries.sort_by(|left, right| left.2.cmp(&right.2));
            return Some(entries);
        }
        at += next;
    }
}

#[test]
fn fact_6_nt_create_file_answers_with_the_ntstatus_h_values() {
    let temp = TempDir::new("spike6");
    fs::write(temp.path().join("file.txt"), b"x").expect("a file");
    temp.dir("sub");
    let parent = open_directory(temp.path(), false, 0);
    let (list, read, dir, file) = (
        FILE_LIST_DIRECTORY,
        FILE_READ_DATA,
        FILE_DIRECTORY_FILE,
        FILE_NON_DIRECTORY_FILE,
    );
    // Each status against its ntstatus.h value written out, and against windows-sys.
    let cases: [(&str, u32, u32, u32, i32, u32); 5] = [
        (
            "missing",
            read,
            FILE_OPEN,
            0,
            STATUS_OBJECT_NAME_NOT_FOUND,
            0xC000_0034,
        ),
        (
            "file.txt",
            list,
            FILE_OPEN,
            dir,
            STATUS_NOT_A_DIRECTORY,
            0xC000_0103,
        ),
        (
            "sub",
            read,
            FILE_OPEN,
            file,
            STATUS_FILE_IS_A_DIRECTORY,
            0xC000_00BA,
        ),
        (
            "file.txt",
            read,
            FILE_CREATE,
            0,
            STATUS_OBJECT_NAME_COLLISION,
            0xC000_0035,
        ),
        (
            "bad*name",
            read,
            FILE_OPEN,
            0,
            STATUS_OBJECT_NAME_INVALID,
            0xC000_0033,
        ),
    ];
    for (name, access, disposition, options, status, literal) in cases {
        assert_eq!(status as u32, literal, "windows-sys agrees for {name}");
        let result =
            nt_open(&parent, name, access, disposition, options, WALK_ATTRIBUTES).map(drop);
        assert_eq!(result, Err(literal), "{name}");
    }
    // An empty name opens the parent again, as a handle of its own: it lists
    // the parent's entries from its own position.
    let again =
        nt_open(&parent, "", list, FILE_OPEN, dir, WALK_ATTRIBUTES).expect("an empty name reopens");
    let entries = directory_entries(&again, FileIdBothDirectoryRestartInfo).expect("entries");
    let names: Vec<&str> = entries.iter().map(|entry| entry.2.as_str()).collect();
    assert_eq!(names, [".", "..", "file.txt", "sub"]);
    note(
        "SPIKE",
        "fact 6",
        "relative NtCreateFile statuses equal ntstatus.h; an empty name reopens the parent",
    );
}
