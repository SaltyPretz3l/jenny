//! The owner-run input set (row 196 S1): real input into a window this test makes and shows. Every test
//! here moves the real pointer, presses real keys or brings a window to the front, so every one is
//! `#[ignore]` and runs only with the owner's go, at the PC, hands off the keyboard and mouse unless a test
//! says otherwise:
//!
//! `cargo test --release --locked --test input_live -- --ignored --test-threads=1`
//!
//! new-test-file: a different lane from tests/input.rs (that set injects nothing and runs anywhere; this
//! one needs the owner at the PC).

#![cfg(all(windows, feature = "input"))]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::sync::{mpsc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use jenny_computer::dispatch::{handle, Context, Reply};
use jenny_computer::events::{Emitter, MemorySink};
use jenny_computer::protocol::{parse_request, ErrorCode, ProtoError};
use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyState, VK_CONTROL, VK_LBUTTON, VK_LEFT, VK_MBUTTON, VK_MENU,
    VK_RBUTTON, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetAncestor,
    GetForegroundWindow, GetMessageW, PostQuitMessage, PostThreadMessageW, RegisterClassW,
    ShowWindow, TranslateMessage, GA_ROOT, MSG, SW_MINIMIZE, WM_APP, WM_CHAR, WM_DESTROY,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WNDCLASSW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

static TURN: Mutex<()> = Mutex::new(());

fn turn() -> MutexGuard<'static, ()> {
    TURN.lock().unwrap_or_else(|p| p.into_inner())
}

/// What the test window received.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rec {
    Down(i32, i32),
    Up(i32, i32),
    RightDown(i32, i32),
    RightUp(i32, i32),
    Char(u32),
    Key { vk: u32, ctrl: bool },
    Wheel(i32),
}

static RECORDS: Mutex<Vec<Rec>> = Mutex::new(Vec::new());

fn records() -> Vec<Rec> {
    std::mem::take(&mut *RECORDS.lock().unwrap_or_else(|p| p.into_inner()))
}

