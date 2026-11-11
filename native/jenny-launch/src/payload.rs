//! The control request: one length-prefixed JSON object read from stdin.
//!
//! Pure and platform independent. The request is treated as hostile: every
//! failure collapses to [`Rejected`], and nothing here indexes or unwraps.
//! Behaviour mirrors `_read_bootstrap_payload` in
//! `sidecar/_owned_process_bootstrap.py`, with two intended differences:
//! a duplicate JSON key is rejected, and non-canonical base64 is rejected.

use std::collections::HashSet;
use std::io::Read;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{Map, Value};

/// Largest accepted JSON body, in bytes.
pub const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

/// `argv`, `cwd`, `env`, `input_data_b64`.
const FIELD_COUNT: usize = 4;

/// The request failed validation. Carries no detail on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rejected;

/// A validated target-launch request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub argv: Vec<String>,
    pub cwd: String,
    /// `None` means inherit; `Some` holds the pairs in document order.
    pub env: Option<Vec<(String, String)>>,
    /// `None` means the target's stdin is the NUL device.
    pub input: Option<Vec<u8>>,
}

/// Read exactly one frame (4-byte big-endian length, then the body) and
/// validate it. Reads nothing past the frame.
pub fn read_request<R: Read>(reader: &mut R) -> Result<Request, Rejected> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header).map_err(|_| Rejected)?;
    let size = usize::try_from(u32::from_be_bytes(header)).map_err(|_| Rejected)?;
    if size == 0 || size > MAX_PAYLOAD_BYTES {
        return Err(Rejected);
    }
    let mut body = Vec::with_capacity(size);
    reader
        .by_ref()
        .take(size as u64)
        .read_to_end(&mut body)
        .map_err(|_| Rejected)?;
    if body.len() != size {
        return Err(Rejected);
    }
    parse_payload(&body)
}

/// Validate the JSON body of a request.
pub fn parse_payload(bytes: &[u8]) -> Result<Request, Rejected> {
    let text = std::str::from_utf8(bytes).map_err(|_| Rejected)?;
    let document: Value = serde_json::from_str(text).map_err(|_| Rejected)?;
    let Value::Object(fields) = document else {
        return Err(Rejected);
    };
    // Exactly four distinct members; the field readers below each require
    // their own key, so those four can only be the expected ones.
    let members = object_members(text).ok_or(Rejected)?;
    if members.len() != FIELD_COUNT || has_duplicate(&members) {
        return Err(Rejected);
    }

    let argv = parse_argv(&fields)?;
    let cwd = string_field(&fields, "cwd")?;
    let env = parse_env(&fields, &members)?;
    let input = parse_input(&fields)?;
    if argv.first().is_none_or(|program| program.is_empty()) {
        return Err(Rejected);
    }
    let env_has_nul = env.iter().flatten().any(|(k, v)| has_nul(k) || has_nul(v));
    if argv.iter().any(|a| has_nul(a)) || has_nul(&cwd) || env_has_nul {
        return Err(Rejected);
    }
    Ok(Request {
        argv,
        cwd,
        env,
        input,
    })
}

fn has_nul(text: &str) -> bool {
    text.contains('\0')
}

fn string_field(fields: &Map<String, Value>, name: &str) -> Result<String, Rejected> {
    match fields.get(name) {
        Some(Value::String(text)) => Ok(text.clone()),
        _ => Err(Rejected),
    }
}

fn parse_argv(fields: &Map<String, Value>) -> Result<Vec<String>, Rejected> {
    let Some(Value::Array(items)) = fields.get("argv") else {
        return Err(Rejected);
    };
    items
        .iter()
        .map(|item| item.as_str().map(str::to_owned).ok_or(Rejected))
        .collect()
}

