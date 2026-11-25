//! The runs of one session: start, stop, close, output, list, shutdown.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, Once};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};
use windows_sys::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};

use super::cmdline::{command_line, env_block};
use super::jobobject::Job;
use super::monitor::{monitor, read_pipe};
use super::run::RunShared;
use super::spawn::spawn;
use crate::events::Emitter;
use crate::geometry::win::hwnd_of;
use crate::protocol::{reply_ok, ErrorCode, ProtoError, Request};

/// Default and largest `close_timeout_ms` of `run.stop`.
const DEFAULT_CLOSE_MS: u64 = 2000;
const MAX_CLOSE_MS: u64 = 10_000;
/// How long to wait for the end of a job that was told to end.
///
/// The three waits of a stop (this, `EXIT_WAIT` and the 2 s reader wait when the threads retire) add up
/// to 7.5 s on top of the close timeout, which stays inside the host's `run.stop` budget of the close
/// timeout plus 8 s (`RUN_STOP_EXTRA_MS` in `services/computer-helper/host.js`).
const END_WAIT: Duration = Duration::from_secs(3);
/// How long to wait for the monitor to report the exit after the job is empty. The monitor's own drain
/// of the pipes takes up to 2 s, so 2.5 s still covers it.
const EXIT_WAIT: Duration = Duration::from_millis(2500);

/// One started program and the threads that watch it.
struct Run {
    shared: Arc<RunShared>,
    monitor: Option<JoinHandle<()>>,
    /// True from the start until [`Runs::start_monitors`] has started the monitor, which is held back
    /// until the `run.start` reply is out so no event of the run can come before it.
    monitor_pending: bool,
    readers: Vec<JoinHandle<()>>,
}

impl Run {
    /// Ask the monitor to end and wait for it; join the readers when they are done, else let them go.
    fn retire_threads(&mut self) {
        self.shared.cancel.store(true, Ordering::Release);
        self.shared.job.wake();
        if let Some(monitor) = self.monitor.take() {
            let _ = monitor.join();
        }
        self.shared.wait_readers(Duration::from_secs(2));
        if self.shared.readers_done() {
            for reader in self.readers.drain(..) {
                let _ = reader.join();
            }
        } else {
            // A pipe still held open by something outside the job: the reader ends with it.
            self.readers.clear();
        }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        self.shared.job.terminate();
        self.retire_threads();
    }
}

/// How a stop went.
struct Stopped {
    how: &'static str,
    exit_code: Option<i32>,
}

/// The result of a finished `run.stop`.
fn stop_result(run_id: &str, stopped: &Stopped) -> Value {
    json!({"run_id": run_id, "how": stopped.how, "exit_code": stopped.exit_code})
}

/// A `run.stop` that runs on its own thread: its run is already out of the records, and its reply is
/// written by the thread when the stop is done.
struct StopInFlight {
    /// Kept so the end of input can end the job without waiting for the thread.
    shared: Arc<RunShared>,
    thread: JoinHandle<()>,
}

/// Close-then-end one run and drop it.
fn stop_run(mut run: Run, close_timeout: Duration) -> Stopped {
    let shared = Arc::clone(&run.shared);
    let how = if shared.job_is_empty() {
        "already_ended"
    } else {
        let closed = match shared.hwnd() {
            Some(hwnd) => {
                // SAFETY: a plain post to a window handle; a window that is gone makes the call fail.
                unsafe { PostMessageW(hwnd_of(hwnd), WM_CLOSE, 0, 0) };
                shared.wait_job_empty(close_timeout)
            }
            None => false,
        };
        if closed {
            "closed"
        } else {
            shared.job.terminate();
            shared.wait_job_empty(END_WAIT);
            "ended"
        }
    };
    if !shared.wait_exited(EXIT_WAIT) {
        shared.finish_exit();
    }
    run.retire_threads();
    Stopped {
        how,
        exit_code: shared.exit_code(),
    }
}

/// Every run of one `--serve` session.
pub struct Runs {
    emitter: Emitter,
    runs: Vec<Run>,
    stopping: Vec<StopInFlight>,
}

fn nul_free(text: &str, what: &str) -> Result<(), ProtoError> {
    if text.contains('\0') {
        Err(ProtoError::bad_request(format!("{what} holds a NUL")))
    } else {
        Ok(())
    }
}

fn start_failed(step: &str) -> ProtoError {
    ProtoError::new(
        ErrorCode::StartFailed,
        format!("the program could not be started ({step})"),
    )
}

