//! Every constant of the crate against `abi.json`, on any system: the status
//! and reason numbers, the flags, the limits, the listing record, and the
//! export names, order and argument lists.

mod common;

use std::collections::BTreeSet;

use jenny_file_access::abi::{self, DetailOut, Reason, Status};
use serde_json::Value;

fn load() -> Value {
    common::read_json(common::ABI)
}

fn named(list: &Value, key: &str) -> Vec<(String, u64)> {
    list.as_array()
        .expect("a list")
        .iter()
        .map(|entry| {
            let name = entry["name"].as_str().expect("name").to_owned();
            (name, entry[key].as_u64().expect("a number"))
        })
        .collect()
}

fn owned(pairs: &[(&str, u32)]) -> Vec<(String, u64)> {
    pairs
        .iter()
        .map(|&(name, value)| (name.to_owned(), u64::from(value)))
        .collect()
}

fn bit_values(list: &Value) -> Vec<(String, u64)> {
    named(list, "bit")
        .into_iter()
        .map(|(name, bit)| (name, 1 << bit))
        .collect()
}

#[test]
fn the_version_and_the_status_numbers_match() {
    let file = load();
    assert_eq!(
        file["abi_version"].as_u64(),
        Some(u64::from(abi::ABI_VERSION))
    );
    assert_eq!(jenny_file_access::jfa_abi_version(), abi::ABI_VERSION);

    let listed: Vec<(String, i64, bool)> = file["status"]
        .as_array()
        .expect("status")
        .iter()
        .map(|entry| {
            (
                entry["name"].as_str().expect("name").to_owned(),
                entry["value"].as_i64().expect("value"),
                entry["root_open_only"].as_bool().unwrap_or(false),
            )
        })
        .collect();
    let built: Vec<(String, i64, bool)> = Status::ALL
        .iter()
        .map(|&(name, status)| {
            (
                name.to_owned(),
                i64::from(status.code()),
                status.root_open_only(),
            )
        })
        .collect();
    assert_eq!(listed, built);
    let distinct: BTreeSet<i32> = Status::ALL
        .iter()
        .map(|&(_, status)| status.code())
        .collect();
    assert_eq!(
        distinct.len(),
        Status::ALL.len(),
        "status numbers are unique"
    );
}

#[test]
fn the_detail_reasons_match() {
    let file = load();
    let built: Vec<(String, u64)> = Reason::ALL
        .iter()
        .map(|&(name, reason)| (name.to_owned(), u64::from(reason.code())))
        .collect();
    assert_eq!(named(&file["detail"]["reasons"], "value"), built);
    assert_eq!(size_of::<DetailOut>(), 8, "two u32 values");
    assert_eq!(align_of::<DetailOut>(), 4);
    let detail = abi::Refusal::path(Reason::TooDeep).detail();
    assert_eq!((detail.reason, detail.system), (6, 0));
    let detail = abi::Refusal::system(Status::IoFailed, 5).detail();
    assert_eq!(
        (detail.reason, detail.system),
        (0, 5),
        "a reason only beside path_refused"
    );
}

#[test]
fn the_flags_kinds_and_limits_match() {
    let file = load();
    assert_eq!(bit_values(&file["build_flags"]), owned(&abi::BUILD_FLAGS));
    let expected_flags = if cfg!(feature = "test-seams") {
        abi::BUILD_FLAG_TEST_SEAMS
    } else {
        0
    };
    assert_eq!(abi::build_flags(), expected_flags);
    assert_eq!(jenny_file_access::jfa_build_flags(), expected_flags);

    assert_eq!(
        named(&file["expectation_kinds"], "value"),
        owned(&abi::EXPECTATION_KINDS)
    );
    assert_eq!(
        named(&file["write_outcomes"], "value"),
        owned(&abi::WRITE_OUTCOMES)
    );

    let limits = &file["limits"];
    assert_eq!(
        limits["pin_table_entries"].as_u64(),
        Some(abi::PIN_TABLE_ENTRIES as u64)
    );
    assert_eq!(
        limits["file_table_entries"].as_u64(),
        Some(abi::FILE_TABLE_ENTRIES as u64)
    );
    assert_eq!(
        limits["max_write_bytes"].as_u64(),
        Some(abi::MAX_WRITE_BYTES as u64)
    );
    assert_eq!(
        limits["max_listing_buffer_bytes"].as_u64(),
        Some(abi::MAX_LISTING_BUFFER_BYTES as u64)
    );
    assert_eq!(
        limits.as_object().expect("limits").len(),
        4,
        "a limit this test does not know"
    );

    let segments = &file["segments"];
    assert_eq!(
        segments["terminator"].as_u64(),
        Some(u64::from(abi::SEGMENT_TERMINATOR))
    );
    assert_eq!(
        segments["max_segment_units"].as_u64(),
        Some(abi::MAX_SEGMENT_UNITS as u64)
    );
    assert_eq!(segments["max_depth"].as_u64(), Some(abi::MAX_DEPTH as u64));
}

