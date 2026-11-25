//! A kill-on-close job object with an I/O completion port for its notifications.

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::IO::{
    CreateIoCompletionPort, GetQueuedCompletionStatus, PostQueuedCompletionStatus, OVERLAPPED,
};

use super::handle::Handle;

/// `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`: the job's last process ended.
const MSG_ACTIVE_PROCESS_ZERO: u32 = 4;
/// Completion key of the job's own notifications.
const JOB_KEY: usize = 1;
/// Completion key of a wake-up this process posted.
const WAKE_KEY: usize = 2;
/// The most process ids one listing will ask for.
const MAX_LISTED: usize = 4096;

/// What one wait on the job's port produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobEvent {
    /// The job's last process ended.
    Empty,
    /// Another thread called [`Job::wake`].
    Woken,
    /// Some other job notification (a process started or ended while others live).
    Other,
    Timeout,
    /// The port could not be read.
    Failed,
}

/// The job. Dropping it closes the job handle, which ends every process still in it.
pub struct Job {
    job: Handle,
    port: Handle,
}

impl Job {
    /// A new job with kill-on-close, tied to its own completion port. `Err` names the step that failed.
    pub fn create() -> Result<Self, &'static str> {
        // SAFETY: null attributes and a null name are the documented way to create an unnamed job.
        let raw = unsafe { CreateJobObjectW(null(), null()) };
        let job = Handle::from_raw(raw).ok_or("job")?;

        // SAFETY: the struct is plain integers and pointers; all-zero is valid.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is a fully initialised struct of the class and size passed, alive for the call.
        let set = unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            return Err("job limits");
        }

        // SAFETY: an invalid file handle with no existing port creates a new port; the arguments are plain values.
        let raw = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) };
        let port = Handle::from_raw(raw).ok_or("port")?;
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: JOB_KEY as *mut c_void,
            CompletionPort: port.raw(),
        };
        // SAFETY: `association` is a fully initialised struct of the class and size passed, alive for the call.
        let set = unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectAssociateCompletionPortInformation,
                (&raw const association).cast::<c_void>(),
                size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
            )
        };
        if set == 0 {
            return Err("port link");
        }
        Ok(Self { job, port })
    }

    /// Put a process in the job.
    pub fn assign(&self, process: HANDLE) -> bool {
        // SAFETY: both handles are valid for the call: the job is owned by `self`, the caller owns `process`.
        unsafe { AssignProcessToJobObject(self.job.raw(), process) != 0 }
    }

    /// End every process in the job now.
    pub fn terminate(&self) {
        // SAFETY: the job handle is valid and owned by `self`; the exit code is a plain value.
        unsafe {
            TerminateJobObject(self.job.raw(), 1);
        }
    }

    /// Wait up to `timeout_ms` for a job notification or a wake-up.
    pub fn wait_event(&self, timeout_ms: u32) -> JobEvent {
        let mut bytes: u32 = 0;
        let mut key: usize = 0;
        let mut overlapped: *mut OVERLAPPED = null_mut();
        // SAFETY: the port is valid and owned by `self`; the three out pointers are valid for the call.
        let ok = unsafe {
            GetQueuedCompletionStatus(
                self.port.raw(),
                &mut bytes,
                &mut key,
                &mut overlapped,
                timeout_ms,
            )
        };
        if ok == 0 {
            // SAFETY: reads the calling thread's last error, with no arguments.
            let error = unsafe { GetLastError() };
            return if overlapped.is_null() && error == WAIT_TIMEOUT {
                JobEvent::Timeout
            } else {
                JobEvent::Failed
            };
        }
        match key {
            WAKE_KEY => JobEvent::Woken,
            JOB_KEY if bytes == MSG_ACTIVE_PROCESS_ZERO => JobEvent::Empty,
            _ => JobEvent::Other,
        }
    }

    /// Make a thread waiting in [`Job::wait_event`] return at once.
    pub fn wake(&self) {
        // SAFETY: the port is valid and owned by `self`; a null overlapped pointer is allowed.
        unsafe {
            PostQueuedCompletionStatus(self.port.raw(), 0, WAKE_KEY, null());
        }
    }

    /// The process ids now in the job.
    pub fn process_ids(&self) -> Vec<u32> {
        let mut capacity = 64usize;
        loop {
            // Word 0 holds the two counts, the ids follow; a `usize` buffer keeps it pointer-aligned.
            let mut buffer = vec![0usize; 2 + capacity];
            // SAFETY: `buffer` is writable for the byte length passed; the call fills it with a
            // JOBOBJECT_BASIC_PROCESS_ID_LIST header and as many ids as fit.
            let ok = unsafe {
                QueryInformationJobObject(
                    self.job.raw(),
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast::<c_void>(),
                    (buffer.len() * size_of::<usize>()) as u32,
                    null_mut(),
                )
            };
            if ok == 0 {
                // Too small (ERROR_MORE_DATA) or the job is gone: grow a few times, then give up.
                if capacity < MAX_LISTED {
                    capacity *= 4;
                    continue;
                }
                return Vec::new();
            }
            let list = buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            // SAFETY: the buffer is at least as large and as aligned as the header struct, and the
            // successful call above wrote it.
            let listed = unsafe { (*list).NumberOfProcessIdsInList as usize };
            // SAFETY: `ProcessIdList` is the first of `listed` ids the call wrote into the buffer, which
            // holds `capacity` ids after the header; `listed` is at most `capacity` when the call succeeded.
            let first = unsafe { (&raw const (*list).ProcessIdList).cast::<usize>() };
            return (0..listed.min(capacity))
                // SAFETY: the index is below `listed`, so the read stays inside the ids that were written.
                .map(|i| unsafe { first.add(i).read() } as u32)
                .collect();
        }
    }
}
