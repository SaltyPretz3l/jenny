//! The export table of the library cargo just built, read from the file
//! itself, against `abi.json`: every production export is there, nothing else
//! is, and `jfa_test_set_token_state` exists only in the test-seams build.
//!
//! The file is parsed here, so the check needs no tool beyond cargo. It runs
//! in both builds: `cargo test` and `cargo test --features test-seams`.

mod common;

use std::collections::BTreeSet;
use std::path::PathBuf;

/// The names the file's export table must hold in this build.
fn expected_exports() -> BTreeSet<String> {
    let file = common::read_json(common::ABI);
    file["exports"]
        .as_array()
        .expect("exports")
        .iter()
        .filter(|export| {
            cfg!(feature = "test-seams") || !export["test_seams_only"].as_bool().unwrap_or(false)
        })
        .map(|export| export["name"].as_str().expect("name").to_owned())
        .collect()
}

/// The library cargo built beside this test's own executable.
fn built_library(name: &str) -> PathBuf {
    let test = std::env::current_exe().expect("the test's own path");
    let deps = test.parent().expect("the deps directory");
    let beside = deps.join(name);
    if beside.is_file() {
        return beside;
    }
    deps.parent().expect("the profile directory").join(name)
}

fn u16_at(bytes: &[u8], offset: usize) -> usize {
    usize::from(u16::from_le_bytes(
        bytes[offset..offset + 2].try_into().expect("two bytes"),
    ))
}

fn u32_at(bytes: &[u8], offset: usize) -> usize {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("four bytes")) as usize
}

/// The names in a PE image's export directory.
fn pe_export_names(image: &[u8]) -> BTreeSet<String> {
    let pe = u32_at(image, 0x3C);
    assert_eq!(&image[pe..pe + 4], b"PE\0\0", "a PE image");
    let sections = u16_at(image, pe + 6);
    let optional = pe + 24;
    let optional_size = u16_at(image, pe + 20);
    // The data directories follow the fixed part of the optional header.
    let directories = match u16_at(image, optional) {
        0x20B => optional + 112,
        0x10B => optional + 96,
        magic => panic!("an unknown optional header {magic:#x}"),
    };
    let export_rva = u32_at(image, directories);
    assert_ne!(export_rva, 0, "the library has an export directory");

    let section_table = optional + optional_size;
    let offset_of = |rva: usize| -> usize {
        for index in 0..sections {
            let header = section_table + 40 * index;
            let (size, address) = (u32_at(image, header + 8), u32_at(image, header + 12));
            let (raw_size, raw) = (u32_at(image, header + 16), u32_at(image, header + 20));
            if rva >= address && rva < address + size.max(raw_size) {
                return rva - address + raw;
            }
        }
        panic!("RVA {rva:#x} is in no section");
    };

    let directory = offset_of(export_rva);
    let count = u32_at(image, directory + 24);
    let names = offset_of(u32_at(image, directory + 32));
    (0..count)
        .map(|index| {
            let start = offset_of(u32_at(image, names + 4 * index));
            let length = image[start..]
                .iter()
                .position(|&byte| byte == 0)
                .expect("a terminator");
            String::from_utf8(image[start..start + length].to_vec()).expect("an ASCII name")
        })
        .collect()
}

#[cfg(windows)]
#[test]
fn the_built_library_exports_exactly_the_interface() {
    let path = built_library("jenny_file_access.dll");
    let image = std::fs::read(&path).expect("cargo built the library beside the tests");
    let exported = pe_export_names(&image);
    assert_eq!(
        exported,
        expected_exports(),
        "the export table of the built library"
    );
    let seam = jenny_file_access::abi::TEST_SEAMS_ONLY_EXPORT;
    assert_eq!(
        exported.contains(seam),
        cfg!(feature = "test-seams"),
        "{seam}"
    );
    let flags = jenny_file_access::jfa_build_flags();
    assert_eq!(
        flags,
        u32::from(cfg!(feature = "test-seams")),
        "bit 0 marks the test-seams build"
    );
}

/// Only a PE image is parsed here. On other systems the stub's symbols are
/// checked by the compiler in `tests/abi.rs`, not in the built file.
#[cfg(not(windows))]
#[test]
fn the_built_library_exports_exactly_the_interface() {
    let _ = (
        expected_exports(),
        built_library("unused"),
        pe_export_names as fn(&[u8]) -> _,
    );
    common::skipped(
        "the_built_library_exports_exactly_the_interface",
        "the export table is read from a PE image; this system builds another format",
    );
}

#[cfg(windows)]
#[test]
fn the_parser_reads_a_system_library() {
    // A second image whose exports are known: kernel32 exports CreateFileW.
    let system = std::env::var_os("SystemRoot").expect("SystemRoot is set on Windows");
    let path = PathBuf::from(system).join(r"System32\kernel32.dll");
    let image = std::fs::read(path).expect("kernel32.dll is readable");
    let exported = pe_export_names(&image);
    assert!(exported.contains("CreateFileW") && exported.contains("CloseHandle"));
    assert!(!exported.contains("jfa_abi_version"));
}
