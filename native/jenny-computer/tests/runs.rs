//! Runs, the window list and window geometry on a real Windows system, with console children only.
//!
//! new-test-file: a different lane from tests/cli.rs (the built binary over pipes); these drive the
//! library directly so each test can read the run's events from a memory sink.

#![cfg(windows)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::{Duration, Instant};

use jenny_computer::dispatch::Context;
use jenny_computer::events::{Emitter, MemorySink};
use jenny_computer::job::Runs;
use jenny_computer::protocol::{parse_request, ErrorCode, ProtoError, Request};
use jenny_computer::{geometry, window_list};
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

fn req(value: Value) -> Request {
    parse_request(&value.to_string()).unwrap()
}

struct Session {
    sink: MemorySink,
    runs: Runs,
}

impl Session {
    fn new() -> Self {
        let sink = MemorySink::default();
        let runs = Runs::new(Emitter::new(Box::new(sink.clone())));
        Self { sink, runs }
    }

    fn start_cmd(&mut self, run_id: &str, cmd_args: &[&str]) -> Result<Value, ProtoError> {
        let mut args = vec!["/c"];
        args.extend_from_slice(cmd_args);
        self.start(json!({
            "id": 1, "op": "run.start", "run_id": run_id, "program": cmd_exe(),
            "args": args, "cwd": system32(),
            "env": {"SystemRoot": std::env::var("SystemRoot").unwrap_or_default(), "PATH": system32()},
        }))
    }

    /// Start as the serve loop does: the monitor starts after the reply is out.
    fn start(&mut self, value: Value) -> Result<Value, ProtoError> {
        let started = self.runs.start(&req(value));
        self.runs.start_monitors();
        started
    }

    fn events(&self, name: &str) -> Vec<Value> {
        self.sink
            .text()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["event"] == name)
            .collect()
    }

    fn list(&mut self) -> Value {
        self.runs.list().unwrap()
    }
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

fn pid_of(started: &Value) -> u32 {
    started["pid"].as_u64().unwrap() as u32
}

