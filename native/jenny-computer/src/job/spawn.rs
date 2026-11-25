//! Start a program suspended, with only its three standard handles inherited, inside a job.

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    SetHandleInformation, GENERIC_READ, HANDLE, HANDLE_FLAG_INHERIT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, ResumeThread,
    TerminateProcess, UpdateProcThreadAttribute, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESHOWWINDOW,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE;

use super::handle::Handle;
use super::jobobject::Job;

/// What a started run hands back.
pub struct Spawned {
    pub process: Handle,
    pub pid: u32,
    pub stdout: Handle,
    pub stderr: Handle,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The `NUL` device opened for reading, inheritable.
fn open_nul() -> Option<Handle> {
    let attributes = inheritable();
    let name = wide("NUL");
    // SAFETY: `name` is a NUL-terminated UTF-16 string and `attributes` a fully initialised struct, both
    // alive for the call; the template handle is null as the API allows.
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    Handle::from_raw(raw)
}

fn inheritable() -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    }
}

/// A pipe: `(read end for us, write end for the child)`. Only the write end can be inherited.
fn output_pipe() -> Option<(Handle, Handle)> {
    let attributes = inheritable();
    let mut read: HANDLE = null_mut();
    let mut write: HANDLE = null_mut();
    // SAFETY: both out pointers and the attributes are valid for the call.
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return None;
    }
    let (read, write) = (Handle::from_raw(read), Handle::from_raw(write));
    let (read, write) = (read?, write?);
    // SAFETY: `read` is a valid handle owned here; clearing its inherit flag changes only that flag.
    if unsafe { SetHandleInformation(read.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return None;
    }
    Some((read, write))
}

/// A process-thread attribute list that restricts inheritance to the listed handles.
struct HandleList {
    list: Vec<usize>,
    _handles: Vec<HANDLE>,
}

impl HandleList {
    fn new(mut handles: Vec<HANDLE>) -> Option<Self> {
        let mut size: usize = 0;
        // SAFETY: a null list with a valid size out pointer is the documented size query; it is expected
        // to report failure while filling `size`.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
        }
        if size == 0 {
            return None;
        }
        // usize storage keeps the buffer pointer-aligned.
        let mut list = vec![0usize; size.div_ceil(size_of::<usize>())];
        let pointer = list.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        // SAFETY: `pointer` addresses a zeroed, aligned buffer of at least `size` bytes; `size` is valid.
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut size) } == 0 {
            return None;
        }
        let bytes = handles.len() * size_of::<HANDLE>();
        let array = handles.as_mut_ptr() as *const c_void;
        let mut attribute = Self {
            list,
            _handles: handles,
        };
        // SAFETY: the list was initialised above; `array` points into the Vec that `attribute` now owns
        // and keeps alive (moving a Vec keeps its heap buffer); the byte size matches the array.
        let updated = unsafe {
            UpdateProcThreadAttribute(
                attribute.as_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                array,
                bytes,
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

impl Drop for HandleList {
    fn drop(&mut self) {
        // SAFETY: the list was initialised by `InitializeProcThreadAttributeList` in `new`, and a value
        // that failed before that is never constructed; it is deleted once, here.
        unsafe { DeleteProcThreadAttributeList(self.as_ptr()) };
    }
}

/// Start `program` suspended in `job`, then resume it. `Err` names the step that failed (never the path);
/// whatever was created is ended and closed first.
pub fn spawn(
    job: &Job,
    program: &str,
    command_line: &str,
    cwd: &str,
    env: &[u16],
) -> Result<Spawned, &'static str> {
    let stdin = open_nul().ok_or("stdin")?;
    let (stdout_read, stdout_write) = output_pipe().ok_or("stdout pipe")?;
    let (stderr_read, stderr_write) = output_pipe().ok_or("stderr pipe")?;
    let mut list = HandleList::new(vec![stdin.raw(), stdout_write.raw(), stderr_write.raw()])
        .ok_or("handle list")?;

    // SAFETY: STARTUPINFOEXW is a plain C struct of integers and raw pointers; all-zero is valid.
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.StartupInfo.wShowWindow = SW_SHOWNOACTIVATE as u16;
    startup.StartupInfo.hStdInput = stdin.raw();
    startup.StartupInfo.hStdOutput = stdout_write.raw();
    startup.StartupInfo.hStdError = stderr_write.raw();
    startup.lpAttributeList = list.as_ptr();

    let application = wide(program);
    let mut line = wide(command_line);
    let directory = wide(cwd);
    let flags = EXTENDED_STARTUPINFO_PRESENT
        | CREATE_SUSPENDED
        | CREATE_UNICODE_ENVIRONMENT
        | CREATE_NO_WINDOW;
    // SAFETY: PROCESS_INFORMATION is a plain C struct; all-zero is valid.
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    // SAFETY: `application` and `directory` are NUL-terminated UTF-16 strings, `line` a writable
    // NUL-terminated one, and `env` a double-NUL-terminated block flagged CREATE_UNICODE_ENVIRONMENT, all
    // alive for the call; `startup` is fully initialised, declared extended through the flag and `cb`, and
    // its attribute list and the handles in it are alive; `info` is a valid out pointer. Inheritance is
    // requested, which the handle-list attribute restricts to the three listed handles.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            flags,
            env.as_ptr().cast::<c_void>(),
            directory.as_ptr(),
            (&raw const startup).cast::<STARTUPINFOW>(),
            &mut info,
        )
    };
    if created == 0 {
        return Err("process");
    }
    let process = Handle::from_raw(info.hProcess);
    let thread = Handle::from_raw(info.hThread);
    let (Some(process), Some(thread)) = (process, thread) else {
        return Err("process handles");
    };

    let end_and_fail = |step: &'static str| {
        // SAFETY: `process` is a valid handle this function owns; the exit code is a plain value.
        unsafe { TerminateProcess(process.raw(), 1) };
        step
    };
    if !job.assign(process.raw()) {
        return Err(end_and_fail("assign"));
    }
    // SAFETY: `thread` is the valid handle of the suspended initial thread, owned here.
    if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
        return Err(end_and_fail("resume"));
    }
    // The child holds its own copies of the write ends; ours close when this function returns, so the
    // readers see the end of the stream when the last process of the job is gone.
    Ok(Spawned {
        process,
        pid: info.dwProcessId,
        stdout: stdout_read,
        stderr: stderr_read,
    })
}