#[test]
fn the_listing_record_matches() {
    let file = load();
    let record = &file["listing_record"];
    let fields = record["fields"].as_array().expect("fields");
    let (fixed, name) = fields.split_at(abi::LISTING_FIELDS.len());
    let listed: Vec<(String, u64)> = fixed
        .iter()
        .map(|field| {
            (
                field["name"].as_str().expect("name").to_owned(),
                field["bytes"].as_u64().expect("bytes"),
            )
        })
        .collect();
    let built: Vec<(String, u64)> = abi::LISTING_FIELDS
        .iter()
        .map(|&(name, bytes)| (name.to_owned(), bytes as u64))
        .collect();
    assert_eq!(listed, built);
    assert_eq!(name.len(), 1, "the name follows the fixed fields");
    assert_eq!(name[0]["name"].as_str(), Some("name"));
    assert_eq!(name[0]["kind"].as_str(), Some("utf16le"));
    let header: usize = abi::LISTING_FIELDS.iter().map(|&(_, bytes)| bytes).sum();
    assert_eq!(header, abi::LISTING_HEADER_BYTES);
    assert_eq!(
        record["fixed_header_bytes"].as_u64(),
        Some(abi::LISTING_HEADER_BYTES as u64)
    );
    assert_eq!(bit_values(&record["flags"]), owned(&abi::LISTING_FLAGS));
}

/// The Rust type of one argument kind of `abi.json`.
macro_rules! kind_type {
    (u32) => { u32 };
    (u64) => { u64 };
    (usize) => { usize };
    (ptr_utf16) => { *const u16 };
    (ptr_bytes) => { *const u8 };
    (ptr_bytes_mut) => { *mut u8 };
    (out_u32) => { *mut u32 };
    (out_u64) => { *mut u64 };
    (out_handle) => { *mut usize };
    (out_detail) => { *mut DetailOut };
    (status) => { i32 };
}

/// One export: the compiler checks the real function against the kinds, and
/// the same kinds come back as text to compare with the file.
macro_rules! signature {
    ($name:ident($($kind:ident),*) -> $returns:ident) => {{
        let _checked: unsafe extern "C" fn($(kind_type!($kind)),*) -> kind_type!($returns) =
            jenny_file_access::$name;
        let kinds: Vec<&str> = vec![$(stringify!($kind)),*];
        (stringify!($name), kinds, stringify!($returns))
    }};
}

#[test]
fn the_exports_match_in_name_order_and_argument_kinds() {
    let file = load();
    #[allow(unused_mut)]
    let mut built = vec![
        signature!(jfa_abi_version() -> u32),
        signature!(jfa_build_flags() -> u32),
        signature!(jfa_root_open(ptr_utf16, u32, u64, u64, out_u64, out_detail) -> status),
        signature!(jfa_pin_identity(u64, out_u64, out_u64) -> status),
        signature!(jfa_pin_close(u64) -> status),
        signature!(jfa_open_file(u64, ptr_utf16, u32, out_u64, out_detail) -> status),
        signature!(jfa_file_take(u64, out_handle) -> status),
        signature!(jfa_file_check(u64) -> status),
        signature!(jfa_file_close(u64, u32) -> status),
        signature!(
            jfa_list(u64, ptr_utf16, u32, u32, ptr_bytes_mut, u32, out_u32, out_u32, out_detail)
                -> status
        ),
        signature!(
            jfa_write_atomic(
                u64, ptr_utf16, u32, ptr_bytes, usize, u32, ptr_bytes, usize, out_u32, out_detail
            ) -> status
        ),
    ];
    #[cfg(feature = "test-seams")]
    built.push(signature!(jfa_test_set_token_state(u32) -> status));

    let exports = file["exports"].as_array().expect("exports");
    assert_eq!(exports.len(), 12, "an export this test does not know");

    let seams_only: Vec<&str> = exports
        .iter()
        .filter(|export| export["test_seams_only"].as_bool().unwrap_or(false))
        .map(|export| export["name"].as_str().expect("name"))
        .collect();
    assert_eq!(seams_only, [abi::TEST_SEAMS_ONLY_EXPORT]);

    let listed: Vec<(&str, Vec<&str>, &str)> = exports
        .iter()
        .filter(|export| {
            cfg!(feature = "test-seams") || !export["test_seams_only"].as_bool().unwrap_or(false)
        })
        .map(|export| {
            let kinds = export["args"]
                .as_array()
                .expect("args")
                .iter()
                .map(|argument| argument["kind"].as_str().expect("kind"))
                .collect();
            (
                export["name"].as_str().expect("name"),
                kinds,
                export["returns"].as_str().expect("returns"),
            )
        })
        .collect();
    assert_eq!(listed, built);
}

/// No export takes a raw handle value, so a value equal to the pinned root's
/// handle cannot be passed at all. One handle leaves, through `jfa_file_take`.
#[test]
fn no_argument_kind_takes_a_raw_handle() {
    let file = load();
    let kinds = file["argument_kinds"].as_object().expect("argument_kinds");
    let handle_kinds: Vec<&String> = kinds
        .keys()
        .filter(|kind| kind.contains("handle"))
        .collect();
    assert_eq!(handle_kinds, ["out_handle"]);
    for export in file["exports"].as_array().expect("exports") {
        let name = export["name"].as_str().expect("name");
        for argument in export["args"].as_array().expect("args") {
            let kind = argument["kind"].as_str().expect("kind");
            assert!(kinds.contains_key(kind), "{name}: unknown kind {kind}");
            if kind == "out_handle" {
                assert_eq!(name, "jfa_file_take");
            }
        }
    }
}
