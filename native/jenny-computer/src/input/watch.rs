//! The owner's watch: one thread that does nothing but hold the low-level keyboard and mouse hooks and the
//! Stop chord, and a notifier thread that does the slow work. The hook callbacks only read the event, set
//! atomics and signal an event object, then always pass the event on: Windows silently removes a hook that
//! takes about a second, so they never lock, write, allocate or wait.

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::Instant;

use serde_json::{Map, Value};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentThreadId, SetEvent, WaitForSingleObject, INFINITE,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG,
    MSLLHOOKSTRUCT, PM_NOREMOVE, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_HOTKEY, WM_KEYDOWN,
    WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_QUIT,
    WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_USER, WM_XBUTTONDOWN,
};

use super::args::WatchSettings;
use super::check::{Chord, Gate};
use super::inject;
use super::keys::virtual_key;
use super::movement::MoveTrack;
use crate::events::Emitter;
use crate::protocol::{ErrorCode, ProtoError};

/// The id the Stop chord is registered under (any value below 0xC000).
const HOTKEY_ID: i32 = 0x4A43;

const KIND_KEY: u8 = 1;
const KIND_BUTTON: u8 = 2;
const KIND_MOVE: u8 = 3;

/// A watch is running (from a successful start to the start of its stop).
static RUNNING: AtomicBool = AtomicBool::new(false);
/// The owner's-input latch, set by the hooks and the Stop chord, cleared by `watch.resume`.
static LATCHED: AtomicBool = AtomicBool::new(false);
/// One plus the time of the last real input in ms since [`EPOCH`]; 0 when none since `watch.start`.
static LAST_REAL: AtomicU64 = AtomicU64::new(0);
static MOVE_PX: AtomicU32 = AtomicU32::new(18);
static MOVE_MS: AtomicU32 = AtomicU32::new(200);
/// The kind that set the latch, for the notifier; 0 when there is nothing to report.
static PENDING: AtomicU8 = AtomicU8::new(0);
/// Stop chord presses the notifier has not reported yet.
static CHORDS: AtomicU32 = AtomicU32::new(0);
/// The notifier's wake-up event; null when no watch is running.
static WAKE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
/// One watch per process: the hooks and these atomics are process-wide.
static CLAIMED: AtomicBool = AtomicBool::new(false);
static EPOCH: OnceLock<Instant> = OnceLock::new();

thread_local! {
    /// Real pointer positions, touched only by the mouse hook on the watch thread.
    static TRACK: RefCell<MoveTrack> = const { RefCell::new(MoveTrack::new()) };
}

fn now_ms() -> u64 {
    EPOCH
        .get()
        .map_or(0, |epoch| epoch.elapsed().as_millis() as u64)
}

/// What the watch says right now, for the check.
pub fn gate() -> Gate {
    Gate {
        watch_running: RUNNING.load(Ordering::Acquire),
        owner_active: LATCHED.load(Ordering::Acquire),
    }
}

/// `watch.resume`: input is allowed again.
pub fn resume() {
    LATCHED.store(false, Ordering::Release);
}

/// How long ago the owner last gave real input, since the watch started.
pub fn last_real_input_ms() -> Option<u64> {
    match LAST_REAL.load(Ordering::Acquire) {
        0 => None,
        stamp => Some(now_ms().saturating_sub(stamp - 1)),
    }
}

fn wake() {
    let event = WAKE.load(Ordering::Acquire);
    if !event.is_null() {
        // SAFETY: the event stays open while it is published in `WAKE`; signalling never blocks.
        unsafe { SetEvent(event) };
    }
}

fn latch(kind: u8) {
    if LATCHED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        PENDING.store(kind, Ordering::Release);
        wake();
    }
}