fn word(v: isize, shift: u32) -> i32 {
    i32::from(((v >> shift) & 0xFFFF) as u16 as i16)
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let at = (word(lparam, 0), word(lparam, 16));
    let rec = match msg {
        WM_LBUTTONDOWN => Some(Rec::Down(at.0, at.1)),
        WM_LBUTTONUP => Some(Rec::Up(at.0, at.1)),
        WM_RBUTTONDOWN => Some(Rec::RightDown(at.0, at.1)),
        WM_RBUTTONUP => Some(Rec::RightUp(at.0, at.1)),
        WM_CHAR => Some(Rec::Char(wparam as u32)),
        // SAFETY: reads this thread's key state as of this message.
        WM_KEYDOWN => Some(Rec::Key {
            vk: wparam as u32,
            ctrl: unsafe { GetKeyState(i32::from(VK_CONTROL)) } < 0,
        }),
        WM_MOUSEWHEEL => Some(Rec::Wheel(word(wparam as isize, 16))),
        WM_DESTROY => {
            // SAFETY: ends this window thread's message loop.
            unsafe { PostQuitMessage(0) };
            None
        }
        _ => None,
    };
    if let Some(rec) = rec {
        RECORDS.lock().unwrap_or_else(|p| p.into_inner()).push(rec);
    }
    // SAFETY: every message is passed on to the default procedure.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A visible window of this test on a thread of its own with a message loop.
struct Live {
    hwnd: u64,
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl Live {
    fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let class = wide("JennyComputerLiveTest");
            let title = wide("jenny-computer live input test");
            // SAFETY: a class with a valid procedure and name, registered once per process (a second
            // registration fails harmlessly); the window is destroyed on this thread.
            unsafe {
                let instance = GetModuleHandleW(std::ptr::null());
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(window_proc),
                    hInstance: instance,
                    lpszClassName: class.as_ptr(),
                    ..Default::default()
                };
                RegisterClassW(&wc);
                let hwnd = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    title.as_ptr(),
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    200,
                    200,
                    640,
                    400,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                tx.send((hwnd as usize as u64, GetCurrentThreadId()))
                    .unwrap();
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    if msg.message == WM_APP {
                        DestroyWindow(hwnd);
                        continue;
                    }
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });
        let (hwnd, thread_id) = rx.recv().unwrap();
        assert_ne!(hwnd, 0, "the test window was not created");
        std::thread::sleep(Duration::from_millis(300));
        records();
        Self {
            hwnd,
            thread_id,
            thread: Some(thread),
        }
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        // SAFETY: asks the window's own thread to destroy it and end its loop.
        unsafe { PostThreadMessageW(self.thread_id, WM_APP, 0, 0) };
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct Session {
    ctx: Context,
    sink: MemorySink,
}

impl Session {
    fn new() -> Self {
        let sink = MemorySink::default();
        let ctx = Context::new(Emitter::new(Box::new(sink.clone())));
        Self { ctx, sink }
    }

    fn call(&mut self, request: Value) -> Result<Value, ProtoError> {
        let req = parse_request(&request.to_string()).unwrap();
        match handle(&mut self.ctx, &req) {
            (Reply::Now(result), _) => result,
            (Reply::Later, _) => panic!("answered later"),
        }
    }

    fn ok(&mut self, request: Value) -> Value {
        self.call(request.clone())
            .unwrap_or_else(|e| panic!("{request}: {e:?}"))
    }

    /// Clear the latch, then ask.
    fn input(&mut self, request: Value) -> Result<Value, ProtoError> {
        self.ok(json!({"id": 90, "op": "watch.resume"}));
        self.call(request)
    }

    fn events(&self, name: &str) -> Vec<Value> {
        self.sink
            .text()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|v| v["event"] == name)
            .collect()
    }

    /// Picture point (scale 1) of a client-area point of the window.
    fn picture(&mut self, hwnd: u64, cx: i32, cy: i32) -> Value {
        let g = self.ok(json!({"id": 80, "op": "window.geometry", "hwnd": hwnd}));
        let bx = g["bounds"]["x"].as_i64().unwrap() as i32;
        let by = g["bounds"]["y"].as_i64().unwrap() as i32;
        let x = g["client"]["x"].as_i64().unwrap() as i32 + cx - bx;
        let y = g["client"]["y"].as_i64().unwrap() as i32 + cy - by;
        json!({"x": x, "y": y})
    }

    /// Nothing is held: not by the helper's record, not as Windows sees the keys and buttons.
    fn assert_nothing_held(&mut self) {
        assert_eq!(
            self.ok(json!({"id": 91, "op": "input.release_all"})),
            json!({"released": 0})
        );
        for vk in [
            VK_SHIFT, VK_CONTROL, VK_MENU, VK_LBUTTON, VK_RBUTTON, VK_MBUTTON,
        ] {
            // SAFETY: a plain query of one key's state.
            let state = unsafe { GetAsyncKeyState(i32::from(vk)) };
            assert!(state >= 0, "virtual key {vk:#x} is still down");
        }
    }
}

