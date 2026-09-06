use crate::process_tree::TerminationProof;
use super::WorkloadLimits;
use crate::transport::{host_request, secret_request, validate_host_response};
use sha2::Digest;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::iter::once;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr::null;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, SetHandleInformation, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, HANDLE,
    HANDLE_FLAG_INHERIT, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_CPU_RATE_CONTROL_ENABLE, JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY, OpenJobObjectW,
};

const JOB_OBJECT_TERMINATE_ACCESS: u32 = 0x0008;
use windows_sys::Win32::System::Pipes::{CreatePipe, PeekNamedPipe};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, ResumeThread,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_SUSPENDED,
    CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

pub struct ContainedProcess {
    pub pid: u32,
    job: HANDLE,
    process: HANDLE,
    input: File,
    output: BufReader<File>,
    secret_input: File,
    secret_channel_handle: usize,
    session_key: [u8; 32],
    next_sequence: u64,
    session_id: String,
    session_epoch: u64,
    proof_timeout_ms: u64,
}

// The process object is owned by one supervisor session and every mutable
// protocol operation is serialized behind that session's mutex. Windows
// handles are process-local opaque values and remain valid until Drop closes
// them after the final session reference is released.
unsafe impl Send for ContainedProcess {}

#[derive(Clone, Copy)]
pub struct TerminationHandle {
    job: usize,
    process: usize,
    proof_timeout_ms: u64,
}

fn job_tree_empty(job: HANDLE) -> bool {
    let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
    unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            std::mem::size_of_val(&accounting) as u32,
            std::ptr::null_mut(),
        ) != 0 && accounting.ActiveProcesses == 0
    }
}

