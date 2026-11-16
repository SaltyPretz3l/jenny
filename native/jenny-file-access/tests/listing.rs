//! The listing record encoder, on any system: the byte layout of `abi.json`,
//! the size a too-small buffer reports, and the prefix it keeps.

mod common;

use common::units_of;
use jenny_file_access::abi::{
    LISTING_FLAG_DIRECTORY, LISTING_FLAG_REPARSE_POINT, LISTING_FLAG_SIZE_KNOWN,
    LISTING_HEADER_BYTES,
};
use jenny_file_access::listing::{record_flags, ListingWriter, NameTooLong};

#[test]
fn a_record_is_little_endian_and_unpadded() {
    let mut buffer = [0xEE_u8; 64];
    let mut writer = ListingWriter::new(&mut buffer);
    let flags = record_flags(false, false, true);
    assert_eq!(
        writer.push(flags, 0x0102_0304_0506_0708, &units_of("a\u{e9}")),
        Ok(true)
    );
    assert_eq!(writer.bytes_used(), LISTING_HEADER_BYTES + 4);
    assert_eq!(writer.bytes_needed(), LISTING_HEADER_BYTES + 4);
    assert_eq!(writer.entry_count(), 1);
    assert!(writer.complete());
    let expected: [u8; 18] = [
        4, 0, 0, 0, // flags: size known
        8, 7, 6, 5, 4, 3, 2, 1, // size
        2, 0, // two code units
        0x61, 0, 0xE9, 0, // the name
    ];
    assert_eq!(buffer[..18], expected);
    assert!(
        buffer[18..].iter().all(|&byte| byte == 0xEE),
        "nothing past the record is written"
    );
}

#[test]
fn the_flags_are_the_three_bits_of_the_interface() {
    assert_eq!(record_flags(false, false, false), 0);
    assert_eq!(record_flags(true, false, false), LISTING_FLAG_DIRECTORY);
    assert_eq!(record_flags(false, true, false), LISTING_FLAG_REPARSE_POINT);
    assert_eq!(record_flags(false, false, true), LISTING_FLAG_SIZE_KNOWN);
    assert_eq!(record_flags(true, true, true), 7);
}

#[test]
fn records_follow_each_other_in_push_order() {
    let mut buffer = [0u8; 64];
    let mut writer = ListingWriter::new(&mut buffer);
    assert_eq!(writer.push(1, 0, &units_of("d")), Ok(true));
    assert_eq!(writer.push(4, 5, &units_of("f1")), Ok(true));
    assert_eq!(writer.entry_count(), 2);
    let first = LISTING_HEADER_BYTES + 2;
    assert_eq!(writer.bytes_used(), first + LISTING_HEADER_BYTES + 4);
    assert_eq!(buffer[..4], [1, 0, 0, 0]);
    assert_eq!(buffer[first..first + 4], [4, 0, 0, 0]);
    assert_eq!(buffer[first + 12..first + 14], [2, 0]);
}

#[test]
fn a_small_buffer_keeps_a_prefix_and_reports_the_size_needed() {
    let mut buffer = [0u8; LISTING_HEADER_BYTES + 2 + 5];
    let mut writer = ListingWriter::new(&mut buffer);
    assert_eq!(writer.push(0, 0, &units_of("a")), Ok(true));
    assert_eq!(
        writer.push(0, 0, &units_of("bbbb")),
        Ok(false),
        "does not fit"
    );
    assert_eq!(
        writer.push(0, 0, &units_of("c")),
        Ok(false),
        "nothing after a gap is written"
    );
    assert_eq!(writer.entry_count(), 1);
    assert_eq!(writer.bytes_used(), LISTING_HEADER_BYTES + 2);
    assert_eq!(writer.bytes_needed(), 3 * LISTING_HEADER_BYTES + 2 + 8 + 2);
    assert!(!writer.complete());
    assert!(buffer[LISTING_HEADER_BYTES + 2..]
        .iter()
        .all(|&byte| byte == 0));
}

#[test]
fn an_empty_buffer_only_counts() {
    let mut writer = ListingWriter::new(&mut []);
    assert_eq!(writer.push(0, 0, &units_of("name")), Ok(false));
    assert_eq!((writer.bytes_used(), writer.entry_count()), (0, 0));
    assert_eq!(writer.bytes_needed(), LISTING_HEADER_BYTES + 8);
}

#[test]
fn a_name_the_length_field_cannot_say_is_refused() {
    let mut buffer = [0u8; 16];
    let mut writer = ListingWriter::new(&mut buffer);
    let name = vec![0x78_u16; usize::from(u16::MAX) + 1];
    assert_eq!(writer.push(0, 0, &name), Err(NameTooLong));
    assert_eq!((writer.bytes_needed(), writer.entry_count()), (0, 0));
    assert!(writer.complete());
}
