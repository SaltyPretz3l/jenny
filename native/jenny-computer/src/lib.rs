//! `jenny-computer`: the native helper shared by rows 196 and 197.
//!
//! Electron's main process starts it with `--serve` and speaks the line protocol in `PROTOCOL.md` on its
//! stdin and stdout: the window list, runs in Windows jobs, window geometry and Windows' own capture.
//! Input injection (row 196) is behind the `input` feature, which is on by default.

#![deny(unsafe_op_in_unsafe_fn)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

pub mod capture;
pub mod dispatch;
pub mod events;
pub mod geometry;
pub mod job;
pub mod output;
pub mod protocol;
pub mod window_list;

#[cfg(feature = "input")]
pub mod input;

use std::ffi::OsString;
use std::io::{BufRead, Write};

use dispatch::{Context, Flow, Reply};
use events::Emitter;
use protocol::{parse_request, reply_err, reply_ok, ProtoError, MAX_REQUEST_BYTES, VERSION_LINE};

/// Exit code for a bad command line.
pub const EXIT_USAGE: i32 = 125;
/// Exit code when stdout can no longer be written.
pub const EXIT_IO: i32 = 74;

pub fn run_cli<I>(args: I) -> i32
where
    I: IntoIterator<Item = OsString>,
{
    let rest: Vec<OsString> = args.into_iter().skip(1).collect();
    match rest.as_slice() {
        [flag] if flag == "--version" => {
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(VERSION_LINE.as_bytes());
            let _ = stdout.flush();
            0
        }
        [flag] if flag == "--serve" => serve(
            std::io::stdin().lock(),
            Emitter::new(Box::new(std::io::stdout())),
        ),
        _ => {
            let mut stderr = std::io::stderr().lock();
            let _ = stderr.write_all(b"usage: jenny-computer --serve | --version\n");
            EXIT_USAGE
        }
    }
}

/// What one bounded read produced.
#[derive(Debug, PartialEq, Eq)]
pub enum LineRead {
    /// End of input with nothing pending.
    Eof,
    /// One line, line feed (and a carriage return before it) removed.
    Line(Vec<u8>),
    /// A line longer than the cap; it was read to its end and thrown away.
    TooLong,
}