fn wait_for_tree_empty(job: HANDLE, proof_timeout_ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(proof_timeout_ms.clamp(1_000, 60_000));
    loop {
        if job_tree_empty(job) { return true; }
        if Instant::now() >= deadline { return false; }
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl TerminationHandle {
    pub fn terminate(&self) -> TerminationProof {
        let job = self.job as HANDLE;
        let process = self.process as HANDLE;
        let killed = !job.is_null() && unsafe { TerminateJobObject(job, 1) } != 0;
        let wait_ms = self.proof_timeout_ms.clamp(1_000, 60_000) as u32;
        let reaped = killed && !process.is_null()
            && unsafe { WaitForSingleObject(process, wait_ms) } == WAIT_OBJECT_0;
        let tree_empty = killed && wait_for_tree_empty(job, self.proof_timeout_ms);
        TerminationProof {
            known: true,
            reaped,
            contained: true,
            tree_empty,
            escalated: true,
            surviving_process_count: if tree_empty { 0 } else { 1 },
        }
    }
}

impl Drop for ContainedProcess {
    fn drop(&mut self) {
        unsafe {
            if !self.job.is_null() {
                let _ = TerminateJobObject(self.job, 1);
                CloseHandle(self.job);
                self.job = std::ptr::null_mut();
            }
            if !self.process.is_null() {
                CloseHandle(self.process);
                self.process = std::ptr::null_mut();
            }
        }
    }
}

impl ContainedProcess {
    pub fn termination_handle(&self) -> TerminationHandle {
        TerminationHandle { job: self.job as usize, process: self.process as usize,
            proof_timeout_ms: self.proof_timeout_ms }
    }
    pub fn peer_identity_digest(&self) -> String {
        hex::encode(sha2::Sha256::digest(self.session_key))
    }
    fn read_frame(&mut self, timeout: Duration) -> Result<serde_json::Value, String> {
        let started = Instant::now();
        loop {
            let mut available = 0_u32;
            let ready = unsafe {
                PeekNamedPipe(
                    self.output.get_ref().as_raw_handle().cast(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut available,
                    std::ptr::null_mut(),
                )
            };
            if ready == 0 {
                return Err("host_pipe_failed".to_string());
            }
            if available > 65_536 {
                return Err("host_frame_too_large".to_string());
            }
            if available > 0 {
                let mut line = String::new();
                self.output
                    .read_line(&mut line)
                    .map_err(|_| "host_read_failed".to_string())?;
                if line.len() > 65_536 {
                    return Err("host_frame_too_large".to_string());
                }
                return serde_json::from_str(line.trim_end())
                    .map_err(|_| "host_frame_invalid".to_string());
            }
            if started.elapsed() >= timeout {
                return Err("host_response_timeout".to_string());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn write_value(&mut self, value: &serde_json::Value) -> Result<(), String> {
        let encoded =
            serde_json::to_string(value).map_err(|_| "host_frame_encode_failed".to_string())?;
        if encoded.len() > 65_536 {
            return Err("host_frame_too_large".to_string());
        }
        writeln!(self.input, "{encoded}")
            .and_then(|_| self.input.flush())
            .map_err(|_| "host_write_failed".to_string())
    }

    pub fn initialize(&mut self, session_id: &str, session_epoch: u64) -> Result<(), String> {
        self.session_id = session_id.to_string();
        self.session_epoch = session_epoch;
        let frame = serde_json::json!({ "protocol_version": 1,
            "direction": "supervisor_to_host", "sequence": 0, "operation": "handshake",
            "session_id": session_id, "session_epoch": session_epoch,
            "auth_key": hex::encode(self.session_key),
            "secret_channel_handle": self.secret_channel_handle });
        self.write_value(&frame)?;
        let response = self.read_frame(Duration::from_secs(5))?;
        if !validate_host_response(&response, &self.session_key, 0, session_id, session_epoch) {
            return Err("host_handshake_rejected".to_string());
        }
        self.next_sequence = 1;
        Ok(())
    }

    pub fn exchange(
        &mut self,
        operation: &str,
        payload_json: &str,
    ) -> Result<serde_json::Value, String> {
        let sequence = self.next_sequence;
        let frame = host_request(
            &self.session_key,
            "supervisor_to_host",
            sequence,
            operation,
            &self.session_id,
            self.session_epoch,
            payload_json,
        );
        self.write_value(&frame)?;
        let response = self.read_frame(Duration::from_secs(30))?;
        if !validate_host_response(
            &response,
            &self.session_key,
            sequence,
            &self.session_id,
            self.session_epoch,
        ) {
            return Err("host_response_auth_rejected".to_string());
        }
        self.next_sequence += 1;
        Ok(response)
    }

    pub fn deliver_secret(
        &mut self,
        grant_id: &str,
        secret: &[u8],
    ) -> Result<serde_json::Value, String> {
        let sequence = self.next_sequence;
        let header = serde_json::to_string(&secret_request(
            &self.session_key,
            sequence,
            grant_id,
            secret,
        ))
        .map_err(|_| "secret_header_encode_failed".to_string())?;
        self.secret_input
            .write_all(header.as_bytes())
            .and_then(|_| self.secret_input.write_all(b"\n"))
            .and_then(|_| self.secret_input.write_all(secret))
            .and_then(|_| self.secret_input.flush())
            .map_err(|_| "secret_channel_write_failed".to_string())?;
        let response = self.read_frame(Duration::from_secs(30))?;
        if !validate_host_response(
            &response,
            &self.session_key,
            sequence,
            &self.session_id,
            self.session_epoch,
        ) {
            return Err("secret_response_auth_rejected".to_string());
        }
        self.next_sequence += 1;
        Ok(response)
    }

}

use std::os::windows::io::AsRawHandle;

fn pipe_pair(security: &mut SECURITY_ATTRIBUTES) -> Result<(HANDLE, HANDLE), String> {
    let mut read = std::ptr::null_mut();
    let mut write = std::ptr::null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, security, 0) } == 0 {
        return Err("pipe_create_failed".to_string());
    }
    Ok((read, write))
}

struct ChildHandleList {
    _buffer: Vec<u8>,
    list: *mut core::ffi::c_void,
}

impl ChildHandleList {
    fn new(handles: &[HANDLE]) -> Result<Self, String> {
        let mut bytes = 0_usize;
        unsafe {
            let _ = InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err("handle_list_size_failed".to_string());
        }
        let mut buffer = vec![0_u8; bytes];
        let list = buffer.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut bytes) } == 0 {
            return Err("handle_list_initialize_failed".to_string());
        }
        if unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                std::mem::size_of_val(handles),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            unsafe {
                DeleteProcThreadAttributeList(list);
            }
            return Err("handle_list_update_failed".to_string());
        }
        Ok(Self {
            _buffer: buffer,
            list,
        })
    }
}

impl Drop for ChildHandleList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
    }
}