fn parse_env(
    fields: &Map<String, Value>,
    members: &[(String, &str)],
) -> Result<Option<Vec<(String, String)>>, Rejected> {
    match fields.get("env") {
        Some(Value::Null) => Ok(None),
        Some(Value::Object(values)) => {
            let raw = members
                .iter()
                .find(|(key, _)| key == "env")
                .map(|(_, raw)| *raw)
                .ok_or(Rejected)?;
            // The scanner gives the order and the duplicates; the values come
            // from the map serde_json already built.
            let pairs = object_members(raw).ok_or(Rejected)?;
            if has_duplicate(&pairs) {
                return Err(Rejected);
            }
            pairs
                .into_iter()
                .map(|(key, _)| match values.get(&key) {
                    Some(Value::String(value)) => Ok((key, value.clone())),
                    _ => Err(Rejected),
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Some)
        }
        _ => Err(Rejected),
    }
}

fn has_duplicate(members: &[(String, &str)]) -> bool {
    let mut seen = HashSet::with_capacity(members.len());
    !members.iter().all(|(key, _)| seen.insert(key.as_str()))
}

fn parse_input(fields: &Map<String, Value>) -> Result<Option<Vec<u8>>, Rejected> {
    match fields.get("input_data_b64") {
        Some(Value::Null) => Ok(None),
        Some(Value::String(encoded)) => STANDARD
            .decode(encoded.as_bytes())
            .map(Some)
            .map_err(|_| Rejected),
        _ => Err(Rejected),
    }
}

/// Split a JSON object (already validated as well-formed by `serde_json`) into
/// its members in document order: the decoded key and the raw text of the
/// value. serde_json's own map loses order and silently merges duplicates, so
/// this small scanner supplies both. It never panics; on anything unexpected
/// it returns `None`.
fn object_members(text: &str) -> Option<Vec<(String, &str)>> {
    let bytes = text.as_bytes();
    let mut pos = skip_whitespace(bytes, 0);
    if *bytes.get(pos)? != b'{' {
        return None;
    }
    pos += 1;
    let mut members = Vec::new();
    pos = skip_whitespace(bytes, pos);
    if *bytes.get(pos)? == b'}' {
        return Some(members);
    }
    loop {
        pos = skip_whitespace(bytes, pos);
        if *bytes.get(pos)? != b'"' {
            return None;
        }
        let key_end = string_end(bytes, pos)?;
        let key: String = serde_json::from_str(text.get(pos..key_end)?).ok()?;
        pos = skip_whitespace(bytes, key_end);
        if *bytes.get(pos)? != b':' {
            return None;
        }
        pos = skip_whitespace(bytes, pos + 1);
        let value_end = value_end(bytes, pos)?;
        members.push((key, text.get(pos..value_end)?));
        pos = skip_whitespace(bytes, value_end);
        match *bytes.get(pos)? {
            b',' => pos += 1,
            b'}' => return Some(members),
            _ => return None,
        }
    }
}

fn skip_whitespace(bytes: &[u8], mut pos: usize) -> usize {
    while matches!(bytes.get(pos), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        pos += 1;
    }
    pos
}

/// Index just past the closing quote of the string that opens at `start`.
fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut pos = start + 1;
    loop {
        match *bytes.get(pos)? {
            b'\\' => pos += 2,
            b'"' => return Some(pos + 1),
            _ => pos += 1,
        }
    }
}

/// Index just past the JSON value that begins at `start`.
fn value_end(bytes: &[u8], start: usize) -> Option<usize> {
    match *bytes.get(start)? {
        b'"' => string_end(bytes, start),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut pos = start;
            loop {
                match *bytes.get(pos)? {
                    b'"' => {
                        pos = string_end(bytes, pos)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth = depth.checked_sub(1)?;
                        if depth == 0 {
                            return Some(pos + 1);
                        }
                    }
                    _ => {}
                }
                pos += 1;
            }
        }
        _ => {
            let mut pos = start;
            while let Some(byte) = bytes.get(pos) {
                if matches!(byte, b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r') {
                    break;
                }
                pos += 1;
            }
            Some(pos)
        }
    }
}
