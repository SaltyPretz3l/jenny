//! The line-JSON control channel: bounded line reading, field validation, and the one
//! output handle every task writes through.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::sync::mpsc;
use zeroize::{Zeroize, Zeroizing};

/// The longest accepted input line, in bytes, not counting the `\n` terminator.
pub const MAX_LINE_BYTES: usize = 65536;

/// The reasons an `error` line can carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    StartInvalid,
    StartTimeout,
    BindFailed,
    ProtocolInvalid,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::StartInvalid => "start_invalid",
            Reason::StartTimeout => "start_timeout",
            Reason::BindFailed => "bind_failed",
            Reason::ProtocolInvalid => "protocol_invalid",
        }
    }

    /// The process exit code for this reason.
    pub fn exit_code(self) -> i32 {
        match self {
            Reason::BindFailed => 3,
            _ => 2,
        }
    }
}

/// One step of reading the control input.
pub enum LineRead {
    Line(Zeroizing<Vec<u8>>),
    Eof,
    TooLong,
}

/// Reads `\n`-terminated lines of at most [`MAX_LINE_BYTES`] bytes. A trailing `\r` is
/// dropped. End of input in the middle of a line counts as end of input.
pub struct LineReader<R> {
    input: R,
}

impl<R: AsyncBufRead + Unpin> LineReader<R> {
    pub fn new(input: R) -> Self {
        Self { input }
    }

    pub async fn next_line(&mut self) -> LineRead {
        // Reserved up front so the buffer never reallocates and leaves secret copies behind.
        let mut line = Zeroizing::new(Vec::with_capacity(MAX_LINE_BYTES + 1));
        loop {
            let chunk = match self.input.fill_buf().await {
                Ok(chunk) => chunk,
                Err(_) => return LineRead::Eof,
            };
            if chunk.is_empty() {
                return LineRead::Eof;
            }
            let (take, complete) = match chunk.iter().position(|byte| *byte == b'\n') {
                Some(index) => (index, true),
                None => (chunk.len(), false),
            };
            if line.len() + take > MAX_LINE_BYTES {
                return LineRead::TooLong;
            }
            line.extend_from_slice(&chunk[..take]);
            let consumed = if complete { take + 1 } else { take };
            self.input.consume(consumed);
            if complete {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return LineRead::Line(line);
            }
        }
    }
}

/// One item of control input after `start`.
pub enum Input<C> {
    Command(C),
    /// A line that is too long, not JSON, or not a known message: `protocol_invalid`.
    Invalid,
    Eof,
}

/// Reads and parses lines until end of input or the first invalid line.
pub async fn read_commands<R, C, F>(
    mut reader: LineReader<R>,
    commands: mpsc::Sender<Input<C>>,
    parse: F,
) where
    R: AsyncBufRead + Unpin,
    F: Fn(&[u8]) -> Result<C, Reason>,
{
    loop {
        let input = match reader.next_line().await {
            LineRead::Line(line) => match parse(&line) {
                Ok(command) => Input::Command(command),
                Err(_) => Input::Invalid,
            },
            LineRead::TooLong => Input::Invalid,
            LineRead::Eof => Input::Eof,
        };
        let last = !matches!(input, Input::Command(_));
        if commands.send(input).await.is_err() || last {
            return;
        }
    }
}

/// A parsed control line: its `t` and the remaining fields.
pub struct Message {
    pub t: String,
    pub fields: Map<String, Value>,
}

impl Drop for Message {
    fn drop(&mut self) {
        // Secrets that were never taken out (a rejected start) are wiped here.
        for value in self.fields.values_mut() {
            wipe_value(value);
        }
    }
}

fn wipe_value(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(items) => items.iter_mut().for_each(wipe_value),
        Value::Object(map) => map.values_mut().for_each(wipe_value),
        _ => {}
    }
}

/// Parses one line into a JSON object with a string `t`, else `protocol_invalid`.
pub fn parse_message(line: &[u8]) -> Result<Message, Reason> {
    let text = std::str::from_utf8(line).map_err(|_| Reason::ProtocolInvalid)?;
    let value: Value = serde_json::from_str(text).map_err(|_| Reason::ProtocolInvalid)?;
    let Value::Object(mut fields) = value else {
        return Err(Reason::ProtocolInvalid);
    };
    let t = match fields.remove("t") {
        Some(Value::String(t)) => t,
        _ => return Err(Reason::ProtocolInvalid),
    };
    Ok(Message { t, fields })
}

/// Field readers. Each returns `Err(())`; the caller maps it to its reason.
pub(crate) mod field {
    use super::*;

