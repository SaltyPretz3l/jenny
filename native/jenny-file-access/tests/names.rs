//! The segment validator against the shared vectors, on any system.
//!
//! Every vector in the file is one case, and the file may grow but not shrink.

mod common;

use common::{read_json, units_of};
use jenny_file_access::abi::{Reason, Refusal, Status};
use jenny_file_access::names::{split_segments, validate_segment, ListError, NameRule};
use serde_json::Value;

const VECTORS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/win32-segment-name-vectors.json"
);

/// The rules an accepted vector may carry.
const ACCEPT_RULES: [&str; 4] = [
    "plain_name",
    "surrogate_pair",
    "alias_shape",
    "device_lookalike",
];

const REFUSE_RULES: [NameRule; 11] = [
    NameRule::Empty,
    NameRule::Dot,
    NameRule::DotDot,
    NameRule::TooLong,
    NameRule::SeparatorOrColon,
    NameRule::InvalidChar,
    NameRule::ControlChar,
    NameRule::LoneSurrogate,
    NameRule::TrailingDot,
    NameRule::TrailingSpace,
    NameRule::ReservedDevice,
];

fn load() -> Value {
    read_json(VECTORS)
}

#[test]
fn every_name_vector_gets_its_verdict_and_rule() {
    let file = load();
    let vectors = file["vectors"].as_array().expect("vectors");
    assert!(vectors.len() >= 180, "the name vectors shrank");
    for (index, vector) in vectors.iter().enumerate() {
        let units: Vec<u16> = vector["units"]
            .as_array()
            .expect("units")
            .iter()
            .map(|unit| u16::try_from(unit.as_u64().expect("a number")).expect("a code unit"))
            .collect();
        if let Some(name) = vector["name"].as_str() {
            assert_eq!(
                units_of(name),
                units,
                "vector {index}: name and units differ"
            );
        }
        let rule = vector["rule"].as_str().expect("rule");
        let verdict = validate_segment(&units);
        match vector["verdict"].as_str().expect("verdict") {
            "accept" => {
                assert!(
                    ACCEPT_RULES.contains(&rule),
                    "vector {index}: accept rule {rule}"
                );
                assert_eq!(verdict, Ok(()), "vector {index} ({rule}) must be accepted");
            }
            "refuse" => {
                assert_eq!(verdict.map_err(NameRule::name), Err(rule), "vector {index}");
            }
            other => panic!("vector {index}: unknown verdict {other}"),
        }
    }
}

#[test]
fn the_files_rule_list_is_the_rules_the_validator_knows() {
    let file = load();
    let mut listed: Vec<&str> = file["rules"]
        .as_array()
        .expect("rules")
        .iter()
        .map(|r| r.as_str().expect("a rule"))
        .collect();
    let mut known: Vec<&str> = ACCEPT_RULES.to_vec();
    known.extend(REFUSE_RULES.iter().map(|rule| rule.name()));
    listed.sort_unstable();
    known.sort_unstable();
    assert_eq!(listed, known);
}

#[test]
fn every_path_vector_gets_its_verdict_and_rule() {
    let file = load();
    let vectors = file["path_vectors"].as_array().expect("path_vectors");
    assert!(vectors.len() >= 6, "the path vectors shrank");
    for (index, vector) in vectors.iter().enumerate() {
        let segments: Vec<&str> = vector["segments"]
            .as_array()
            .expect("segments")
            .iter()
            .map(|segment| segment.as_str().expect("a segment"))
            .collect();
        let mut list: Vec<u16> = Vec::new();
        for segment in &segments {
            list.extend(segment.encode_utf16());
            list.push(0);
        }
        let rule = vector["rule"].as_str().expect("rule");
        let result = split_segments(&list);
        match vector["verdict"].as_str().expect("verdict") {
            "accept" => {
                assert_eq!(rule, "depth", "path vector {index}");
                let split = result.unwrap_or_else(|error| panic!("path vector {index}: {error:?}"));
                let expected: Vec<Vec<u16>> = segments.iter().map(|s| units_of(s)).collect();
                assert_eq!(split, expected, "path vector {index}");
            }
            "refuse" => {
                let named = match result.expect_err("a refused path vector") {
                    ListError::TooDeep => "too_deep",
                    ListError::Name(name_rule) => name_rule.name(),
                    ListError::Malformed => "malformed",
                };
                assert_eq!(named, rule, "path vector {index}");
            }
            other => panic!("path vector {index}: unknown verdict {other}"),
        }
    }
}

#[test]
fn a_list_is_empty_or_ends_with_the_terminator() {
    assert_eq!(
        split_segments(&[]),
        Ok(Vec::new()),
        "an empty list names the root"
    );
    let unterminated = units_of("a");
    assert_eq!(split_segments(&unterminated), Err(ListError::Malformed));
    let mut second_unterminated = units_of("a");
    second_unterminated.push(0);
    second_unterminated.extend(units_of("b"));
    assert_eq!(
        split_segments(&second_unterminated),
        Err(ListError::Malformed)
    );
    assert_eq!(
        split_segments(&[0]),
        Err(ListError::Name(NameRule::Empty)),
        "one empty segment"
    );
    let mut doubled = units_of("a");
    doubled.extend([0, 0]);
    assert_eq!(
        split_segments(&doubled),
        Err(ListError::Name(NameRule::Empty))
    );
}

#[test]
fn a_list_error_maps_to_its_status_and_reason() {
    assert_eq!(
        ListError::Malformed.refusal(),
        Refusal::of(Status::InvalidArgument)
    );
    assert_eq!(ListError::TooDeep.refusal(), Refusal::path(Reason::TooDeep));
    for rule in REFUSE_RULES {
        let refusal = ListError::Name(rule).refusal();
        assert_eq!(refusal, Refusal::path(Reason::NameInvalid), "{rule:?}");
        assert_eq!(refusal.status, Status::PathRefused);
    }
}

/// Device names the vectors do not carry: Win32 also resolves these, so a file
/// with one of these names could not be opened or removed by Win32 tools.
#[test]
fn device_names_beyond_the_vectors_are_refused() {
    for name in [
        "con .txt",
        "NUL  .log",
        "COM\u{b9}",
        "com\u{b2}.txt",
        "LPT\u{b3}",
        "conin$",
        "CONOUT$",
    ] {
        assert_eq!(
            validate_segment(&units_of(name)),
            Err(NameRule::ReservedDevice),
            "{name:?}"
        );
    }
    for name in [
        "conin",
        "conout$x",
        "COM\u{2074}",
        "com",
        "lpt",
        "c\u{b9}",
        "config.sys",
    ] {
        assert_eq!(validate_segment(&units_of(name)), Ok(()), "{name:?}");
    }
}
