//! Wire protocol version 1: parsing requests, encoding replies and events.
//! `PROTOCOL.md` beside `Cargo.toml` is the contract; `services/computer-helper/protocol.js` is the Node twin.

use serde_json::{json, Map, Value};

pub const PROTOCOL: u32 = 1;
pub const VERSION_LINE: &str = "jenny-computer protocol 1\n";
/// Longest request line, line feed excluded.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Largest JSON-safe integer, the ceiling for request ids.
pub const MAX_ID: u64 = (1u64 << 53) - 1;

pub const OPS: &[&str] = &[
    "hello",
    "shutdown",
    "windows.list",
    "window.geometry",
    "window.show",
    "run.start",
    "run.close",
    "run.stop",
    "run.output",
    "run.list",
    "capture",
];

/// Row 196's operations, built behind the `input` feature (`not_built` without it).
pub const RESERVED_INPUT_OPS: &[&str] = &[
    "input.focus",
    "input.click",
    "input.drag",
    "input.move",
    "input.scroll",
    "input.type",
    "input.key",
    "input.release_all",
    "watch.start",
    "watch.stop",
    "watch.resume",
    "watch.state",
    "program.identify",
];

pub const EVENTS: &[&str] = &[
    "run.window",
    "run.window_state",
    "run.exited",
    "watch.owner_input",
    "watch.stop_chord",
    "log",
];

/// Why the helper's own check refused an input operation (`refused`'s `reason`), in the order checked.
pub const REFUSE_REASONS: &[&str] = &[
    "no_watch",
    "owner_active",
    "secure_desktop",
    "window_gone",
    "outside_window",
    "denied",
    "elevated",
    "unidentified",
    "wrong_program",
    "password_field",
    "refused_chord",
    "not_front",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    BadRequest,
    UnknownOp,
    NotAvailable,
    NotBuilt,
    NoSuchRun,
    RunExists,
    NoSuchWindow,
    StartFailed,
    CaptureFailed,
    TooLarge,
    Refused,
    Internal,
}

impl ErrorCode {
    pub const ALL: &'static [ErrorCode] = &[
        ErrorCode::BadRequest,
        ErrorCode::UnknownOp,
        ErrorCode::NotAvailable,
        ErrorCode::NotBuilt,
        ErrorCode::NoSuchRun,
        ErrorCode::RunExists,
        ErrorCode::NoSuchWindow,
        ErrorCode::StartFailed,
        ErrorCode::CaptureFailed,
        ErrorCode::TooLarge,
        ErrorCode::Refused,
        ErrorCode::Internal,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::UnknownOp => "unknown_op",
            ErrorCode::NotAvailable => "not_available",
            ErrorCode::NotBuilt => "not_built",
            ErrorCode::NoSuchRun => "no_such_run",
            ErrorCode::RunExists => "run_exists",
            ErrorCode::NoSuchWindow => "no_such_window",
            ErrorCode::StartFailed => "start_failed",
            ErrorCode::CaptureFailed => "capture_failed",
            ErrorCode::TooLarge => "too_large",
            ErrorCode::Refused => "refused",
            ErrorCode::Internal => "internal",
        }
    }
}

/// An error reply. `message` never holds a window title, a path or a command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtoError {
    pub code: ErrorCode,
    pub message: String,
    /// For `refused` only: one of [`REFUSE_REASONS`].
    pub reason: Option<&'static str>,
}

impl ProtoError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            reason: None,
        }
    }

    /// A `refused` error. `reason` must be one of [`REFUSE_REASONS`].
    pub fn refused(reason: &'static str, message: impl Into<String>) -> Self {
        debug_assert!(REFUSE_REASONS.contains(&reason), "unknown refuse reason");
        Self {
            code: ErrorCode::Refused,
            message: message.into(),
            reason: Some(reason),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, message)
    }

    pub fn not_built(op: &str) -> Self {
        Self::new(ErrorCode::NotBuilt, format!("{op} is not in this build"))
    }

    pub fn not_available() -> Self {
        Self::new(
            ErrorCode::NotAvailable,
            "jenny-computer supports Windows only",
        )
    }
}

/// One parsed request: its id, its operation and every other key as arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: u64,
    pub op: String,
    pub args: Map<String, Value>,
}

fn valid_op_name(op: &str) -> bool {
    !op.is_empty()
        && op.len() <= 64
        && op
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b == b'.' || b == b'_')
}

