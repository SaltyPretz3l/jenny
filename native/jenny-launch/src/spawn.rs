//! Start the target with exactly three inherited handles and mirror its exit.
//!
//! The parent owns the Job Object and assigns this process to it before it
//! sends the request, so the target (created with no breakaway flag) is born
//! inside the Job.

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED, HANDLE,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::WriteFile;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
};

use crate::cmdline::{env_block, target_command_line};
use crate::handles::{input_pipe, open_nul, target_outputs, OwnedHandle};
use crate::payload::Request;
use crate::{write_error_line, EXIT_LAUNCH_FAILED, MSG_INPUT_FAILED, MSG_LAUNCH_FAILED};

const WRITE_CHUNK: usize = 64 * 1024;

/// Start the target for `request`, feed it its input, wait, and return the
/// process exit code (the target's own 32-bit code, bit for bit).
pub fn run(request: &Request) -> i32 {
    let Some((process, input_write)) = start_target(request) else {
        write_error_line(MSG_LAUNCH_FAILED);
        return EXIT_LAUNCH_FAILED;
    };
    if let (Some(write_end), Some(data)) = (input_write, request.input.as_deref()) {
        let delivered = write_all(&write_end, data);
        drop(write_end);
        if !delivered {
            terminate_and_wait(&process);
            write_error_line(MSG_INPUT_FAILED);
            return EXIT_LAUNCH_FAILED;
        }
    }
    match wait_for_exit(&process) {
        Some(code) => code as i32,
        None => {
            terminate_and_wait(&process);
            write_error_line(MSG_LAUNCH_FAILED);
            EXIT_LAUNCH_FAILED
        }
    }
}

/// Keeps a process-thread attribute list alive, and its handle array with it.
struct HandleListAttribute {
    list: Vec<usize>,
    _handles: Vec<HANDLE>,
}

impl HandleListAttribute {
    fn new(mut handles: Vec<HANDLE>) -> Option<Self> {
        let mut size: usize = 0;
        // SAFETY: a null list with a valid size out pointer is the documented
        // way to query the required buffer size; the call is expected to
        // report failure while filling `size`.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
        }
        if size == 0 {
            return None;
        }
        // usize storage keeps the buffer pointer-aligned.
        let mut list = vec![0usize; size.div_ceil(size_of::<usize>())];
        let pointer = list.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        // SAFETY: `pointer` addresses a zeroed, aligned buffer of at least
        // `size` bytes, as the size query requested; `size` is a valid out
        // pointer.
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut size) } == 0 {
            return None;
        }
        // From here the list is initialised, so `Drop` must delete it.
        let handle_bytes = handles.len() * size_of::<HANDLE>();
        let handle_array = handles.as_mut_ptr() as *const c_void;
        let mut attribute = Self {
            list,
            _handles: handles,
        };
        // SAFETY: the list was initialised above; `handle_array` points into
        // the Vec that `attribute` now owns and keeps alive (moving a Vec
        // does not move its heap buffer); the byte size matches the array;
        // the optional out pointers are null.
        let updated = unsafe {
            UpdateProcThreadAttribute(
                attribute.as_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handle_array,
                handle_bytes,
                null_mut(),
                null(),
            )
        };
        (updated != 0).then_some(attribute)
    }

    fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.list.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }
}

impl Drop for HandleListAttribute {
    fn drop(&mut self) {
        // SAFETY: `list` was initialised by `InitializeProcThreadAttributeList`
        // in `new` and is deleted exactly once, here; a value that failed
        // before initialisation is never constructed.
        unsafe { DeleteProcThreadAttributeList(self.as_ptr()) };
    }
}

