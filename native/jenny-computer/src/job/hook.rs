//! Window events for one chosen window: minimise, restore, move and destroy, on a thread with a message loop.

use std::cell::RefCell;
use std::mem::zeroed;
use std::ptr::{null, null_mut};
use std::sync::atomic::Ordering;
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::Threading::{GetCurrentThreadId, INFINITE};
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MsgWaitForMultipleObjectsEx, PeekMessageW, PostThreadMessageW, CHILDID_SELF, MSG,
    MWMO_INPUTAVAILABLE, OBJID_WINDOW, PM_NOREMOVE, PM_REMOVE, QS_ALLINPUT, WINEVENT_OUTOFCONTEXT,
    WM_QUIT, WM_USER,
};

use super::run::RunShared;
use super::window_events::{
    state_name, MoveThrottle, EVENT_MINIMIZE_END, EVENT_MINIMIZE_START, EVENT_OBJECT_DESTROY,
    EVENT_OBJECT_LOCATION_CHANGE, MOVE_GAP,
};

struct HookState {
    shared: Arc<RunShared>,
    hwnd: u64,
    throttle: MoveThrottle,
}

thread_local! {
    /// What the callback needs; the callback runs on the thread that installed the hooks.
    static HOOK: RefCell<Option<HookState>> = const { RefCell::new(None) };
}

/// The thread listening to one window's events.
pub struct HookThread {
    thread_id: u32,
    join: JoinHandle<()>,
}

impl HookThread {
    /// Start listening to `hwnd` (a window of process `pid`). `None` when the hooks could not be set up;
    /// the monitor then still notices the window's end by asking whether it exists.
    pub fn start(shared: Arc<RunShared>, hwnd: u64, pid: u32) -> Option<Self> {
        let (tx, rx) = sync_channel::<Option<u32>>(1);
        let join = std::thread::Builder::new()
            .name("jenny-window-events".to_owned())
            .spawn(move || hook_main(shared, hwnd, pid, tx))
            .ok()?;
        match rx.recv().ok().flatten() {
            Some(thread_id) => Some(Self { thread_id, join }),
            None => {
                let _ = join.join();
                None
            }
        }
    }

    /// Stop the message loop and wait for the thread to remove its hooks.
    pub fn stop(self) {
        // SAFETY: plain call with a thread id and a message number; a thread that already ended makes it fail.
        unsafe {
            PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
        }
        let _ = self.join.join();
    }
}

unsafe extern "system" fn on_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if id_object != OBJID_WINDOW || id_child != CHILDID_SELF as i32 {
        return;
    }
    let Some(name) = state_name(event) else {
        return;
    };
    let _ = HOOK.try_with(|cell| {
        let Ok(mut slot) = cell.try_borrow_mut() else {
            return;
        };
        let Some(state) = slot.as_mut() else {
            return;
        };
        if hwnd as usize as u64 != state.hwnd || state.shared.window_gone.load(Ordering::Acquire) {
            return;
        }
        match event {
            EVENT_OBJECT_DESTROY => {
                if !state.shared.window_gone.swap(true, Ordering::AcqRel) {
                    state.shared.emit_window_state(state.hwnd, name);
                    state.shared.job.wake();
                }
            }
            EVENT_OBJECT_LOCATION_CHANGE => {
                if state.throttle.moved(Instant::now()) {
                    state.shared.emit_window_state(state.hwnd, name);
                }
            }
            _ => state.shared.emit_window_state(state.hwnd, name),
        }
    });
}

fn hook_main(
    shared: Arc<RunShared>,
    hwnd: u64,
    pid: u32,
    ready: std::sync::mpsc::SyncSender<Option<u32>>,
) {
    // SAFETY: MSG is a plain struct of integers; all-zero is valid.
    let mut msg: MSG = unsafe { zeroed() };
    // SAFETY: `msg` is a valid out pointer. Peeking for a message in an empty range creates this thread's
    // message queue, so a quit message posted to it is not lost.
    unsafe { PeekMessageW(&mut msg, null_mut(), WM_USER, WM_USER, PM_NOREMOVE) };
    HOOK.with(|cell| {
        *cell.borrow_mut() = Some(HookState {
            shared: Arc::clone(&shared),
            hwnd,
            throttle: MoveThrottle::new(MOVE_GAP),
        });
    });
    let ranges = [
        (EVENT_MINIMIZE_START, EVENT_MINIMIZE_END),
        (EVENT_OBJECT_LOCATION_CHANGE, EVENT_OBJECT_LOCATION_CHANGE),
        (EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY),
    ];
    let mut hooks: Vec<HWINEVENTHOOK> = Vec::new();
    for (low, high) in ranges {
        // SAFETY: `on_event` matches the callback type; out-of-context delivery needs no module handle;
        // the process id filters to the window's process and the thread id 0 means all its threads.
        let hook = unsafe {
            SetWinEventHook(
                low,
                high,
                null_mut(),
                Some(on_event),
                pid,
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        if hook.is_null() {
            break;
        }
        hooks.push(hook);
    }
    if hooks.len() != ranges.len() {
        shared
            .emitter
            .log("warn", "window event hooks could not be set");
        unhook(&hooks);
        HOOK.with(|cell| *cell.borrow_mut() = None);
        let _ = ready.send(None);
        return;
    }
    // SAFETY: no arguments; returns the calling thread's id.
    let _ = ready.send(Some(unsafe { GetCurrentThreadId() }));

    'run: loop {
        let wait = HOOK
            .with(|cell| {
                cell.borrow()
                    .as_ref()
                    .and_then(|s| s.throttle.wait(Instant::now()))
            })
            .map_or(INFINITE, |d| {
                u32::try_from(d.as_millis()).unwrap_or(INFINITE).max(1)
            });
        // SAFETY: no handles are waited on (count 0, null array); only the thread's own queue wakes it.
        unsafe { MsgWaitForMultipleObjectsEx(0, null(), wait, QS_ALLINPUT, MWMO_INPUTAVAILABLE) };
        // Events are delivered to the callback from inside this loop.
        // SAFETY: `msg` is a valid out pointer for each call.
        while unsafe { PeekMessageW(&mut msg, null_mut(), 0, 0, PM_REMOVE) } != 0 {
            if msg.message == WM_QUIT {
                break 'run;
            }
        }
        HOOK.with(|cell| {
            if let Some(state) = cell.borrow_mut().as_mut() {
                if state.throttle.flush(Instant::now())
                    && !state.shared.window_gone.load(Ordering::Acquire)
                {
                    state.shared.emit_window_state(state.hwnd, "moved");
                }
            }
        });
    }
    unhook(&hooks);
    HOOK.with(|cell| *cell.borrow_mut() = None);
}

fn unhook(hooks: &[HWINEVENTHOOK]) {
    for hook in hooks {
        // SAFETY: each handle came from a successful `SetWinEventHook` on this thread and is removed once.
        unsafe { UnhookWinEvent(*hook) };
    }
}
