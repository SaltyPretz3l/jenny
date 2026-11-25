//! Row 196's input, watch and program operations through `dispatch::handle`, on a real Windows system,
//! injecting nothing: every input request here is refused or malformed before anything is sent, the only
//! window is a hidden one this process makes and never shows, and the watch uses a Stop chord the owner
//! does not use (Ctrl+Alt+Shift+F11).
//!
//! new-test-file: a new surface (row 196's input half); the input that does reach a window is the
//! owner-run set in tests/input_live.rs.

#![cfg(all(windows, feature = "input"))]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use jenny_computer::dispatch::{handle, Context, Reply};
use jenny_computer::events::{Emitter, MemorySink};
use jenny_computer::protocol::{parse_request, ErrorCode, ProtoError};
use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_OVERLAPPED};

/// The watch and the held keys are one per process: the tests take turns.
static TURN: Mutex<()> = Mutex::new(());

fn turn() -> MutexGuard<'static, ()> {
    TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A chord nobody uses, so the test never holds the owner's Stop chord.
const TEST_CHORD: &str = "ctrl+alt+shift+f11";

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A top-level window of this process that is never shown (no `WS_VISIBLE`, no `ShowWindow`).
struct Hidden(HWND);

impl Hidden {
    fn new() -> Self {
        let class = wide("STATIC");
        let title = wide("jenny-computer input test");
        // SAFETY: a predefined class, valid NUL-terminated strings, no parent, menu, instance or param.
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPED,
                0,
                0,
                200,
                100,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null(), "could not create the hidden window");
        Self(hwnd)
    }

    fn id(&self) -> u64 {
        self.0 as usize as u64
    }
}

impl Drop for Hidden {
    fn drop(&mut self) {
        // SAFETY: the window was created on this thread and is destroyed once.
        unsafe { DestroyWindow(self.0) };
    }
}

/// The handle of a window that existed and is gone.
fn destroyed_window() -> u64 {
    Hidden::new().id()
}

fn this_exe() -> String {
    std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn this_process_is_elevated() -> bool {
    // SAFETY: plain calls on this process's own token; the handle is checked and closed once.
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut info = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            (&raw mut info).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        CloseHandle(token);
        ok != 0 && info.TokenIsElevated != 0
    }
}

struct Session {
    ctx: Context,
}

impl Session {
    fn new() -> Self {
        let ctx = Context::new(Emitter::new(Box::new(MemorySink::default())));
        Self { ctx }
    }

    fn call(&mut self, request: Value) -> Result<Value, ProtoError> {
        let req = parse_request(&request.to_string()).unwrap();
        match handle(&mut self.ctx, &req) {
            (Reply::Now(result), _) => result,
            (Reply::Later, _) => panic!("answered later: {request}"),
        }
    }

    fn ok(&mut self, request: Value) -> Value {
        self.call(request.clone())
            .unwrap_or_else(|err| panic!("{request} failed: {err:?}"))
    }
}

fn expect(hwnd: u64) -> Value {
    json!({"hwnd": hwnd, "program": this_exe(), "deny_pids": [], "deny_programs": []})
}

/// One valid request of every input operation but `input.release_all`, aimed at `hwnd`.
fn every_input_op(hwnd: u64) -> Vec<Value> {
    let e = expect(hwnd);
    vec![
        json!({"id": 1, "op": "input.focus", "expect": e}),
        json!({"id": 2, "op": "input.move", "expect": e, "scale": 1.0, "point": {"x": 10, "y": 10}}),
        json!({"id": 3, "op": "input.click", "expect": e, "scale": 1.0, "point": {"x": 10, "y": 10},
               "button": "right", "count": 2, "modifiers": ["shift"]}),
        json!({"id": 4, "op": "input.drag", "expect": e, "scale": 1.0, "from": {"x": 5, "y": 5},
               "to": {"x": 50, "y": 20}, "duration_ms": 100}),
        json!({"id": 5, "op": "input.scroll", "expect": e, "scale": 1.0, "point": {"x": 10, "y": 10},
               "dy": -2}),
        json!({"id": 6, "op": "input.type", "expect": e, "text": "hello\tworld\n"}),
        json!({"id": 7, "op": "input.key", "expect": e, "chord": "ctrl+s", "hold_ms": 0}),
    ]
}

fn reason(result: Result<Value, ProtoError>) -> &'static str {
    let err = result.expect_err("an input operation was not refused");
    assert_eq!(err.code, ErrorCode::Refused, "{err:?}");
    err.reason.unwrap()
}