impl Runs {
    pub fn new(emitter: Emitter) -> Self {
        static AWARENESS: Once = Once::new();
        AWARENESS.call_once(|| {
            // SAFETY: a plain call with a documented constant. It fails when the awareness is already
            // set, which is fine: either way the process is as aware as it will get.
            unsafe {
                SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
        });
        Self {
            emitter,
            runs: Vec::new(),
            stopping: Vec::new(),
        }
    }

    fn position(&self, run_id: &str) -> Option<usize> {
        self.runs.iter().position(|r| r.shared.run_id == run_id)
    }

    /// The process ids in a run's job (for `windows.list`).
    pub fn job_pids(&self, run_id: &str) -> Result<Vec<u32>, ProtoError> {
        let index = self.position(run_id).ok_or_else(no_such_run)?;
        Ok(self
            .runs
            .get(index)
            .map(|r| r.shared.job.process_ids())
            .unwrap_or_default())
    }

    /// `run.start`.
    pub fn start(&mut self, req: &Request) -> Result<Value, ProtoError> {
        let run_id = req.run_id_arg()?.to_owned();
        let program = req.str_arg("program")?;
        let args = req.string_list_arg("args")?;
        let cwd = req.str_arg("cwd")?;
        let env = req.string_map_arg("env")?;
        nul_free(program, "program")?;
        nul_free(cwd, "cwd")?;
        for arg in &args {
            nul_free(arg, "an argument")?;
        }
        if !Path::new(program).is_absolute() || !Path::new(program).is_file() {
            return Err(ProtoError::bad_request(
                "program must be the absolute path of an existing file",
            ));
        }
        if !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() {
            return Err(ProtoError::bad_request(
                "cwd must be the absolute path of an existing folder",
            ));
        }
        let env_block = env_block(&env).ok_or_else(|| {
            ProtoError::bad_request("env holds a name or value the system refuses")
        })?;

        if let Some(index) = self.position(&run_id) {
            let alive = self
                .runs
                .get(index)
                .is_some_and(|r| !r.shared.job_is_empty());
            if alive {
                return Err(ProtoError::new(
                    ErrorCode::RunExists,
                    "a run with that id is still running",
                ));
            }
            self.runs.remove(index);
        }

        let job = Job::create().map_err(start_failed)?;
        let line = command_line(program, &args);
        let spawned = spawn(&job, program, &line, cwd, &env_block).map_err(start_failed)?;
        let pid = spawned.pid;
        let shared = Arc::new(RunShared::new(
            &run_id,
            pid,
            self.emitter.clone(),
            job,
            spawned.process,
        ));
        // From here the record owns the job: dropping it on a failure below ends the program.
        let mut run = Run {
            shared: Arc::clone(&shared),
            monitor: None,
            monitor_pending: true,
            readers: Vec::new(),
        };
        for pipe in [spawned.stdout, spawned.stderr] {
            let for_thread = Arc::clone(&shared);
            let reader = std::thread::Builder::new()
                .name("jenny-run-output".to_owned())
                .spawn(move || read_pipe(&for_thread, &pipe))
                .map_err(|_| start_failed("reader thread"))?;
            run.readers.push(reader);
        }
        // The monitor is the thread that reports the window and the exit. It starts in `start_monitors`,
        // after the caller has written this reply; the job's notices wait on its completion port.
        self.runs.push(run);
        Ok(json!({"run_id": run_id, "pid": pid}))
    }

    /// Start the monitor of every run that has none yet. The serve loop calls it right after it has
    /// written a reply, so no event of a run comes before its `run.start` reply.
    pub fn start_monitors(&mut self) {
        for run in &mut self.runs {
            if !run.monitor_pending {
                continue;
            }
            run.monitor_pending = false;
            let for_thread = Arc::clone(&run.shared);
            match std::thread::Builder::new()
                .name("jenny-run-monitor".to_owned())
                .spawn(move || monitor(for_thread))
            {
                Ok(handle) => run.monitor = Some(handle),
                Err(_) => {
                    // Nothing could watch this run: end it and say so, as an exit would.
                    run.shared.job.terminate();
                    run.shared.finish_exit();
                }
            }
        }
    }

    /// Validate a `run.stop` and take its run out of the records, with its close timeout.
    fn take_for_stop(&mut self, req: &Request) -> Result<(String, Duration, Run), ProtoError> {
        let run_id = req.run_id_arg()?.to_owned();
        let timeout = req.u64_arg("close_timeout_ms", DEFAULT_CLOSE_MS, 0, MAX_CLOSE_MS)?;
        let index = self.position(&run_id).ok_or_else(no_such_run)?;
        // A run that never got its monitor would wait out the stop for nothing.
        self.start_monitors();
        let run = self.runs.remove(index);
        Ok((run_id, Duration::from_millis(timeout), run))
    }

    /// `run.stop` in request order: close the window, end the job after the timeout, drop the record, and
    /// return the result when all of that is done. The serve loop uses [`Runs::stop_detached`] instead.
    pub fn stop(&mut self, req: &Request) -> Result<Value, ProtoError> {
        let (run_id, timeout, run) = self.take_for_stop(req)?;
        Ok(stop_result(&run_id, &stop_run(run, timeout)))
    }

    /// `run.stop` off the request loop. The arguments are checked and the record is dropped before this
    /// returns, so a bad request or an unknown run answers at once (`Err`) and every later request sees the
    /// run as gone. The close-then-end goes to its own thread, which writes the reply when it is done
    /// (`Ok(None)`). When no thread can be started the stop runs here and its result comes back (`Ok(Some)`).
    pub fn stop_detached(&mut self, req: &Request) -> Result<Option<Value>, ProtoError> {
        let (run_id, timeout, run) = self.take_for_stop(req)?;
        self.stopping.retain(|s| !s.thread.is_finished());
        let shared = Arc::clone(&run.shared);
        // The run waits in a slot so a failed spawn, which drops the closure, does not take it along.
        let slot = Arc::new(Mutex::new(Some(run)));
        let for_thread = Arc::clone(&slot);
        let (emitter, id, thread_run_id) = (self.emitter.clone(), req.id, run_id.clone());
        let spawned = std::thread::Builder::new()
            .name("jenny-run-stop".to_owned())
            .spawn(move || {
                let run = for_thread
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take();
                if let Some(run) = run {
                    let stopped = stop_run(run, timeout);
                    let _ = emitter.line(&reply_ok(id, stop_result(&thread_run_id, &stopped)));
                }
            });
        match spawned {
            Ok(thread) => {
                self.stopping.push(StopInFlight { shared, thread });
                Ok(None)
            }
            Err(_) => {
                let run = slot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                    .ok_or_else(|| ProtoError::new(ErrorCode::Internal, "the stop was lost"))?;
                Ok(Some(stop_result(&run_id, &stop_run(run, timeout))))
            }
        }
    }

    /// `run.close`: ask the chosen window to close and return at once.
    pub fn close(&mut self, req: &Request) -> Result<Value, ProtoError> {
        let run_id = req.run_id_arg()?;
        let index = self.position(run_id).ok_or_else(no_such_run)?;
        let hwnd = self.runs.get(index).and_then(|r| {
            let (state, hwnd, _) = r.shared.snapshot();
            if state == "exited" {
                None
            } else {
                hwnd
            }
        });
        if let Some(hwnd) = hwnd {
            // SAFETY: a plain post to a window handle; a window that is gone makes the call fail.
            unsafe { PostMessageW(hwnd_of(hwnd), WM_CLOSE, 0, 0) };
        }
        Ok(json!({"run_id": run_id, "asked": hwnd.is_some()}))
    }

    /// `run.output`.
    pub fn output(&mut self, req: &Request) -> Result<Value, ProtoError> {
        let run_id = req.run_id_arg()?;
        let max = req.u64_arg("max_lines", 200, 1, 200)? as usize;
        let index = self.position(run_id).ok_or_else(no_such_run)?;
        let (lines, dropped) = self
            .runs
            .get(index)
            .map(|r| {
                r.shared
                    .with_ring(|ring| (ring.lines(max), ring.dropped_bytes()))
            })
            .unwrap_or_default();
        Ok(json!({"run_id": run_id, "lines": lines, "dropped_bytes": dropped}))
    }

    /// `run.list`.
    pub fn list(&mut self) -> Result<Value, ProtoError> {
        let runs: Vec<Value> = self
            .runs
            .iter()
            .map(|r| {
                let (state, hwnd, exit_code) = r.shared.snapshot();
                json!({
                    "run_id": r.shared.run_id,
                    "pid": r.shared.pid,
                    "state": state,
                    "hwnd": hwnd,
                    "exit_code": exit_code,
                    "pids": r.shared.job.process_ids(),
                })
            })
            .collect();
        Ok(json!({ "runs": runs }))
    }

    /// `shutdown`: stop every run as `run.stop` does, all at once, and wait for the stops already in flight
    /// too, so their replies are written before the caller writes the `shutdown` reply.
    pub fn shutdown_all(&mut self) {
        self.start_monitors();
        let stops: Vec<JoinHandle<Stopped>> = std::mem::take(&mut self.runs)
            .into_iter()
            .filter_map(|run| {
                std::thread::Builder::new()
                    .name("jenny-run-stop".to_owned())
                    .spawn(move || stop_run(run, Duration::from_millis(DEFAULT_CLOSE_MS)))
                    .ok()
            })
            .collect();
        for stop in stops {
            let _ = stop.join();
        }
        for in_flight in std::mem::take(&mut self.stopping) {
            let _ = in_flight.thread.join();
        }
    }

    /// End of stdin: end every job at once, those of stops in flight too, without waiting for any thread.
    pub fn end_all_now(&mut self) {
        for in_flight in self.stopping.drain(..) {
            in_flight.shared.job.terminate();
        }
        for run in &self.runs {
            run.shared.job.terminate();
        }
        self.runs.clear();
    }
}

fn no_such_run() -> ProtoError {
    ProtoError::new(ErrorCode::NoSuchRun, "no run with that id")
}
