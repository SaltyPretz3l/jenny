//! Segment names and segment lists. Pure.
//!
//! Every name below the root is judged here before any system call. The rules
//! are the table "Segment names" of the spec, and the cases are the shared
//! vectors in `tests/fixtures/win32-segment-name-vectors.json`.
#![forbid(unsafe_code)]

use crate::abi::{Reason, Refusal, Status, MAX_DEPTH, MAX_SEGMENT_UNITS, SEGMENT_TERMINATOR};

const DOT: u16 = 0x2E;
const SPACE: u16 = 0x20;

/// Which rule refused a name. `name()` is the `rule` string of the vectors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameRule {
    Empty,
    Dot,
    DotDot,
    TooLong,
    SeparatorOrColon,
    InvalidChar,
    ControlChar,
    LoneSurrogate,
    TrailingDot,
    TrailingSpace,
    ReservedDevice,
}

impl NameRule {
    pub const fn name(self) -> &'static str {
        match self {
            NameRule::Empty => "empty",
            NameRule::Dot => "dot",
            NameRule::DotDot => "dotdot",
            NameRule::TooLong => "too_long",
            NameRule::SeparatorOrColon => "separator_or_colon",
            NameRule::InvalidChar => "invalid_char",
            NameRule::ControlChar => "control_char",
            NameRule::LoneSurrogate => "lone_surrogate",
            NameRule::TrailingDot => "trailing_dot",
            NameRule::TrailingSpace => "trailing_space",
            NameRule::ReservedDevice => "reserved_device",
        }
    }
}

/// Judges one segment, given as UTF-16 code units without a terminator.
///
/// Order: the whole-name shapes, the length bound, the first offending code
/// unit, the last code unit, then the device names.
pub fn validate_segment(units: &[u16]) -> Result<(), NameRule> {
    match units {
        [] => return Err(NameRule::Empty),
        [DOT] => return Err(NameRule::Dot),
        [DOT, DOT] => return Err(NameRule::DotDot),
        _ => {}
    }
    if units.len() > MAX_SEGMENT_UNITS {
        return Err(NameRule::TooLong);
    }
    scan_units(units)?;
    match units.last() {
        Some(&DOT) => return Err(NameRule::TrailingDot),
        Some(&SPACE) => return Err(NameRule::TrailingSpace),
        _ => {}
    }
    if is_reserved_device(units) {
        return Err(NameRule::ReservedDevice);
    }
    Ok(())
}

fn scan_units(units: &[u16]) -> Result<(), NameRule> {
    let mut rest = units.iter().copied();
    while let Some(unit) = rest.next() {
        match unit {
            // `\`, `/` and `:` (a stream or a drive).
            0x5C | 0x2F | 0x3A => return Err(NameRule::SeparatorOrColon),
            // `<`, `>`, `"`, `|`, `?`, `*`.
            0x3C | 0x3E | 0x22 | 0x7C | 0x3F | 0x2A => return Err(NameRule::InvalidChar),
            0x00..=0x1F | 0x7F => return Err(NameRule::ControlChar),
            // A high surrogate must be followed at once by a low one.
            0xD800..=0xDBFF => match rest.next() {
                Some(0xDC00..=0xDFFF) => {}
                _ => return Err(NameRule::LoneSurrogate),
            },
            0xDC00..=0xDFFF => return Err(NameRule::LoneSurrogate),
            _ => {}
        }
    }
    Ok(())
}

const fn fold(unit: u16) -> u16 {
    match unit {
        0x61..=0x7A => unit - 0x20,
        _ => unit,
    }
}

fn folded_eq(units: &[u16], upper: &[u8]) -> bool {
    units.len() == upper.len()
        && units
            .iter()
            .zip(upper)
            .all(|(&unit, &byte)| fold(unit) == u16::from(byte))
}

/// A device name is judged on the part before the first dot, with trailing
/// spaces dropped, case folded: Win32 resolves `con.txt` and `CON .txt` to the
/// console too. The digits are zero to nine (Microsoft lists `COM0` and `LPT0`
/// as reserved) and the superscripts one to three, which Win32 accepts in `COM`
/// and `LPT` names.
fn is_reserved_device(units: &[u16]) -> bool {
    let mut base = units.split(|&unit| unit == DOT).next().unwrap_or(units);
    while let [head @ .., SPACE] = base {
        base = head;
    }
    const WORDS: [&[u8]; 6] = [b"CON", b"PRN", b"AUX", b"NUL", b"CONIN$", b"CONOUT$"];
    if WORDS.iter().any(|word| folded_eq(base, word)) {
        return true;
    }
    match base {
        [prefix @ .., digit] => {
            (folded_eq(prefix, b"COM") || folded_eq(prefix, b"LPT"))
                && matches!(digit, 0x30..=0x39 | 0xB9 | 0xB2 | 0xB3)
        }
        [] => false,
    }
}

/// Why a segment list was not accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListError {
    /// The list is not empty and does not end with the terminator.
    Malformed,
    /// More than `MAX_DEPTH` segments.
    TooDeep,
    Name(NameRule),
}

impl ListError {
    pub const fn refusal(self) -> Refusal {
        match self {
            ListError::Malformed => Refusal::of(Status::InvalidArgument),
            ListError::TooDeep => Refusal::path(Reason::TooDeep),
            ListError::Name(_) => Refusal::path(Reason::NameInvalid),
        }
    }
}

/// Splits a segment list (every segment ends with U+0000) and validates each
/// segment. An empty list names the root. The segments are never joined.
pub fn split_segments(units: &[u16]) -> Result<Vec<&[u16]>, ListError> {
    if units.is_empty() {
        return Ok(Vec::new());
    }
    let Some(body) = units.strip_suffix(&[SEGMENT_TERMINATOR]) else {
        return Err(ListError::Malformed);
    };
    let mut segments = Vec::new();
    for segment in body.split(|&unit| unit == SEGMENT_TERMINATOR) {
        if segments.len() == MAX_DEPTH {
            return Err(ListError::TooDeep);
        }
        validate_segment(segment).map_err(ListError::Name)?;
        segments.push(segment);
    }
    Ok(segments)
}