/// Ask with the latch cleared just before, again while the owner's own hand keeps setting it (they may be
/// using this PC while the tests run). `None` when the input desktop is not the owner's (a locked screen).
fn refusal_with_the_latch_clear(s: &mut Session, request: &Value) -> Option<&'static str> {
    for _ in 0..200 {
        s.ok(json!({"id": 90, "op": "watch.resume"}));
        let got = reason(s.call(request.clone()));
        match got {
            "owner_active" => std::thread::sleep(Duration::from_millis(25)),
            "secure_desktop" => {
                println!("note: the input desktop is not the owner's; skipping {request}");
                return None;
            }
            other => return Some(other),
        }
    }
    panic!("the latch never stayed clear for {request}");
}

fn bad_request(s: &mut Session, request: Value) {
    let err = s.call(request.clone()).expect_err("accepted");
    assert_eq!(err.code, ErrorCode::BadRequest, "{request}: {err:?}");
}

#[test]
fn identify_names_this_process_for_its_own_hidden_window() {
    let _turn = turn();
    let window = Hidden::new();
    let mut s = Session::new();
    let v = s.ok(json!({"id": 1, "op": "program.identify", "hwnd": window.id()}));
    assert_eq!(v["hwnd"], window.id());
    assert_eq!(v["pid"], std::process::id());
    assert_eq!(v["kind"], "desktop");
    let program = v["program"].as_str().expect("a program path");
    assert_eq!(
        program.trim_start_matches(r"\\?\").to_lowercase(),
        this_exe().trim_start_matches(r"\\?\").to_lowercase()
    );
    if this_process_is_elevated() {
        println!("note: the test process runs elevated; not checking `elevated` false");
        assert_eq!(v["elevated"], true);
    } else {
        assert_eq!(v["elevated"], false);
    }
}

#[test]
fn identify_refuses_a_handle_that_is_not_a_window() {
    let _turn = turn();
    let mut s = Session::new();
    let gone = destroyed_window();
    let err = s
        .call(json!({"id": 1, "op": "program.identify", "hwnd": gone}))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NoSuchWindow);
    let err = s
        .call(json!({"id": 2, "op": "program.identify", "hwnd": 0}))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::BadRequest);
}

#[test]
fn every_input_op_is_refused_without_the_watch() {
    let _turn = turn();
    let window = Hidden::new();
    let mut s = Session::new();
    s.ok(json!({"id": 1, "op": "watch.stop"}));
    let state = s.ok(json!({"id": 2, "op": "watch.state"}));
    assert_eq!(state["running"], false);
    for request in every_input_op(window.id()) {
        assert_eq!(reason(s.call(request.clone())), "no_watch", "{request}");
    }
}