#[test]
fn a_short_command_reports_its_pid_output_and_one_exit() {
    let mut s = Session::new();
    let started = s.start_cmd("hello", &["echo", "hello"]).unwrap();
    assert!(pid_of(&started) > 0);
    assert_eq!(started["run_id"], "hello");
    wait_until("run.exited", || !s.events("run.exited").is_empty());
    let exits = s.events("run.exited");
    assert_eq!(exits.len(), 1);
    assert_eq!(exits[0]["run_id"], "hello");
    assert_eq!(exits[0]["exit_code"], 0);
    let out = s
        .runs
        .output(&req(
            json!({"id": 2, "op": "run.output", "run_id": "hello"}),
        ))
        .unwrap();
    let lines: Vec<&str> = out["lines"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(lines.contains(&"hello"), "{lines:?}");
    assert_eq!(out["dropped_bytes"], 0);
    let listed = s.list();
    assert_eq!(listed["runs"][0]["state"], "exited");
    assert_eq!(listed["runs"][0]["exit_code"], 0);
    // An exited run has no process left in its job.
    assert_eq!(listed["runs"][0]["pids"], json!([]));
    assert_eq!(listed["runs"][0]["hwnd"], Value::Null);
    // No window ever opened for a console child, and the exit event stays single after a stop.
    assert!(s.events("run.window").is_empty());
    let stopped = s
        .runs
        .stop(&req(json!({"id": 3, "op": "run.stop", "run_id": "hello"})))
        .unwrap();
    assert_eq!(stopped["how"], "already_ended");
    assert_eq!(stopped["exit_code"], 0);
    assert_eq!(s.events("run.exited").len(), 1);
    assert_eq!(
        s.runs
            .output(&req(
                json!({"id": 4, "op": "run.output", "run_id": "hello"})
            ))
            .unwrap_err()
            .code,
        ErrorCode::NoSuchRun
    );
}

#[test]
fn a_long_console_child_without_a_window_is_ended_by_stop() {
    let mut s = Session::new();
    let started = s
        .start_cmd("long", &["ping", "-n", "30", "127.0.0.1"])
        .unwrap();
    let pid = pid_of(&started);
    assert!(!process_gone(pid, Duration::from_millis(0)));
    assert_eq!(s.list()["runs"][0]["state"], "starting");
    let began = Instant::now();
    let stopped = s
        .runs
        .stop(&req(
            json!({"id": 2, "op": "run.stop", "run_id": "long", "close_timeout_ms": 500}),
        ))
        .unwrap();
    assert!(began.elapsed() < Duration::from_secs(10));
    assert_eq!(stopped["how"], "ended");
    assert_eq!(stopped["run_id"], "long");
    assert!(process_gone(pid, Duration::from_secs(5)));
    assert_eq!(s.events("run.exited").len(), 1);
    assert_eq!(s.list(), json!({"runs": []}));
}

#[test]
fn a_listed_run_names_the_processes_in_its_job() {
    let mut s = Session::new();
    let started = s
        .start_cmd("pidset", &["ping", "-n", "30", "127.0.0.1"])
        .unwrap();
    let pid = pid_of(&started);
    let listed = s.list();
    let pids: Vec<u64> = listed["runs"][0]["pids"]
        .as_array()
        .expect("pids is an array")
        .iter()
        .map(|p| p.as_u64().unwrap())
        .collect();
    assert!(pids.contains(&u64::from(pid)), "{pids:?}");
    s.runs.end_all_now();
}

#[test]
fn close_asks_nothing_of_a_run_without_a_window() {
    let mut s = Session::new();
    s.start_cmd("c1", &["ping", "-n", "30", "127.0.0.1"])
        .unwrap();
    let asked = s
        .runs
        .close(&req(json!({"id": 2, "op": "run.close", "run_id": "c1"})))
        .unwrap();
    assert_eq!(asked, json!({"run_id": "c1", "asked": false}));
    assert_eq!(
        s.runs
            .close(&req(json!({"id": 3, "op": "run.close", "run_id": "nope"})))
            .unwrap_err()
            .code,
        ErrorCode::NoSuchRun
    );
    // The run is untouched by a close that had no window to ask.
    assert_eq!(s.list()["runs"][0]["state"], "starting");
    s.runs
        .stop(&req(
            json!({"id": 4, "op": "run.stop", "run_id": "c1", "close_timeout_ms": 0}),
        ))
        .unwrap();
    // An exited run is not asked either.
    s.start_cmd("c2", &["echo", "x"]).unwrap();
    wait_until("c2 exit", || s.events("run.exited").len() == 2);
    let asked = s
        .runs
        .close(&req(json!({"id": 5, "op": "run.close", "run_id": "c2"})))
        .unwrap();
    assert_eq!(asked["asked"], false);
}

#[test]
fn bad_starts_answer_the_right_errors() {
    let mut s = Session::new();
    let base = |program: &str, args: Value, run_id: &str| {
        json!({"id": 1, "op": "run.start", "run_id": run_id, "program": program,
               "args": args, "cwd": system32(), "env": {}})
    };
    let code = |s: &mut Session, v: Value| s.start(v).unwrap_err().code;
    assert_eq!(
        code(&mut s, base("cmd.exe", json!([]), "a")),
        ErrorCode::BadRequest
    );
    assert_eq!(
        code(&mut s, base(r"C:\no\such\program.exe", json!([]), "a")),
        ErrorCode::BadRequest
    );
    assert_eq!(
        code(&mut s, base(&system32(), json!([]), "a")),
        ErrorCode::BadRequest
    );
    assert_eq!(
        code(&mut s, base(&cmd_exe(), json!(["a\u{0}b"]), "a")),
        ErrorCode::BadRequest
    );
    assert_eq!(
        code(&mut s, base(&cmd_exe(), json!([1]), "a")),
        ErrorCode::BadRequest
    );
    assert_eq!(
        code(&mut s, base(&cmd_exe(), json!([]), "bad id")),
        ErrorCode::BadRequest
    );
    let mut relative_cwd = base(&cmd_exe(), json!([]), "a");
    relative_cwd["cwd"] = json!("somewhere");
    assert_eq!(code(&mut s, relative_cwd), ErrorCode::BadRequest);
    let mut bad_env = base(&cmd_exe(), json!([]), "a");
    bad_env["env"] = json!({"A=B": "1"});
    assert_eq!(code(&mut s, bad_env), ErrorCode::BadRequest);
    // None of the refused starts left a run behind.
    assert_eq!(s.list(), json!({"runs": []}));

    s.start_cmd("dup", &["ping", "-n", "30", "127.0.0.1"])
        .unwrap();
    assert_eq!(
        s.start_cmd("dup", &["echo", "again"]).unwrap_err().code,
        ErrorCode::RunExists
    );
    assert_eq!(
        s.runs
            .stop(&req(json!({"id": 9, "op": "run.stop", "run_id": "ghost"})))
            .unwrap_err()
            .code,
        ErrorCode::NoSuchRun
    );
    s.runs.end_all_now();
}

#[test]
fn an_exited_run_is_replaced_by_a_new_start_with_its_id() {
    let mut s = Session::new();
    s.start_cmd("again", &["echo", "one"]).unwrap();
    wait_until("first exit", || s.events("run.exited").len() == 1);
    s.start_cmd("again", &["echo", "two"]).unwrap();
    wait_until("second exit", || s.events("run.exited").len() == 2);
    let out = s
        .runs
        .output(&req(
            json!({"id": 2, "op": "run.output", "run_id": "again"}),
        ))
        .unwrap();
    let text = out["lines"].to_string();
    assert!(text.contains("two") && !text.contains("one"), "{text}");
    assert_eq!(s.list()["runs"].as_array().unwrap().len(), 1);
}

#[test]
fn a_window_that_does_not_exist_is_refused_by_geometry_and_show() {
    let g =
        geometry::geometry(&req(json!({"id": 1, "op": "window.geometry", "hwnd": 1}))).unwrap_err();
    assert_eq!(g.code, ErrorCode::NoSuchWindow);
    for mode in ["front", "behind"] {
        let s = window_list::show(&req(
            json!({"id": 1, "op": "window.show", "hwnd": 1, "mode": mode}),
        ))
        .unwrap_err();
        assert_eq!(s.code, ErrorCode::NoSuchWindow);
    }
}

#[test]
fn the_window_list_has_windows_and_a_run_without_windows_has_none() {
    let sink = MemorySink::default();
    let mut ctx = Context::new(Emitter::new(Box::new(sink)));
    let all = window_list::list(&mut ctx, &req(json!({"id": 1, "op": "windows.list"}))).unwrap();
    let windows = all["windows"].as_array().unwrap();
    assert!(!windows.is_empty());
    let first = &windows[0];
    for key in [
        "hwnd",
        "pid",
        "title",
        "class",
        "visible",
        "cloaked",
        "tool_window",
        "bounds",
    ] {
        assert!(first.get(key).is_some(), "{key}");
    }
    // Every top-level window has a class name (row 196's dialog check reads it).
    assert!(windows
        .iter()
        .all(|w| w["class"].as_str().is_some_and(|c| !c.is_empty())));
    let hwnd = windows
        .iter()
        .find(|w| w["visible"] == true && w["bounds"]["width"].as_i64().unwrap_or(0) > 0)
        .map(|w| w["hwnd"].as_u64().unwrap());
    if let Some(hwnd) = hwnd {
        let geo = geometry::geometry(&req(
            json!({"id": 2, "op": "window.geometry", "hwnd": hwnd}),
        ));
        // A window can vanish between the two calls; otherwise the shape is the documented one.
        if let Ok(geo) = geo {
            for key in [
                "window",
                "bounds",
                "client",
                "offset",
                "dpi",
                "scale",
                "minimized",
            ] {
                assert!(geo.get(key).is_some(), "{key}");
            }
            assert!(geo["dpi"].as_u64().unwrap() > 0);
        }
    }

    let started = ctx
        .runs
        .start(&req(json!({
            "id": 3, "op": "run.start", "run_id": "w", "program": cmd_exe(),
            "args": ["/c", "ping", "-n", "30", "127.0.0.1"], "cwd": system32(),
            "env": {"SystemRoot": std::env::var("SystemRoot").unwrap_or_default(), "PATH": system32()},
        })))
        .unwrap();
    assert!(started["pid"].as_u64().unwrap() > 0);
    let own = window_list::list(
        &mut ctx,
        &req(json!({"id": 4, "op": "windows.list", "run_id": "w"})),
    )
    .unwrap();
    assert_eq!(own["windows"], json!([]));
    let missing = window_list::list(
        &mut ctx,
        &req(json!({"id": 5, "op": "windows.list", "run_id": "zz"})),
    )
    .unwrap_err();
    assert_eq!(missing.code, ErrorCode::NoSuchRun);
    let bad = window_list::list(
        &mut ctx,
        &req(json!({"id": 6, "op": "windows.list", "run_id": "a b"})),
    )
    .unwrap_err();
    assert_eq!(bad.code, ErrorCode::BadRequest);
    ctx.runs.end_all_now();
}

#[test]
fn ending_everything_now_leaves_no_child_alive() {
    let mut s = Session::new();
    let pids: Vec<u32> = (0..2)
        .map(|n| {
            pid_of(
                &s.start_cmd(&format!("k{n}"), &["ping", "-n", "30", "127.0.0.1"])
                    .unwrap(),
            )
        })
        .collect();
    for pid in &pids {
        assert!(!process_gone(*pid, Duration::from_millis(0)));
    }
    let began = Instant::now();
    s.runs.end_all_now();
    assert!(began.elapsed() < Duration::from_secs(10));
    for pid in &pids {
        assert!(process_gone(*pid, Duration::from_secs(5)), "pid {pid}");
    }
    assert_eq!(s.list(), json!({"runs": []}));
}

#[test]
fn shutdown_stops_runs_in_parallel_in_about_one_timeout() {
    let mut s = Session::new();
    let pids: Vec<u32> = (0..3)
        .map(|n| {
            pid_of(
                &s.start_cmd(&format!("p{n}"), &["ping", "-n", "30", "127.0.0.1"])
                    .unwrap(),
            )
        })
        .collect();
    let began = Instant::now();
    s.runs.shutdown_all();
    assert!(
        began.elapsed() < Duration::from_secs(8),
        "{:?}",
        began.elapsed()
    );
    for pid in &pids {
        assert!(process_gone(*pid, Duration::from_secs(5)));
    }
    assert_eq!(s.events("run.exited").len(), 3);
}