/// Create the target. Returns its process handle and, when the request has
/// input, the write end of its stdin pipe. Every other handle opened here is
/// closed before returning.
fn start_target(request: &Request) -> Option<(OwnedHandle, Option<OwnedHandle>)> {
    let environment = match &request.env {
        Some(pairs) => Some(env_block(pairs)?),
        None => None,
    };
    let mut command_line: Vec<u16> = target_command_line(&request.argv)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let directory: Vec<u16> = request
        .cwd
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let (stdin_read, stdin_write) = if request.input.is_some() {
        let (read, write) = input_pipe()?;
        (read, Some(write))
    } else {
        (open_nul()?, None)
    };
    let (stdout, stderr) = target_outputs()?;

    // Three distinct handles: each is a fresh duplicate, pipe end or NUL open.
    let inherited = vec![stdin_read.raw(), stdout.raw(), stderr.raw()];
    let mut attributes = HandleListAttribute::new(inherited)?;

    // SAFETY: STARTUPINFOEXW is a plain C struct of integers and raw
    // pointers; all-zero is a valid initial value for every field.
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin_read.raw();
    startup.StartupInfo.hStdOutput = stdout.raw();
    startup.StartupInfo.hStdError = stderr.raw();
    startup.lpAttributeList = attributes.as_ptr();

    let mut flags = EXTENDED_STARTUPINFO_PRESENT;
    let environment_ptr: *const c_void = match &environment {
        Some(block) => {
            flags |= CREATE_UNICODE_ENVIRONMENT;
            block.as_ptr() as *const c_void
        }
        None => null(),
    };
    // SAFETY: PROCESS_INFORMATION is a plain C struct; all-zero is valid.
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    // SAFETY: `command_line` is a writable NUL-terminated UTF-16 buffer and
    // `directory` a NUL-terminated one, both alive for the call; the
    // environment pointer is null or a double-NUL-terminated UTF-16 block
    // that outlives the call, flagged with CREATE_UNICODE_ENVIRONMENT;
    // `startup` is fully initialised, its attribute list and the handles in
    // it are alive, and it is declared extended through the flag and `cb`;
    // `info` is a valid out pointer. Handle inheritance is requested, which
    // the handle-list attribute restricts to the three listed handles.
    let created = unsafe {
        CreateProcessW(
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            flags,
            environment_ptr,
            directory.as_ptr(),
            // The whole extended struct, not a borrow of its first field: the
            // system reads past `StartupInfo` to reach the attribute list.
            (&raw const startup).cast::<STARTUPINFOW>(),
            &mut info,
        )
    };
    if created == 0 {
        return None;
    }
    let process = OwnedHandle::from_raw(info.hProcess);
    let _thread = OwnedHandle::from_raw(info.hThread);
    // The target now holds its own copies; ours drop with this frame.
    Some((process?, stdin_write))
}

/// Write all of `data` to the target's stdin. Returns false only for a real
/// failure: a target that closed or never read its stdin is not an error.
fn write_all(pipe: &OwnedHandle, data: &[u8]) -> bool {
    let mut remaining = data;
    while !remaining.is_empty() {
        let length = remaining.len().min(WRITE_CHUNK) as u32;
        let mut written: u32 = 0;
        // SAFETY: `remaining` is a live slice at least `length` bytes long,
        // and `length` is at most WRITE_CHUNK so it fits in u32; `written` is
        // a valid out pointer; the handle is a live pipe write end; the
        // overlapped pointer is null because the handle is synchronous.
        let ok = unsafe {
            WriteFile(
                pipe.raw(),
                remaining.as_ptr(),
                length,
                &mut written,
                null_mut(),
            )
        };
        if ok == 0 {
            // SAFETY: reads the calling thread's last-error value.
            let error = unsafe { GetLastError() };
            return matches!(
                error,
                ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED
            );
        }
        if written == 0 {
            return false;
        }
        remaining = remaining.get(written as usize..).unwrap_or_default();
    }
    true
}

fn wait_for_exit(process: &OwnedHandle) -> Option<u32> {
    // SAFETY: `process` is a live process handle owned by the caller.
    if unsafe { WaitForSingleObject(process.raw(), INFINITE) } != WAIT_OBJECT_0 {
        return None;
    }
    let mut code: u32 = 0;
    // SAFETY: `process` is a live process handle; `code` is a valid out
    // pointer.
    (unsafe { GetExitCodeProcess(process.raw(), &mut code) } != 0).then_some(code)
}

fn terminate_and_wait(process: &OwnedHandle) {
    // SAFETY: `process` is a live process handle owned by the caller; failure
    // (for example the target already exited) is reported by the return value
    // and is deliberately ignored.
    unsafe {
        TerminateProcess(process.raw(), 1);
    }
    let _ = wait_for_exit(process);
}
