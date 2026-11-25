//! A `run.stop` off the request loop, through `serve`: later requests are answered while a stop runs,
//! the stopped run is gone at once, and shutdown and the end of input deal with stops in flight.
//!
//! new-test-file: split from tests/runs.rs, which would pass the 600-line cap; these drive `serve`
//! itself over a fed reader instead of the library's `Runs` directly.

#![cfg(windows)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::{Duration, Instant};

use jenny_computer::events::Emitter;
use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
};

/// No test waits longer than this for anything.
const LIMIT: Duration = Duration::from_secs(30);

fn system32() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned());
    format!(r"{root}\System32")
}

fn cmd_exe() -> String {
    format!(r"{}\cmd.exe", system32())
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + LIMIT;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn process_gone(pid: u32, within: Duration) -> bool {
    // SAFETY: plain calls; the handle is checked before use and closed once.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return true;
        }
        let waited = WaitForSingleObject(handle, within.as_millis() as u32);
        CloseHandle(handle);
        waited == WAIT_OBJECT_0
    }
}

/// A request reader fed line by line from the test, so a test decides when each request arrives.
struct Fed {
    rx: std::sync::mpsc::Receiver<String>,
    pending: Vec<u8>,
    at: usize,
}

impl std::io::Read for Fed {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let got = std::io::BufRead::fill_buf(self)?;
        let n = got.len().min(buf.len());
        buf[..n].copy_from_slice(&got[..n]);
        std::io::BufRead::consume(self, n);
        Ok(n)
    }
}

impl std::io::BufRead for Fed {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if self.at >= self.pending.len() {
            self.pending = self.rx.recv().map(String::into_bytes).unwrap_or_default();
            self.at = 0;
        }
        Ok(&self.pending[self.at..])
    }

    fn consume(&mut self, amt: usize) {
        self.at += amt;
    }
}

/// A sink that notes when each line was written.
#[derive(Clone, Default)]
struct TimedSink {
    lines: std::sync::Arc<std::sync::Mutex<Vec<(Instant, Value)>>>,
}

impl std::io::Write for TimedSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let value = serde_json::from_str(line).unwrap();
            self.lines.lock().unwrap().push((Instant::now(), value));
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A whole `serve` session on its own thread, driven one request line at a time.
struct Served {
    tx: Option<std::sync::mpsc::Sender<String>>,
    sink: TimedSink,
    thread: Option<std::thread::JoinHandle<i32>>,
}

impl Served {
    fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = TimedSink::default();
        let out = sink.clone();
        let thread = std::thread::spawn(move || {
            let input = Fed {
                rx,
                pending: Vec::new(),
                at: 0,
            };
            jenny_computer::serve(input, Emitter::new(Box::new(out)))
        });
        Self {
            tx: Some(tx),
            sink,
            thread: Some(thread),
        }
    }

    fn send(&self, value: Value) {
        let tx = self.tx.as_ref().unwrap();
        tx.send(format!("{value}\n")).unwrap();
    }

    /// The reply to request `id`, with the position it was written at, once it is there.
    fn reply(&self, id: u64) -> Option<(usize, Instant, Value)> {
        let lines = self.sink.lines.lock().unwrap();
        lines
            .iter()
            .position(|(_, v)| v["id"] == id)
            .map(|at| (at, lines[at].0, lines[at].1.clone()))
    }

    fn wait_reply(&self, id: u64) -> (usize, Instant, Value) {
        let mut found = None;
        wait_until(&format!("the reply to {id}"), || {
            found = self.reply(id);
            found.is_some()
        });
        found.unwrap()
    }

    /// End the input and return the session's exit code.
    fn finish(mut self) -> i32 {
        self.tx = None;
        self.thread.take().unwrap().join().unwrap()
    }

    fn start_long(&self, id: u64, run_id: &str) -> u32 {
        self.send(json!({
            "id": id, "op": "run.start", "run_id": run_id, "program": cmd_exe(),
            "args": ["/c", "ping", "-n", "30", "127.0.0.1"], "cwd": system32(),
            "env": {"SystemRoot": std::env::var("SystemRoot").unwrap_or_default(), "PATH": system32()},
        }));
        let (_, _, started) = self.wait_reply(id);
        assert_eq!(started["ok"], true, "{started}");
        started["result"]["pid"].as_u64().unwrap() as u32
    }
}