fn stamp() {
    LAST_REAL.store(now_ms() + 1, Ordering::Release);
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam != 0 {
        // SAFETY: for HC_ACTION Windows passes a pointer to a KBDLLHOOKSTRUCT valid during this call.
        let info = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
        if info.flags & LLKHF_INJECTED == 0 {
            stamp();
            let message = wparam as u32;
            if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
                latch(KIND_KEY);
            }
        }
    }
    // SAFETY: the hook's own arguments are passed on, as every hook must.
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam != 0 {
        // SAFETY: for HC_ACTION Windows passes a pointer to an MSLLHOOKSTRUCT valid during this call.
        let info = unsafe { &*(lparam as *const MSLLHOOKSTRUCT) };
        let message = wparam as u32;
        if info.flags & LLMHF_INJECTED != 0 {
            // The pointer jumped by injected input: earlier real positions say nothing about the hand.
            if message == WM_MOUSEMOVE {
                let _ = TRACK.try_with(|t| t.try_borrow_mut().map(|mut t| t.clear()));
            }
        } else {
            stamp();
            match message {
                // A real wheel turn is the owner taking over too; it reports as a button.
                WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
                | WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
                    latch(KIND_BUTTON);
                }
                WM_MOUSEMOVE => {
                    let px = MOVE_PX.load(Ordering::Relaxed);
                    let ms = MOVE_MS.load(Ordering::Relaxed);
                    let t = now_ms();
                    let far = TRACK
                        .try_with(|track| {
                            track
                                .try_borrow_mut()
                                .is_ok_and(|mut track| track.real(t, info.pt.x, info.pt.y, px, ms))
                        })
                        .unwrap_or(false);
                    if far {
                        latch(KIND_MOVE);
                    }
                }
                _ => {}
            }
        }
    }
    // SAFETY: the hook's own arguments are passed on, as every hook must.
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

/// The watch thread: hooks, the Stop chord and a message loop until `WM_QUIT`.
fn hook_thread(ready: mpsc::Sender<Result<(u32, bool), ()>>, mods: u32, vk: u32) {
    // SAFETY: MSG is a plain struct; all-zero is valid.
    let mut msg: MSG = unsafe { std::mem::zeroed() };
    // SAFETY: `msg` is a valid out pointer. Peeking creates this thread's message queue, so the
    // `WM_QUIT` posted by `stop` cannot be lost.
    unsafe {
        PeekMessageW(
            &mut msg,
            std::ptr::null_mut(),
            WM_USER,
            WM_USER,
            PM_NOREMOVE,
        )
    };
    // SAFETY: plain calls; the hook procedures live for the whole program and match HOOKPROC.
    let (thread_id, keyboard, mouse) = unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        (
            GetCurrentThreadId(),
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0),
            SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0),
        )
    };
    if keyboard.is_null() || mouse.is_null() {
        // SAFETY: only hooks this thread installed are removed, each once.
        unsafe {
            if !keyboard.is_null() {
                UnhookWindowsHookEx(keyboard);
            }
            if !mouse.is_null() {
                UnhookWindowsHookEx(mouse);
            }
        }
        let _ = ready.send(Err(()));
        return;
    }
    // SAFETY: a thread hot key (no window); a chord another program holds makes the call fail.
    let registered =
        unsafe { RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, mods | MOD_NOREPEAT, vk) } != 0;
    let _ = ready.send(Ok((thread_id, registered)));
    loop {
        // SAFETY: `msg` is a valid out pointer; 0 is WM_QUIT and -1 an error, both end the loop.
        let got = unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) };
        if got == 0 || got == -1 {
            break;
        }
        if msg.message == WM_HOTKEY && msg.wParam == HOTKEY_ID as usize {
            LATCHED.store(true, Ordering::Release);
            CHORDS.fetch_add(1, Ordering::AcqRel);
            wake();
        }
    }
    // SAFETY: what this thread registered and installed is removed by this thread, once.
    unsafe {
        if registered {
            UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
        }
        UnhookWindowsHookEx(keyboard);
        UnhookWindowsHookEx(mouse);
    }
}

fn event(emitter: &Emitter, name: &str, kind: Option<&str>) {
    let mut fields = Map::new();
    if let Some(kind) = kind {
        fields.insert("kind".to_owned(), Value::String(kind.to_owned()));
    }
    let _ = emitter.event(name, fields);
}

