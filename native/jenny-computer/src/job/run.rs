//! The state one run shares between the request thread, its reader threads and its monitor thread.

use std::sync::atomic::AtomicBool;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use windows_sys::Win32::System::Threading::GetExitCodeProcess;

use super::handle::Handle;
use super::jobobject::Job;
use crate::events::Emitter;
use crate::output::Ring;
use crate::protocol::source_id;

struct State {
    hwnd: Option<u64>,
    job_empty: bool,
    exited: bool,
    exit_code: Option<i32>,
    readers_alive: u8,
}

pub struct RunShared {
    pub run_id: String,
    pub pid: u32,
    pub emitter: Emitter,
    pub job: Job,
    process: Handle,
    pub ring: Mutex<Ring>,
    /// Set to ask the monitor thread to end.
    pub cancel: AtomicBool,
    /// Set once the chosen window is known to be gone, until the next one is chosen.
    pub window_gone: AtomicBool,
    state: Mutex<State>,
    changed: Condvar,
}

impl RunShared {
    pub fn new(run_id: &str, pid: u32, emitter: Emitter, job: Job, process: Handle) -> Self {
        Self {
            run_id: run_id.to_owned(),
            pid,
            emitter,
            job,
            process,
            ring: Mutex::new(Ring::new()),
            cancel: AtomicBool::new(false),
            window_gone: AtomicBool::new(false),
            state: Mutex::new(State {
                hwnd: None,
                job_empty: false,
                exited: false,
                exit_code: None,
                readers_alive: 2,
            }),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Wait until `done` holds for the state or `timeout` passes. True when it held.
    fn wait_for(&self, timeout: Duration, done: impl Fn(&State) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock();
        while !done(&state) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        true
    }

    pub fn with_ring<T>(&self, f: impl FnOnce(&mut Ring) -> T) -> T {
        let mut ring = self
            .ring
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut ring)
    }

    pub fn hwnd(&self) -> Option<u64> {
        self.lock().hwnd
    }

    pub fn set_hwnd(&self, hwnd: Option<u64>) {
        self.lock().hwnd = hwnd;
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.lock().exit_code
    }

    /// `(state name, hwnd, exit code)` for `run.list`.
    pub fn snapshot(&self) -> (&'static str, Option<u64>, Option<i32>) {
        let state = self.lock();
        let name = if state.exited {
            "exited"
        } else if state.hwnd.is_some() {
            "running"
        } else {
            "starting"
        };
        (name, state.hwnd, state.exit_code)
    }

    pub fn mark_job_empty(&self) {
        self.lock().job_empty = true;
        self.changed.notify_all();
    }

    pub fn job_is_empty(&self) -> bool {
        self.lock().job_empty
    }

    pub fn wait_job_empty(&self, timeout: Duration) -> bool {
        self.wait_for(timeout, |s| s.job_empty)
    }

    pub fn wait_exited(&self, timeout: Duration) -> bool {
        self.wait_for(timeout, |s| s.exited)
    }

    pub fn wait_readers(&self, timeout: Duration) -> bool {
        self.wait_for(timeout, |s| s.readers_alive == 0)
    }

    pub fn reader_done(&self) {
        let mut state = self.lock();
        state.readers_alive = state.readers_alive.saturating_sub(1);
        drop(state);
        self.changed.notify_all();
    }

    pub fn readers_done(&self) -> bool {
        self.lock().readers_alive == 0
    }

    /// Record the exit and emit `run.exited`, once however often it is called and from whichever thread.
    pub fn finish_exit(&self) {
        let mut state = self.lock();
        if state.exited {
            return;
        }
        let mut code: u32 = 0;
        // SAFETY: the process handle is valid and owned by `self`; `code` is a valid out pointer.
        let read = unsafe { GetExitCodeProcess(self.process.raw(), &mut code) } != 0;
        state.exit_code = read.then_some(code as i32);
        state.exited = true;
        state.job_empty = true;
        state.hwnd = None;
        let mut fields = Map::new();
        fields.insert("run_id".to_owned(), json!(self.run_id));
        fields.insert(
            "exit_code".to_owned(),
            state.exit_code.map_or(Value::Null, |c| json!(c)),
        );
        // Written while the lock is held, so anyone who sees `exited` can rely on the event being out.
        let _ = self.emitter.event("run.exited", fields);
        drop(state);
        self.changed.notify_all();
    }

    pub fn emit_window(&self, hwnd: u64) {
        let mut fields = Map::new();
        fields.insert("run_id".to_owned(), json!(self.run_id));
        fields.insert("hwnd".to_owned(), json!(hwnd));
        fields.insert("source_id".to_owned(), json!(source_id(hwnd)));
        let _ = self.emitter.event("run.window", fields);
    }

    pub fn emit_window_state(&self, hwnd: u64, state: &str) {
        let mut fields = Map::new();
        fields.insert("run_id".to_owned(), json!(self.run_id));
        fields.insert("hwnd".to_owned(), json!(hwnd));
        fields.insert("state".to_owned(), json!(state));
        let _ = self.emitter.event("run.window_state", fields);
    }
}