/// Read one line of at most `cap` bytes without ever holding more than `cap` bytes of it.
pub fn read_line_bounded<R: BufRead>(input: &mut R, cap: usize) -> std::io::Result<LineRead> {
    let mut line = Vec::new();
    let mut too_long = false;
    let mut saw_any = false;
    loop {
        let chunk = input.fill_buf()?;
        if chunk.is_empty() {
            if !saw_any {
                return Ok(LineRead::Eof);
            }
            break;
        }
        saw_any = true;
        let (taken, done) = match chunk.iter().position(|&b| b == b'\n') {
            Some(pos) => (pos, true),
            None => (chunk.len(), false),
        };
        if !too_long {
            let part = chunk.get(..taken).unwrap_or_default();
            if line.len() + part.len() > cap {
                too_long = true;
                line.clear();
            } else {
                line.extend_from_slice(part);
            }
        }
        input.consume(if done { taken + 1 } else { taken });
        if done {
            break;
        }
    }
    if too_long {
        return Ok(LineRead::TooLong);
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(LineRead::Line(line))
}

/// Answer requests from `input` until `shutdown` or the end of input. Returns the exit code.
pub fn serve<R: BufRead>(mut input: R, emitter: Emitter) -> i32 {
    #[cfg(feature = "input")]
    crate::input::install_panic_release();
    let mut ctx = Context::new(emitter.clone());
    loop {
        let read = match read_line_bounded(&mut input, MAX_REQUEST_BYTES) {
            Ok(read) => read,
            Err(_) => {
                end_now(&mut ctx);
                return EXIT_IO;
            }
        };
        // `None` is a reply that a thread of its own writes later (`run.stop`).
        let (reply, flow) = match read {
            LineRead::Eof => {
                end_now(&mut ctx);
                return 0;
            }
            LineRead::TooLong => (
                Some(reply_err(
                    None,
                    &ProtoError::bad_request("request line is over 64 KiB"),
                )),
                Flow::Continue,
            ),
            LineRead::Line(bytes) => match answer(&mut ctx, &bytes) {
                Some(answered) => answered,
                None => continue,
            },
        };
        if let Some(line) = reply {
            if emitter.line(&line).is_err() {
                end_now(&mut ctx);
                return EXIT_IO;
            }
        }
        // A run's window and exit events start only now, so none can come before its `run.start` reply.
        ctx.runs.start_monitors();
        if flow == Flow::Exit {
            end_input(&mut ctx);
            return 0;
        }
    }
}

/// The end of input or a write error: every job ended at once, the watch stopped, held input let go.
fn end_now(ctx: &mut Context) {
    end_input(ctx);
    ctx.runs.end_all_now();
}

/// Stop the owner's watch and let go of every key and button this helper holds.
fn end_input(ctx: &mut Context) {
    #[cfg(feature = "input")]
    ctx.input.end();
    #[cfg(not(feature = "input"))]
    let _ = ctx;
}

/// What to do with one request line: `None` for a blank line, else its reply line (itself `None` when a
/// thread writes it later) and what the helper does next.
fn answer(ctx: &mut Context, bytes: &[u8]) -> Option<(Option<String>, Flow)> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Some((
            Some(reply_err(
                None,
                &ProtoError::bad_request("request is not UTF-8"),
            )),
            Flow::Continue,
        ));
    };
    if text.trim().is_empty() {
        return None;
    }
    Some(match parse_request(text) {
        Ok(req) => {
            let (reply, flow) = dispatch::handle(ctx, &req);
            let line = match reply {
                Reply::Now(Ok(value)) => Some(reply_ok(req.id, value)),
                Reply::Now(Err(err)) => Some(reply_err(Some(req.id), &err)),
                Reply::Later => None,
            };
            (line, flow)
        }
        Err((id, err)) => (Some(reply_err(id, &err)), Flow::Continue),
    })
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
    use events::MemorySink;
    use serde_json::Value;
    use std::io::Cursor;

    fn session(input: &str) -> (i32, Vec<Value>) {
        let sink = MemorySink::default();
        let code = serve(
            Cursor::new(input.to_owned()),
            Emitter::new(Box::new(sink.clone())),
        );
        let lines = sink
            .text()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        (code, lines)
    }

    #[test]
    fn bounded_reader_splits_lines_and_drops_overlong_ones() {
        let mut input = Cursor::new(b"ab\r\n\nxxxxxxxxxx\ncd".to_vec());
        assert_eq!(
            read_line_bounded(&mut input, 4).unwrap(),
            LineRead::Line(b"ab".to_vec())
        );
        assert_eq!(
            read_line_bounded(&mut input, 4).unwrap(),
            LineRead::Line(Vec::new())
        );
        assert_eq!(read_line_bounded(&mut input, 4).unwrap(), LineRead::TooLong);
        assert_eq!(
            read_line_bounded(&mut input, 4).unwrap(),
            LineRead::Line(b"cd".to_vec())
        );
        assert_eq!(read_line_bounded(&mut input, 4).unwrap(), LineRead::Eof);
    }

    #[test]
    fn a_session_answers_in_order_and_exits_on_shutdown() {
        let (code, lines) = session(concat!(
            "{\"id\":1,\"op\":\"hello\"}\n",
            "\n",
            "not json\n",
            "{\"id\":2,\"op\":\"nope\"}\n",
            "{\"id\":3,\"op\":\"shutdown\"}\n",
            "{\"id\":4,\"op\":\"hello\"}\n",
        ));
        assert_eq!(code, 0);
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[0]["result"]["protocol"], 1);
        assert_eq!(lines[1]["id"], Value::Null);
        assert_eq!(lines[1]["error"]["code"], "bad_request");
        assert_eq!(lines[2]["error"]["code"], "unknown_op");
        assert_eq!(
            lines[3],
            serde_json::json!({"id": 3, "ok": true, "result": {}})
        );
    }

    #[test]
    fn end_of_input_ends_the_session_cleanly() {
        let (code, lines) = session("{\"id\":1,\"op\":\"hello\"}");
        assert_eq!(code, 0);
        assert_eq!(lines.len(), 1);
    }

    /// A request reader that holds the end of input back until the run has reported its exit, so the
    /// session does not end the run before its events are out.
    #[cfg(windows)]
    struct HeldOpen {
        inner: Cursor<Vec<u8>>,
        sink: MemorySink,
    }

    #[cfg(windows)]
    impl std::io::Read for HeldOpen {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            std::io::Read::read(&mut self.inner, buf)
        }
    }

    #[cfg(windows)]
    impl BufRead for HeldOpen {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            if self.inner.position() as usize >= self.inner.get_ref().len() {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
                while !self.sink.text().contains("run.exited")
                    && std::time::Instant::now() < deadline
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            self.inner.fill_buf()
        }

        fn consume(&mut self, amt: usize) {
            self.inner.consume(amt);
        }
    }

    /// A program that ends at once must not get its `run.exited` onto the wire before the `run.start`
    /// reply that announces the run.
    #[cfg(windows)]
    #[test]
    fn a_run_start_reply_comes_before_the_exit_of_a_program_that_ends_at_once() {
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned());
        let start = serde_json::json!({
            "id": 1, "op": "run.start", "run_id": "instant",
            "program": format!(r"{system}\System32\cmd.exe"),
            "args": ["/c", "exit", "0"],
            "cwd": format!(r"{system}\System32"),
            "env": {"SystemRoot": system.clone()},
        });
        for _ in 0..5 {
            let sink = MemorySink::default();
            let input = HeldOpen {
                inner: Cursor::new(
                    format!(
                        "{start}
"
                    )
                    .into_bytes(),
                ),
                sink: sink.clone(),
            };
            let code = serve(input, Emitter::new(Box::new(sink.clone())));
            assert_eq!(code, 0);
            let lines: Vec<Value> = sink
                .text()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect();
            let reply = lines.iter().position(|l| l["id"] == 1).expect("a reply");
            let exited = lines
                .iter()
                .position(|l| l["event"] == "run.exited")
                .expect("an exit event");
            assert_eq!(lines[reply]["ok"], true, "{:?}", lines[reply]);
            assert!(reply < exited, "reply at {reply}, exit at {exited}");
        }
    }

    #[test]
    fn an_overlong_request_is_refused_and_the_session_goes_on() {
        let long = format!(
            "{}\n{{\"id\":5,\"op\":\"hello\"}}\n",
            "x".repeat(MAX_REQUEST_BYTES + 1)
        );
        let (_, lines) = session(&long);
        assert_eq!(lines[0]["error"]["code"], "bad_request");
        assert_eq!(lines[1]["id"], 5);
    }
}