/// The notifier: lets go of held input and reports, each time the hooks or the Stop chord signal.
fn notifier(wake_event: usize, stop: Arc<AtomicBool>, emitter: Emitter) {
    loop {
        // SAFETY: the event stays open until this thread has been joined.
        unsafe { WaitForSingleObject(wake_event as HANDLE, INFINITE) };
        let kind = PENDING.swap(0, Ordering::AcqRel);
        let chords = CHORDS.swap(0, Ordering::AcqRel);
        if kind != 0 || chords != 0 {
            inject::release_all();
        }
        let name = match kind {
            KIND_KEY => Some("key"),
            KIND_BUTTON => Some("button"),
            KIND_MOVE => Some("move"),
            _ => None,
        };
        if name.is_some() {
            event(&emitter, "watch.owner_input", name);
        }
        for _ in 0..chords {
            event(&emitter, "watch.stop_chord", None);
        }
        if stop.load(Ordering::Acquire) {
            break;
        }
    }
}

fn internal(message: &str) -> ProtoError {
    ProtoError::new(ErrorCode::Internal, message)
}

/// A running watch. Dropping it stops it: the thread unhooks and unregisters itself and is joined.
pub struct Watch {
    pub chord: Chord,
    pub registered: bool,
    thread: Option<JoinHandle<()>>,
    thread_id: u32,
    notifier: Option<JoinHandle<()>>,
    notifier_stop: Arc<AtomicBool>,
    wake_event: usize,
}

impl Watch {
    /// Start the watch. The latch keeps its value; the last real input is forgotten.
    pub fn start(emitter: Emitter, settings: &WatchSettings) -> Result<Self, ProtoError> {
        let chord = &settings.stop_chord;
        let vk = virtual_key(chord.key)
            .map(u32::from)
            .ok_or_else(|| internal("the Stop chord has no key"))?;
        let mods = [
            (chord.ctrl, MOD_CONTROL),
            (chord.shift, MOD_SHIFT),
            (chord.alt, MOD_ALT),
        ]
        .into_iter()
        .filter(|(on, _)| *on)
        .fold(0, |acc, (_, m)| acc | m);
        if CLAIMED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(internal("another watch is running in this process"));
        }
        let mut watch = Watch {
            chord: chord.clone(),
            registered: false,
            thread: None,
            thread_id: 0,
            notifier: None,
            notifier_stop: Arc::new(AtomicBool::new(false)),
            wake_event: 0,
        };
        EPOCH.get_or_init(Instant::now);
        MOVE_PX.store(settings.move_px, Ordering::Release);
        MOVE_MS.store(settings.move_ms, Ordering::Release);
        LAST_REAL.store(0, Ordering::Release);
        PENDING.store(0, Ordering::Release);
        CHORDS.store(0, Ordering::Release);
        // SAFETY: an unnamed auto-reset event with default security, not signalled.
        let wake_event = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        if wake_event.is_null() {
            return Err(internal("the owner's watch could not create its event"));
        }
        watch.wake_event = wake_event as usize;
        WAKE.store(wake_event, Ordering::Release);

        let stop = Arc::clone(&watch.notifier_stop);
        let handle = watch.wake_event;
        watch.notifier = Some(
            std::thread::Builder::new()
                .name("jenny-computer watch notifier".to_owned())
                .spawn(move || notifier(handle, stop, emitter))
                .map_err(|_| internal("the owner's watch could not start its notifier"))?,
        );
        let (tx, rx) = mpsc::channel();
        watch.thread = Some(
            std::thread::Builder::new()
                .name("jenny-computer watch".to_owned())
                .spawn(move || hook_thread(tx, mods, vk))
                .map_err(|_| internal("the owner's watch could not start its thread"))?,
        );
        match rx.recv() {
            Ok(Ok((thread_id, registered))) => {
                watch.thread_id = thread_id;
                watch.registered = registered;
            }
            _ => return Err(internal("the owner's watch could not hold its hooks")),
        }
        RUNNING.store(true, Ordering::Release);
        Ok(watch)
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            if self.thread_id != 0 {
                // SAFETY: a post to a thread whose queue exists (it was created before the id was sent).
                unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
                let _ = thread.join();
            } else if thread.is_finished() {
                let _ = thread.join();
            }
        }
        self.notifier_stop.store(true, Ordering::Release);
        if let Some(notifier) = self.notifier.take() {
            wake();
            let _ = notifier.join();
        }
        WAKE.store(std::ptr::null_mut(), Ordering::Release);
        if self.wake_event != 0 {
            // SAFETY: the event this watch created, closed once, after every user of it has ended.
            unsafe { CloseHandle(self.wake_event as HANDLE) };
        }
        CLAIMED.store(false, Ordering::Release);
    }
}