unsafe fn terminate_spawned_process(process: &PROCESS_INFORMATION) {
    unsafe {
        let _ = TerminateProcess(process.hProcess, 1);
        let _ = WaitForSingleObject(process.hProcess, 10_000);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
}

fn job_name(session_id: &str, session_epoch: u64) -> Vec<u16> {
    let digest = hex::encode(sha2::Sha256::digest(
        format!("{session_id}\0{session_epoch}").as_bytes(),
    ));
    OsStr::new(&format!("Local\\JennyPluginHost-{}", &digest[..32]))
        .encode_wide().chain(once(0)).collect()
}

pub fn terminate_or_prove_absent(session_id: &str, session_epoch: u64,
    proof_timeout_ms: u64) -> TerminationProof {
    let name = job_name(session_id, session_epoch);
    let job = unsafe { OpenJobObjectW(JOB_OBJECT_TERMINATE_ACCESS, 0, name.as_ptr()) };
    if job.is_null() {
        let absent = unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND;
        return TerminationProof { known: absent, reaped: absent, contained: absent,
            tree_empty: absent, escalated: false,
            surviving_process_count: if absent { 0 } else { 1 } };
    }
    let killed = unsafe { TerminateJobObject(job, 1) } != 0;
    let tree_empty = killed && wait_for_tree_empty(job, proof_timeout_ms);
    unsafe { CloseHandle(job); }
    TerminationProof { known: killed && tree_empty, reaped: killed && tree_empty, contained: true,
        tree_empty, escalated: true,
        surviving_process_count: if tree_empty { 0 } else { 1 } }
}

pub fn launch(path: &Path, session_id: &str, session_epoch: u64,
    limits_profile: WorkloadLimits) -> Result<ContainedProcess, String> {
    let mut security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let (stdout_read, stdout_write) = pipe_pair(&mut security)?;
    let (stdin_read, stdin_write) = pipe_pair(&mut security)?;
    let (stderr_read, stderr_write) = pipe_pair(&mut security)?;
    let (secret_read, secret_write) = pipe_pair(&mut security)?;
    if unsafe { SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0) } == 0
        || unsafe { SetHandleInformation(stdin_write, HANDLE_FLAG_INHERIT, 0) } == 0
        || unsafe { SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0) } == 0
        || unsafe { SetHandleInformation(secret_write, HANDLE_FLAG_INHERIT, 0) } == 0
    {
        unsafe {
            for handle in [
                stdout_read,
                stdout_write,
                stdin_read,
                stdin_write,
                stderr_read,
                stderr_write,
                secret_read,
                secret_write,
            ] {
                CloseHandle(handle);
            }
        }
        return Err("pipe_inheritance_failed".to_string());
    }
    let mut command: Vec<u16> = OsStr::new(&format!("\"{}\"", path.display()))
        .encode_wide()
        .chain(once(0))
        .collect();
    let cwd: Vec<u16> = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect();
    let child_handles = [stdin_read, stdout_write, stderr_write, secret_read];
    let handle_list = match ChildHandleList::new(&child_handles) {
        Ok(value) => value,
        Err(error) => {
            unsafe {
                for handle in [
                    stdout_read,
                    stdout_write,
                    stdin_read,
                    stdin_write,
                    stderr_read,
                    stderr_write,
                    secret_read,
                    secret_write,
                ] {
                    CloseHandle(handle);
                }
            }
            return Err(error);
        }
    };
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin_read;
    startup.StartupInfo.hStdOutput = stdout_write;
    startup.StartupInfo.hStdError = stderr_write;
    startup.lpAttributeList = handle_list.list;
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let mut empty_environment = [0_u16, 0_u16];
    let application: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            empty_environment.as_mut_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    drop(handle_list);
    let secret_channel_handle = secret_read as usize;
    unsafe {
        CloseHandle(stdin_read);
        CloseHandle(stdout_write);
        CloseHandle(stderr_write);
        CloseHandle(secret_read);
    }
    if created == 0 {
        unsafe {
            CloseHandle(stdin_write);
            CloseHandle(stdout_read);
            CloseHandle(stderr_read);
            CloseHandle(secret_write);
        }
        return Err("create_process_failed".to_string());
    }
    let job_name = job_name(session_id, session_epoch);
    let job = unsafe { CreateJobObjectW(null(), job_name.as_ptr()) };
    let job_already_exists = !job.is_null() && unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if job.is_null() || job_already_exists {
        unsafe {
            terminate_spawned_process(&process);
            if !job.is_null() { CloseHandle(job); }
            CloseHandle(stdin_write);
            CloseHandle(stdout_read);
            CloseHandle(stderr_read);
            CloseHandle(secret_write);
        }
        return Err("job_create_failed".to_string());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = limits_profile.active_process_limit;
    limits.ProcessMemoryLimit = limits_profile.process_memory_hard_bytes;
    limits.JobMemoryLimit = limits_profile.job_memory_hard_bytes;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    };
    let mut cpu: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = Default::default();
    cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
    cpu.Anonymous.CpuRate = limits_profile.cpu_hard_cap_percent * 100;
    let cpu_configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectCpuRateControlInformation,
            (&cpu as *const JOBOBJECT_CPU_RATE_CONTROL_INFORMATION).cast(),
            std::mem::size_of_val(&cpu) as u32,
        )
    };
    let assigned = unsafe { AssignProcessToJobObject(job, process.hProcess) };
    if configured == 0 || cpu_configured == 0 || assigned == 0 {
        unsafe {
            terminate_spawned_process(&process);
            CloseHandle(job);
            CloseHandle(stdin_write);
            CloseHandle(stdout_read);
            CloseHandle(stderr_read);
            CloseHandle(secret_write);
        }
        return Err("preexecution_containment_failed".to_string());
    }
    if unsafe { ResumeThread(process.hThread) } == u32::MAX {
        unsafe {
            terminate_spawned_process(&process);
            CloseHandle(job);
            CloseHandle(stdin_write);
            CloseHandle(stdout_read);
            CloseHandle(stderr_read);
            CloseHandle(secret_write);
        }
        return Err("resume_failed".to_string());
    }
    unsafe {
        CloseHandle(process.hThread);
    }
    let mut key = [0_u8; 32];
    if unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            key.as_mut_ptr(),
            key.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } != 0
    {
        unsafe {
            TerminateJobObject(job, 1);
            CloseHandle(job);
            CloseHandle(process.hProcess);
            CloseHandle(stdin_write);
            CloseHandle(stdout_read);
            CloseHandle(stderr_read);
            CloseHandle(secret_write);
        }
        return Err("session_key_generation_failed".to_string());
    }
    let stderr = unsafe { File::from_raw_handle(stderr_read.cast()) };
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buffer = Vec::with_capacity(4096);
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });
    Ok(ContainedProcess {
        pid: process.dwProcessId,
        job,
        process: process.hProcess,
        input: unsafe { File::from_raw_handle(stdin_write.cast()) },
        output: BufReader::new(unsafe { File::from_raw_handle(stdout_read.cast()) }),
        secret_input: unsafe { File::from_raw_handle(secret_write.cast()) },
        secret_channel_handle,
        session_key: key,
        next_sequence: 0,
        session_id: String::new(),
        session_epoch: 0,
        proof_timeout_ms: limits_profile.forced_termination_proof_ms,
    })
}