/// Parse one request line. On failure the id is returned when it could be read, so the
/// error reply can name it.
pub fn parse_request(line: &str) -> Result<Request, (Option<u64>, ProtoError)> {
    let value: Value = serde_json::from_str(line)
        .map_err(|_| (None, ProtoError::bad_request("request is not JSON")))?;
    let Value::Object(mut map) = value else {
        return Err((None, ProtoError::bad_request("request is not an object")));
    };
    let id = match map.remove("id") {
        Some(Value::Number(n)) => match n.as_u64() {
            Some(id) if id <= MAX_ID => id,
            _ => return Err((None, ProtoError::bad_request("id is out of range"))),
        },
        _ => return Err((None, ProtoError::bad_request("id is missing"))),
    };
    let op = match map.remove("op") {
        Some(Value::String(op)) if valid_op_name(&op) => op,
        _ => {
            return Err((
                Some(id),
                ProtoError::bad_request("op is missing or malformed"),
            ))
        }
    };
    Ok(Request { id, op, args: map })
}

impl Request {
    pub fn str_arg(&self, key: &str) -> Result<&str, ProtoError> {
        match self.args.get(key) {
            Some(Value::String(s)) => Ok(s.as_str()),
            _ => Err(ProtoError::bad_request(format!("{key} must be a string"))),
        }
    }

    pub fn opt_str_arg(&self, key: &str) -> Result<Option<&str>, ProtoError> {
        match self.args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.as_str())),
            _ => Err(ProtoError::bad_request(format!("{key} must be a string"))),
        }
    }

    /// A whole number in `min..=max`, or `default` when absent.
    pub fn u64_arg(&self, key: &str, default: u64, min: u64, max: u64) -> Result<u64, ProtoError> {
        match self.args.get(key) {
            None | Some(Value::Null) => Ok(default),
            Some(Value::Number(n)) => match n.as_u64() {
                Some(v) if (min..=max).contains(&v) => Ok(v),
                _ => Err(ProtoError::bad_request(format!(
                    "{key} must be a whole number from {min} to {max}"
                ))),
            },
            _ => Err(ProtoError::bad_request(format!("{key} must be a number"))),
        }
    }

    pub fn hwnd_arg(&self) -> Result<u64, ProtoError> {
        match self.args.get("hwnd") {
            Some(Value::Number(n)) => match n.as_u64() {
                Some(h) if h != 0 && h <= MAX_ID => Ok(h),
                _ => Err(ProtoError::bad_request("hwnd is out of range")),
            },
            _ => Err(ProtoError::bad_request("hwnd must be a number")),
        }
    }

    pub fn run_id_arg(&self) -> Result<&str, ProtoError> {
        let id = self.str_arg("run_id")?;
        if valid_run_id(id) {
            Ok(id)
        } else {
            Err(ProtoError::bad_request(
                "run_id must be 1 to 64 characters from A-Z a-z 0-9 _ -",
            ))
        }
    }

    pub fn string_list_arg(&self, key: &str) -> Result<Vec<String>, ProtoError> {
        let Some(Value::Array(items)) = self.args.get(key) else {
            return Err(ProtoError::bad_request(format!("{key} must be an array")));
        };
        items
            .iter()
            .map(|item| match item {
                Value::String(s) => Ok(s.clone()),
                _ => Err(ProtoError::bad_request(format!("{key} must hold strings"))),
            })
            .collect()
    }

    pub fn string_map_arg(&self, key: &str) -> Result<Vec<(String, String)>, ProtoError> {
        let Some(Value::Object(entries)) = self.args.get(key) else {
            return Err(ProtoError::bad_request(format!("{key} must be an object")));
        };
        entries
            .iter()
            .map(|(k, v)| match v {
                Value::String(s) => Ok((k.clone(), s.clone())),
                _ => Err(ProtoError::bad_request(format!(
                    "{key} values must be strings"
                ))),
            })
            .collect()
    }
}

pub fn valid_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Electron's capture source id for a window handle.
pub fn source_id(hwnd: u64) -> String {
    format!("window:{hwnd}:0")
}

fn line(value: &Value) -> String {
    let mut s = value.to_string();
    s.push('\n');
    s
}

pub fn reply_ok(id: u64, result: Value) -> String {
    line(&json!({"id": id, "ok": true, "result": result}))
}

pub fn reply_err(id: Option<u64>, error: &ProtoError) -> String {
    let mut body = json!({"code": error.code.as_str(), "message": error.message});
    if let (Some(reason), Value::Object(map)) = (error.reason, &mut body) {
        map.insert("reason".to_owned(), Value::String(reason.to_owned()));
    }
    line(&json!({"id": id, "ok": false, "error": body}))
}