#[test]
fn a_slow_stop_does_not_hold_the_requests_behind_it() {
    let s = Served::new();
    let pid = s.start_long(1, "slow");
    let began = Instant::now();
    s.send(json!({"id": 2, "op": "run.stop", "run_id": "slow", "close_timeout_ms": 3000}));
    s.send(json!({"id": 3, "op": "hello"}));
    let (hello_at, hello_time, _) = s.wait_reply(3);
    assert!(hello_time.duration_since(began) < Duration::from_secs(1));
    let (stop_at, _, stopped) = s.wait_reply(2);
    assert!(hello_at < stop_at, "hello at {hello_at}, stop at {stop_at}");
    assert_eq!(stopped["ok"], true, "{stopped}");
    assert_eq!(stopped["result"]["run_id"], "slow");
    assert_eq!(stopped["result"]["how"], "ended");
    assert!(process_gone(pid, Duration::from_secs(5)));
    assert_eq!(s.finish(), 0);
}

#[test]
fn a_stop_of_an_unknown_run_is_answered_in_order() {
    let s = Served::new();
    s.send(json!({"id": 1, "op": "hello"}));
    s.send(json!({"id": 2, "op": "run.stop", "run_id": "ghost"}));
    s.send(json!({"id": 3, "op": "hello"}));
    let (third, _, _) = s.wait_reply(3);
    let (first, _, _) = s.wait_reply(1);
    let (second, _, refused) = s.wait_reply(2);
    assert_eq!((first, second, third), (0, 1, 2));
    assert_eq!(refused["error"]["code"], "no_such_run");
    assert_eq!(s.finish(), 0);
}

#[test]
fn a_stopped_run_is_gone_for_the_next_request_and_its_id_can_start_again() {
    let s = Served::new();
    s.start_long(1, "gone");
    s.send(json!({"id": 2, "op": "run.stop", "run_id": "gone", "close_timeout_ms": 0}));
    s.send(json!({"id": 3, "op": "run.output", "run_id": "gone"}));
    s.send(json!({"id": 4, "op": "run.list"}));
    s.send(json!({"id": 5, "op": "run.close", "run_id": "gone"}));
    let (_, _, output) = s.wait_reply(3);
    assert_eq!(output["error"]["code"], "no_such_run", "{output}");
    let (_, _, listed) = s.wait_reply(4);
    assert_eq!(listed["result"]["runs"], json!([]));
    let (_, _, closed) = s.wait_reply(5);
    assert_eq!(closed["error"]["code"], "no_such_run");
    s.start_long(6, "gone");
    s.wait_reply(2);
    s.send(json!({"id": 7, "op": "run.stop", "run_id": "gone", "close_timeout_ms": 0}));
    s.wait_reply(7);
    assert_eq!(s.finish(), 0);
}

#[test]
fn shutdown_writes_the_reply_of_a_stop_in_flight_before_its_own() {
    let s = Served::new();
    let pid = s.start_long(1, "mid");
    s.send(json!({"id": 2, "op": "run.stop", "run_id": "mid", "close_timeout_ms": 3000}));
    s.send(json!({"id": 3, "op": "shutdown"}));
    let (shutdown_at, _, _) = s.wait_reply(3);
    // The reply of the stop is out by the time the shutdown reply is: the session joined it first.
    let (stop_at, _, stopped) = s
        .reply(2)
        .expect("the stop reply is written before shutdown's");
    assert!(
        stop_at < shutdown_at,
        "stop at {stop_at}, shutdown at {shutdown_at}"
    );
    assert_eq!(stopped["result"]["how"], "ended");
    assert_eq!(s.finish(), 0);
    assert!(process_gone(pid, Duration::from_secs(5)));
}

#[test]
fn the_end_of_input_ends_the_job_of_a_stop_in_flight() {
    let s = Served::new();
    let pid = s.start_long(1, "eof");
    s.send(json!({"id": 2, "op": "run.stop", "run_id": "eof", "close_timeout_ms": 10000}));
    assert_eq!(s.finish(), 0);
    assert!(process_gone(pid, Duration::from_secs(5)));
}