#[test]
fn the_watch_starts_stops_restarts_and_guards_the_window() {
    let _turn = turn();
    let window = Hidden::new();
    let gone = destroyed_window();
    let mut s = Session::new();

    let started = s.ok(json!({"id": 1, "op": "watch.start", "stop_chord": TEST_CHORD}));
    let registered = started["stop_chord_registered"]
        .as_bool()
        .expect("stop_chord_registered is a bool");
    if !registered {
        println!("note: another program holds {TEST_CHORD}; the watch runs without it");
    }

    let mut clear = false;
    for _ in 0..200 {
        s.ok(json!({"id": 2, "op": "watch.resume"}));
        let state = s.ok(json!({"id": 3, "op": "watch.state"}));
        assert_eq!(state["running"], true);
        assert_eq!(state["stop_chord_registered"], registered);
        let last = &state["last_real_input_ms"];
        assert!(last.is_null() || last.is_u64(), "{state}");
        if state["paused"] == false {
            clear = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(clear, "the watch never showed a clear latch");

    for request in every_input_op(gone) {
        if let Some(got) = refusal_with_the_latch_clear(&mut s, &request) {
            assert_eq!(got, "window_gone", "{request}");
        }
    }
    // The hidden window: every operation but focus refuses it as not shown. Focus is not asked here,
    // because for a window of the granted program it would go on to ask Windows for the front.
    for request in every_input_op(window.id()).into_iter().skip(1) {
        if let Some(got) = refusal_with_the_latch_clear(&mut s, &request) {
            assert_eq!(got, "window_gone", "{request}");
        }
    }

    // A second start while running restarts with the new settings.
    let again = s.ok(
        json!({"id": 4, "op": "watch.start", "stop_chord": TEST_CHORD,
                            "move_px": 30, "move_ms": 300}),
    );
    assert!(again["stop_chord_registered"].is_boolean());
    assert_eq!(s.ok(json!({"id": 5, "op": "watch.state"}))["running"], true);

    assert_eq!(s.ok(json!({"id": 6, "op": "watch.resume"})), json!({}));
    assert_eq!(s.ok(json!({"id": 7, "op": "watch.stop"})), json!({}));
    let state = s.ok(json!({"id": 8, "op": "watch.state"}));
    assert_eq!(state["running"], false);
    assert_eq!(state["stop_chord_registered"], false);
    assert_eq!(
        reason(s.call(every_input_op(window.id())[1].clone())),
        "no_watch"
    );

    // Started again after a stop.
    s.ok(json!({"id": 9, "op": "watch.start", "stop_chord": TEST_CHORD}));
    assert_eq!(
        s.ok(json!({"id": 10, "op": "watch.state"}))["running"],
        true
    );
    assert_eq!(s.ok(json!({"id": 11, "op": "watch.stop"})), json!({}));
    assert_eq!(
        s.ok(json!({"id": 12, "op": "watch.state"}))["running"],
        false
    );
}

#[test]
fn malformed_requests_are_bad_requests_before_any_check() {
    let _turn = turn();
    let window = Hidden::new();
    let mut s = Session::new();
    let e = expect(window.id());
    let point = json!({"x": 1, "y": 1});
    bad_request(
        &mut s,
        json!({"id": 1, "op": "input.move", "expect": {"hwnd": "x"},
                               "scale": 1.0, "point": point}),
    );
    bad_request(
        &mut s,
        json!({"id": 2, "op": "input.click", "expect": {"hwnd": window.id()},
                               "scale": 1.0, "point": point}),
    );
    bad_request(&mut s, json!({"id": 3, "op": "input.focus"}));
    bad_request(
        &mut s,
        json!({"id": 4, "op": "input.key", "expect": e, "chord": "ctrl+win"}),
    );
    bad_request(
        &mut s,
        json!({"id": 5, "op": "input.key", "expect": e, "chord": "Ctrl+S"}),
    );
    bad_request(
        &mut s,
        json!({"id": 6, "op": "input.key", "expect": e, "chord": "s",
                               "hold_ms": 2001}),
    );
    bad_request(
        &mut s,
        json!({"id": 7, "op": "watch.start", "stop_chord": "ctrl+f11"}),
    );
    bad_request(
        &mut s,
        json!({"id": 8, "op": "watch.start", "stop_chord": TEST_CHORD,
                               "move_px": 7}),
    );
    bad_request(
        &mut s,
        json!({"id": 9, "op": "input.type", "expect": e, "text": "a\u{7}b"}),
    );
    bad_request(
        &mut s,
        json!({"id": 10, "op": "input.type", "expect": e, "text": ""}),
    );
    bad_request(
        &mut s,
        json!({"id": 11, "op": "input.click", "expect": e, "scale": 1.0,
                               "point": point, "count": 4}),
    );
    bad_request(
        &mut s,
        json!({"id": 12, "op": "input.click", "expect": e, "scale": 1.0,
                               "point": point, "button": "x1"}),
    );
    bad_request(
        &mut s,
        json!({"id": 13, "op": "input.click", "expect": e, "scale": 1.0,
                               "point": point, "modifiers": ["win"]}),
    );
    bad_request(
        &mut s,
        json!({"id": 14, "op": "input.drag", "expect": e, "scale": 1.0,
                               "from": point, "to": point, "duration_ms": 50}),
    );
    bad_request(
        &mut s,
        json!({"id": 15, "op": "input.scroll", "expect": e, "scale": 1.0,
                               "point": point}),
    );
    bad_request(
        &mut s,
        json!({"id": 16, "op": "input.scroll", "expect": e, "scale": 1.0,
                               "point": point, "dy": 21}),
    );
    bad_request(
        &mut s,
        json!({"id": 17, "op": "input.move", "expect": e, "scale": 5.0,
                               "point": point}),
    );
    // The watch was never started by the bad `watch.start` requests.
    assert_eq!(
        s.ok(json!({"id": 18, "op": "watch.state"}))["running"],
        false
    );
}

#[test]
fn release_all_with_nothing_held_lets_go_of_nothing() {
    let _turn = turn();
    let mut s = Session::new();
    assert_eq!(
        s.ok(json!({"id": 1, "op": "input.release_all"})),
        json!({"released": 0})
    );
}