fn this_exe() -> String {
    std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn expect(hwnd: u64) -> Value {
    json!({"hwnd": hwnd, "program": this_exe(), "deny_pids": [], "deny_programs": []})
}

fn front_root() -> u64 {
    // SAFETY: plain queries.
    unsafe { GetAncestor(GetForegroundWindow(), GA_ROOT) as usize as u64 }
}

fn start_watch(s: &mut Session, chord: &str) {
    let v = s.ok(json!({"id": 1, "op": "watch.start", "stop_chord": chord}));
    println!(
        "watch started, stop_chord_registered = {}",
        v["stop_chord_registered"]
    );
}

fn wait_for(what: &str, within: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn focus(s: &mut Session, live: &Live) {
    let front = s.input(json!({"id": 2, "op": "input.focus", "expect": expect(live.hwnd)}));
    assert_eq!(front.unwrap(), json!({"front": true}));
    assert_eq!(front_root(), live.hwnd);
}

/// Repeats P3's short sitting: minimise the test window, then `input.focus` restores it and brings it to
/// the front, at the same rectangle. Brings a window to the front: owner's go only.
#[test]
#[ignore = "brings a window to the front; owner's go only"]
fn focus_brings_the_window_back_from_minimised() {
    let _turn = turn();
    let live = Live::new();
    let mut s = Session::new();
    let before =
        s.ok(json!({"id": 3, "op": "window.geometry", "hwnd": live.hwnd}))["bounds"].clone();
    // SAFETY: minimises this test's own window.
    unsafe { ShowWindow(live.hwnd as usize as HWND, SW_MINIMIZE) };
    std::thread::sleep(Duration::from_millis(500));
    start_watch(&mut s, "ctrl+alt+shift+f11");
    focus(&mut s, &live);
    let after =
        s.ok(json!({"id": 4, "op": "window.geometry", "hwnd": live.hwnd}))["bounds"].clone();
    assert_eq!(before, after);
    s.assert_nothing_held();
}

/// Repeats P3's other case: the owner clicks another window within five seconds, then `input.focus`
/// brings the test window forward. Brings a window to the front: owner's go only.
#[test]
#[ignore = "brings a window to the front and needs the owner's click; owner's go only"]
fn focus_brings_the_window_forward_from_behind() {
    let _turn = turn();
    let live = Live::new();
    let mut s = Session::new();
    println!("OWNER: click any other window within 5 seconds, then keep hands off");
    std::thread::sleep(Duration::from_secs(5));
    if front_root() == live.hwnd {
        println!("note: the test window was still in front");
    }
    start_watch(&mut s, "ctrl+alt+shift+f11");
    focus(&mut s, &live);
    s.assert_nothing_held();
}

/// A left click, a right click and a wheel turn land on the exact client pixel asked. Moves the real
/// pointer and clicks: owner's go only.
#[test]
#[ignore = "moves the real pointer and clicks; owner's go only"]
fn clicks_and_the_wheel_land_on_the_point() {
    let _turn = turn();
    let live = Live::new();
    let mut s = Session::new();
    start_watch(&mut s, "ctrl+alt+shift+f11");
    focus(&mut s, &live);
    records();
    let point = s.picture(live.hwnd, 120, 90);
    let e = expect(live.hwnd);
    s.input(json!({"id": 5, "op": "input.click", "expect": e, "scale": 1.0, "point": point}))
        .unwrap();
    s.input(
        json!({"id": 6, "op": "input.click", "expect": e, "scale": 1.0, "point": point,
                   "button": "right"}),
    )
    .unwrap();
    s.input(
        json!({"id": 7, "op": "input.scroll", "expect": e, "scale": 1.0, "point": point,
                   "dy": -1}),
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let got = records();
    assert!(got.contains(&Rec::Down(120, 90)), "{got:?}");
    assert!(got.contains(&Rec::Up(120, 90)), "{got:?}");
    assert!(got.contains(&Rec::RightDown(120, 90)), "{got:?}");
    assert!(got.contains(&Rec::RightUp(120, 90)), "{got:?}");
    assert!(got.contains(&Rec::Wheel(-120)), "{got:?}");
    s.assert_nothing_held();
}

/// A drag presses at `from` and releases at `to`, both exact. Moves the real pointer with a button down:
/// owner's go only.
#[test]
#[ignore = "drags with the real pointer; owner's go only"]
fn a_drag_presses_and_releases_where_asked() {
    let _turn = turn();
    let live = Live::new();
    let mut s = Session::new();
    start_watch(&mut s, "ctrl+alt+shift+f11");
    focus(&mut s, &live);
    records();
    let from = s.picture(live.hwnd, 40, 40);
    let to = s.picture(live.hwnd, 400, 250);
    s.input(
        json!({"id": 8, "op": "input.drag", "expect": expect(live.hwnd), "scale": 1.0,
                   "from": from, "to": to, "duration_ms": 400}),
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let got = records();
    assert!(got.contains(&Rec::Down(40, 40)), "{got:?}");
    assert!(got.contains(&Rec::Up(400, 250)), "{got:?}");
    s.assert_nothing_held();
}

/// Text arrives character by character (a tab and a line feed as their keys), a chord arrives with its
/// modifier held, and a held arrow key is let go. Presses real keys: owner's go only.
#[test]
#[ignore = "presses real keys; owner's go only"]
fn keys_and_text_reach_the_window() {
    let _turn = turn();
    let live = Live::new();
    let mut s = Session::new();
    start_watch(&mut s, "ctrl+alt+shift+f11");
    focus(&mut s, &live);
    records();
    let e = expect(live.hwnd);
    let typed = s
        .input(json!({"id": 9, "op": "input.type", "expect": e, "text": "Hé\tok\n"}))
        .unwrap();
    assert_eq!(typed, json!({"typed": 6}));
    s.input(json!({"id": 10, "op": "input.key", "expect": e, "chord": "ctrl+s"}))
        .unwrap();
    s.input(json!({"id": 11, "op": "input.key", "expect": e, "chord": "left", "hold_ms": 300}))
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let got = records();
    let chars: Vec<u32> = got
        .iter()
        .filter_map(|r| match r {
            Rec::Char(c) => Some(*c),
            _ => None,
        })
        .filter(|c| *c >= 0x20 || *c == 0x09 || *c == 0x0D)
        .collect();
    assert_eq!(chars, vec![0x48, 0xE9, 0x09, 0x6F, 0x6B, 0x0D], "{got:?}");
    assert!(
        got.contains(&Rec::Key {
            vk: 0x53,
            ctrl: true
        }),
        "{got:?}"
    );
    assert!(
        got.contains(&Rec::Key {
            vk: u32::from(VK_LEFT),
            ctrl: false
        }),
        "{got:?}"
    );
    s.assert_nothing_held();
}

/// The owner presses Ctrl+Alt+Shift+F12 within 15 seconds: the latch is set, `watch.stop_chord` comes,
/// and input is refused until `watch.resume`. Holds the owner's real Stop chord: owner's go only.
#[test]
#[ignore = "registers the owner's Stop chord and needs the owner to press it; owner's go only"]
fn the_stop_chord_latches() {
    let _turn = turn();
    let live = Live::new();
    let mut s = Session::new();
    start_watch(&mut s, "ctrl+alt+shift+f12");
    s.ok(json!({"id": 12, "op": "watch.resume"}));
    println!("OWNER: press Ctrl+Alt+Shift+F12 within 15 seconds");
    wait_for("the Stop chord", Duration::from_secs(15), || {
        !s.events("watch.stop_chord").is_empty()
    });
    let state = s.ok(json!({"id": 13, "op": "watch.state"}));
    assert_eq!(state["paused"], true);
    let point = s.picture(live.hwnd, 10, 10);
    let err = s
        .call(
            json!({"id": 14, "op": "input.move", "expect": expect(live.hwnd), "scale": 1.0,
                     "point": point}),
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Refused);
    assert_eq!(err.reason, Some("owner_active"));
    s.ok(json!({"id": 15, "op": "watch.stop"}));
    s.assert_nothing_held();
}

/// The owner moves the mouse (keys and buttons untouched) within 15 seconds: the latch is set by movement,
/// `watch.owner_input` says `"move"`, and the last real input is recent. Owner's go only.
#[test]
#[ignore = "needs the owner to move the mouse; owner's go only"]
fn the_owners_movement_latches() {
    let _turn = turn();
    let mut s = Session::new();
    start_watch(&mut s, "ctrl+alt+shift+f11");
    s.ok(json!({"id": 16, "op": "watch.resume"}));
    println!("OWNER: move the mouse a hand's width within 15 seconds; do not click or type");
    wait_for("the owner's movement", Duration::from_secs(15), || {
        !s.events("watch.owner_input").is_empty()
    });
    assert_eq!(s.events("watch.owner_input")[0]["kind"], "move");
    let state = s.ok(json!({"id": 17, "op": "watch.state"}));
    assert_eq!(state["paused"], true);
    assert!(state["last_real_input_ms"].as_u64().unwrap() < 15_000);
    s.ok(json!({"id": 18, "op": "watch.stop"}));
    s.assert_nothing_held();
}

/// The owner moves the mouse during a two-second drag: the drag stops part-way with `owner_active` and
/// the button is let go. Moves the real pointer with a button down: owner's go only.
#[test]
#[ignore = "drags with the real pointer and needs the owner to move the mouse; owner's go only"]
fn the_owner_stops_a_drag_part_way() {
    let _turn = turn();
    let live = Live::new();
    let mut s = Session::new();
    start_watch(&mut s, "ctrl+alt+shift+f11");
    focus(&mut s, &live);
    let from = s.picture(live.hwnd, 40, 40);
    let to = s.picture(live.hwnd, 500, 300);
    println!("OWNER: in 1 second a slow drag starts; move the mouse during it");
    std::thread::sleep(Duration::from_secs(1));
    let err = s
        .input(
            json!({"id": 19, "op": "input.drag", "expect": expect(live.hwnd), "scale": 1.0,
                      "from": from, "to": to, "duration_ms": 2000}),
        )
        .unwrap_err();
    assert_eq!(err.reason, Some("owner_active"), "{err:?}");
    s.ok(json!({"id": 20, "op": "watch.stop"}));
    s.assert_nothing_held();
}