    pub fn take_string(fields: &mut Map<String, Value>, name: &str) -> Result<String, ()> {
        match fields.remove(name) {
            Some(Value::String(text)) => Ok(text),
            Some(mut other) => {
                wipe_value(&mut other);
                Err(())
            }
            None => Err(()),
        }
    }

    /// A base64url (no padding) value that decodes to exactly 32 bytes.
    pub fn take_b64_32(
        fields: &mut Map<String, Value>,
        name: &str,
    ) -> Result<Zeroizing<[u8; 32]>, ()> {
        let text = Zeroizing::new(take_string(fields, name)?);
        decode_b64_32(&text)
    }

    pub fn decode_b64_32(text: &str) -> Result<Zeroizing<[u8; 32]>, ()> {
        // 32 bytes encode to exactly 43 characters; anything longer is refused before decoding.
        if text.len() != 43 {
            return Err(());
        }
        let decoded = Zeroizing::new(URL_SAFE_NO_PAD.decode(text).map_err(|_| ())?);
        if decoded.len() != 32 {
            return Err(());
        }
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&decoded);
        Ok(out)
    }

    pub fn u64_of(fields: &Map<String, Value>, name: &str) -> Result<u64, ()> {
        fields.get(name).and_then(Value::as_u64).ok_or(())
    }

    /// A positive `u32`.
    pub fn limit(fields: &Map<String, Value>, name: &str) -> Result<u32, ()> {
        let value = u64_of(fields, name)?;
        match u32::try_from(value) {
            Ok(value) if value > 0 => Ok(value),
            _ => Err(()),
        }
    }

    pub fn port(fields: &Map<String, Value>, name: &str) -> Result<u16, ()> {
        match u16::try_from(u64_of(fields, name)?) {
            Ok(port) if port > 0 => Ok(port),
            _ => Err(()),
        }
    }

    /// `null` or a port; the field must be present.
    pub fn optional_port(fields: &Map<String, Value>, name: &str) -> Result<Option<u16>, ()> {
        match fields.get(name) {
            Some(Value::Null) => Ok(None),
            Some(_) => port(fields, name).map(Some),
            None => Err(()),
        }
    }

    /// A non-empty string of at most 64 bytes.
    pub fn alpn(fields: &Map<String, Value>) -> Result<Vec<u8>, ()> {
        match fields.get("alpn") {
            Some(Value::String(text)) if !text.is_empty() && text.len() <= 64 => {
                Ok(text.as_bytes().to_vec())
            }
            _ => Err(()),
        }
    }

    pub fn object(fields: &mut Map<String, Value>, name: &str) -> Result<Map<String, Value>, ()> {
        match fields.remove(name) {
            Some(Value::Object(map)) => Ok(map),
            _ => Err(()),
        }
    }

    /// `mode` must equal `expected`.
    pub fn mode(fields: &Map<String, Value>, expected: &str) -> Result<(), ()> {
        match fields.get("mode") {
            Some(Value::String(mode)) if mode == expected => Ok(()),
            _ => Err(()),
        }
    }
}

/// Encodes 32 key bytes as base64url without padding.
pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The output handle. Lines are compact JSON without the terminator; the receiver
/// writes each with `\n` and flushes. Muted after end of input: nothing more is written.
#[derive(Clone)]
pub struct Out {
    tx: mpsc::Sender<String>,
    muted: Arc<AtomicBool>,
}

impl Out {
    pub fn new(tx: mpsc::Sender<String>) -> Self {
        Self {
            tx,
            muted: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn mute(&self) {
        self.muted.store(true, Ordering::SeqCst);
    }

    pub async fn send(&self, value: Value) {
        if self.muted.load(Ordering::SeqCst) {
            return;
        }
        // A closed receiver means the parent is gone; nothing useful can be done.
        let _ = self.tx.send(value.to_string()).await;
    }

    /// A `log` line. `fields` carries integers and fixed words only. Best effort: when the
    /// channel to the parent is full the line is dropped, so a peer that makes the bridge
    /// refuse in a loop cannot hold up the bridge or flood the parent.
    pub async fn log(&self, event: &str, fields: Value) {
        if self.muted.load(Ordering::SeqCst) {
            return;
        }
        let line = serde_json::json!({ "t": "log", "event": event, "fields": fields });
        let _ = self.tx.try_send(line.to_string());
    }

    pub async fn error(&self, reason: Reason) {
        self.send(serde_json::json!({ "t": "error", "reason": reason.as_str() }))
            .await;
    }
}