pub fn event_line(name: &str, fields: Map<String, Value>) -> String {
    let mut map = fields;
    map.insert("event".to_owned(), Value::String(name.to_owned()));
    line(&Value::Object(map))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_error_carries_its_reason_and_others_carry_none() {
        let line = reply_err(
            Some(9),
            &ProtoError::refused("elevated", "runs as administrator"),
        );
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["error"]["code"], "refused");
        assert_eq!(v["error"]["reason"], "elevated");
        let plain: Value =
            serde_json::from_str(&reply_err(Some(1), &ProtoError::bad_request("x"))).unwrap();
        assert!(plain["error"].get("reason").is_none());
    }

    #[test]
    fn parses_a_request_and_keeps_the_rest_as_arguments() {
        let req = parse_request(r#"{"id":7,"op":"run.stop","run_id":"r1","close_timeout_ms":50}"#)
            .unwrap();
        assert_eq!(req.id, 7);
        assert_eq!(req.op, "run.stop");
        assert_eq!(req.run_id_arg().unwrap(), "r1");
        assert_eq!(
            req.u64_arg("close_timeout_ms", 2000, 0, 10_000).unwrap(),
            50
        );
        assert!(!req.args.contains_key("id"));
        assert!(!req.args.contains_key("op"));
    }

    #[test]
    fn rejects_bad_lines_with_the_id_when_it_was_readable() {
        assert_eq!(parse_request("nope").unwrap_err().0, None);
        assert_eq!(parse_request("[1]").unwrap_err().0, None);
        assert_eq!(parse_request(r#"{"op":"hello"}"#).unwrap_err().0, None);
        assert_eq!(
            parse_request(r#"{"id":-1,"op":"hello"}"#).unwrap_err().0,
            None
        );
        assert_eq!(
            parse_request(r#"{"id":9007199254740992,"op":"hello"}"#)
                .unwrap_err()
                .0,
            None
        );
        let (id, err) = parse_request(r#"{"id":3,"op":"Run Stop"}"#).unwrap_err();
        assert_eq!(id, Some(3));
        assert_eq!(err.code, ErrorCode::BadRequest);
    }

    #[test]
    fn argument_helpers_check_type_and_range() {
        let req = parse_request(
            r#"{"id":1,"op":"capture","hwnd":0,"max_long_edge":10,"run_id":"a b","args":["x",1],"env":{"A":"1"}}"#,
        )
        .unwrap();
        assert!(req.hwnd_arg().is_err());
        assert!(req.u64_arg("max_long_edge", 1568, 64, 4096).is_err());
        assert_eq!(req.u64_arg("missing", 1568, 64, 4096).unwrap(), 1568);
        assert!(req.run_id_arg().is_err());
        assert!(req.string_list_arg("args").is_err());
        assert_eq!(
            req.string_map_arg("env").unwrap(),
            vec![("A".to_owned(), "1".to_owned())]
        );
        assert_eq!(req.opt_str_arg("area").unwrap(), None);
    }

    #[test]
    fn run_ids_follow_the_documented_alphabet() {
        assert!(valid_run_id("run_1-A"));
        assert!(!valid_run_id(""));
        assert!(!valid_run_id(&"a".repeat(65)));
        assert!(!valid_run_id("r/1"));
    }

    #[test]
    fn replies_and_events_are_single_lines_with_the_documented_keys() {
        let ok: Value = serde_json::from_str(&reply_ok(4, json!({"a": 1}))).unwrap();
        assert_eq!(ok, json!({"id": 4, "ok": true, "result": {"a": 1}}));
        let err_line = reply_err(None, &ProtoError::not_built("input.click"));
        assert!(err_line.ends_with('\n') && err_line.matches('\n').count() == 1);
        let err: Value = serde_json::from_str(&err_line).unwrap();
        assert_eq!(err["id"], Value::Null);
        assert_eq!(err["error"]["code"], "not_built");
        let mut fields = Map::new();
        fields.insert("run_id".into(), json!("r1"));
        let ev: Value = serde_json::from_str(&event_line("run.exited", fields)).unwrap();
        assert_eq!(ev, json!({"event": "run.exited", "run_id": "r1"}));
    }

    #[test]
    fn source_id_matches_electrons_window_form() {
        assert_eq!(source_id(591_824), "window:591824:0");
    }

    #[test]
    fn error_codes_are_distinct() {
        let mut names: Vec<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), ErrorCode::ALL.len());
    }
}
