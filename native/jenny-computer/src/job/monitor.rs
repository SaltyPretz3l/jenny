//! The threads that watch one run: the pipe readers and the monitor that finds its window, follows it
//! and reports the end of the job.

use std::ptr::null_mut;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use windows_sys::Win32::Storage::FileSystem::ReadFile;

use super::handle::Handle;
use super::hook::HookThread;
use super::jobobject::JobEvent;
use super::run::RunShared;
use crate::geometry::win::is_window;
use crate::window_list::win::visible_and_cloaked;
use crate::window_list::{choose_window, win::enumerate, window_to_switch_to};

/// How often the run's window is looked for while none is chosen.
const SEEK_MS: u32 = 25;
/// How often a chosen window is checked to still exist (the event hook is the fast path).
const FOLLOW_MS: u32 = 250;
/// While the followed window is hidden or cloaked, the job's windows are searched on the first check and then
/// on every this many checks (about once a second), not on every check.
const HIDDEN_SCAN_EVERY: u32 = 4;
/// How long the exit report waits for the pipes to drain.
pub const DRAIN_WAIT: Duration = Duration::from_secs(2);

/// Copy a pipe into the run's ring until it ends.
pub fn read_pipe(shared: &RunShared, pipe: &Handle) {
    let mut buffer = [0u8; 8192];
    loop {
        let mut read: u32 = 0;
        // SAFETY: `buffer` is writable for the length passed, `read` is a valid out pointer, the pipe handle
        // is valid, and a null overlapped pointer means a plain blocking read.
        let ok = unsafe {
            ReadFile(
                pipe.raw(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                null_mut(),
            )
        };
        if ok == 0 || read == 0 {
            break;
        }
        let chunk = buffer.get(..read as usize).unwrap_or_default();
        shared.with_ring(|ring| ring.push(chunk));
    }
    shared.reader_done();
}

/// A window of the run's job that passes the choice rule, with its process id.
fn find_window(shared: &RunShared) -> Option<(u64, u32)> {
    let pids = shared.job.process_ids();
    if pids.is_empty() {
        return None;
    }
    let candidates: Vec<_> = enumerate(Some(pids), false)
        .iter()
        .map(|w| w.candidate())
        .collect();
    choose_window(&candidates).map(|c| (c.hwnd, c.pid))
}

/// Whether the `checks`-th check of a hidden window (counted from 0) searches the job's windows.
fn hidden_scan_due(checks: u32) -> bool {
    checks.is_multiple_of(HIDDEN_SCAN_EVERY)
}

/// Find the window, follow it, and report the end of the job. Runs until the job is empty or `cancel` is set.
pub fn monitor(shared: Arc<RunShared>) {
    let mut window: Option<(u64, u32)> = None;
    let mut hidden_checks: u32 = 0;
    let mut hook: Option<HookThread> = None;
    let mut job_ended = false;
    loop {
        let timeout = if window.is_some() { FOLLOW_MS } else { SEEK_MS };
        if shared.job.wait_event(timeout) == JobEvent::Empty {
            shared.mark_job_empty();
            job_ended = true;
            break;
        }
        if shared.cancel.load(Ordering::Acquire) {
            break;
        }
        match window {
            Some((hwnd, _)) => {
                let gone = shared.window_gone.load(Ordering::Acquire) || !is_window(hwnd);
                if gone {
                    if !shared.window_gone.swap(true, Ordering::AcqRel) {
                        shared.emit_window_state(hwnd, "destroyed");
                    }
                    if let Some(h) = hook.take() {
                        h.stop();
                    }
                    window = None;
                    hidden_checks = 0;
                    shared.set_hwnd(None);
                } else {
                    // A window that is still there but hidden or cloaked (a splash screen that hides
                    // instead of closing) gives way to the window found now, if there is one.
                    let (visible, cloaked) = visible_and_cloaked(hwnd);
                    let hidden = !visible || cloaked;
                    let due = hidden && hidden_scan_due(hidden_checks);
                    hidden_checks = if hidden {
                        hidden_checks.wrapping_add(1)
                    } else {
                        0
                    };
                    if due {
                        if let Some((next, pid)) =
                            window_to_switch_to(hwnd, visible, cloaked, find_window(&shared))
                        {
                            hidden_checks = 0;
                            if let Some(h) = hook.take() {
                                h.stop();
                            }
                            shared.window_gone.store(false, Ordering::Release);
                            shared.set_hwnd(Some(next));
                            window = Some((next, pid));
                            shared.emit_window(next);
                            hook = HookThread::start(Arc::clone(&shared), next, pid);
                        }
                    }
                }
            }
            None => {
                if let Some((hwnd, pid)) = find_window(&shared) {
                    shared.window_gone.store(false, Ordering::Release);
                    shared.set_hwnd(Some(hwnd));
                    window = Some((hwnd, pid));
                    shared.emit_window(hwnd);
                    hook = HookThread::start(Arc::clone(&shared), hwnd, pid);
                }
            }
        }
    }
    if let Some(h) = hook.take() {
        h.stop();
    }
    if job_ended {
        // The data the program wrote before it ended is in the pipes; let the readers take it first.
        shared.wait_readers(DRAIN_WAIT);
        shared.finish_exit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hidden_window_is_searched_on_its_first_check_and_then_about_once_a_second() {
        let due: Vec<u32> = (0..10).filter(|&n| hidden_scan_due(n)).collect();
        assert_eq!(due, vec![0, 4, 8]);
        assert_eq!(FOLLOW_MS * HIDDEN_SCAN_EVERY, 1000);
    }
}
