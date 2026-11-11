//! The preamble codec against the vectors shared with the JavaScript codec.

use jenny_team_bridge::preamble::{decode_host, encode_host, encode_member, verify_member};
use serde_json::Value;

const VECTORS: &str = include_str!("../../../tests/fixtures/team-preamble-vectors.json");

fn hex(text: &str) -> Vec<u8> {
    assert!(
        text.len().is_multiple_of(2),
        "odd hex length in the fixture"
    );
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex in the fixture"))
        .collect()
}

fn hex32(text: &str) -> [u8; 32] {
    hex(text).try_into().expect("32 bytes in the fixture")
}

fn entries(name: &str) -> Vec<Value> {
    let root: Value = serde_json::from_str(VECTORS).expect("fixture parses");
    let list = root[name].as_array().expect("fixture list").clone();
    assert!(!list.is_empty(), "fixture list {name} is empty");
    list
}

fn field<'a>(entry: &'a Value, name: &str) -> &'a str {
    entry[name].as_str().expect("fixture string field")
}

#[test]
fn host_vectors_encode_and_decode() {
    for entry in entries("host") {
        let secret = hex32(field(&entry, "boot_secret"));
        let key = hex32(field(&entry, "remote_key"));
        let expected = hex(field(&entry, "preamble"));
        let encoded = encode_host(&secret, &key);
        assert_eq!(&encoded[..], &expected[..], "{}", field(&entry, "name"));
        let decoded = decode_host(&expected).expect("valid host preamble decodes");
        assert_eq!(*decoded.secret, secret);
        assert_eq!(decoded.remote_key, key);
    }
}

#[test]
fn host_invalid_vectors_fail_to_decode() {
    for entry in entries("host_invalid") {
        let bytes = hex(field(&entry, "bytes"));
        assert!(decode_host(&bytes).is_none(), "{}", field(&entry, "name"));
    }
}

#[test]
fn member_vectors_encode_and_verify() {
    for entry in entries("member") {
        let secret = hex32(field(&entry, "launch_secret"));
        let expected = hex(field(&entry, "preamble"));
        let encoded = encode_member(&secret);
        assert_eq!(&encoded[..], &expected[..], "{}", field(&entry, "name"));
        assert!(
            verify_member(&expected, &secret),
            "{}",
            field(&entry, "name")
        );
    }
}

#[test]
fn member_invalid_vectors_fail_verification() {
    for entry in entries("member_invalid") {
        let secret = hex32(field(&entry, "launch_secret"));
        let bytes = hex(field(&entry, "bytes"));
        assert!(!verify_member(&bytes, &secret), "{}", field(&entry, "name"));
    }
}
