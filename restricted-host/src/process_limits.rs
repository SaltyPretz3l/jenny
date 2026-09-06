use anyhow::{Result, bail};

pub const HELPER_WORKING_SET_BYTES: usize = 128 * 1024 * 1024;

#[cfg(windows)]
pub fn apply_process_memory_limit() -> Result<()> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::null;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // SAFETY: every pointer references a live, correctly sized Windows API
    // structure; the unnamed job handle is process-local and intentionally
    // retained until process exit so its hard memory limit remains active.
    unsafe {
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            bail!("process_memory_job_create_failed");
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.ProcessMemoryLimit = HELPER_WORKING_SET_BYTES;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            CloseHandle(job);
            bail!("process_memory_job_assignment_failed");
        }
        // Do not close the job handle: its limit owns this helper process for
        // exactly the helper's remaining lifetime.
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn apply_process_memory_limit() -> Result<()> {
    use std::mem::zeroed;
    use std::thread;
    use std::time::Duration;

    thread::Builder::new()
        .name("restricted-memory-guard".to_owned())
        .spawn(|| {
            loop {
                thread::sleep(Duration::from_millis(10));
                // SAFETY: getrusage writes to the correctly sized local structure.
                let peak_bytes = unsafe {
                    let mut usage: libc::rusage = zeroed();
                    if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
                        std::process::exit(71);
                    }
                    usage.ru_maxrss as usize
                };
                if peak_bytes > HELPER_WORKING_SET_BYTES {
                    std::process::exit(71);
                }
            }
        })
        .map_err(|_| anyhow::anyhow!("process_memory_guard_start_failed"))?;
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn apply_process_memory_limit() -> Result<()> {
    bail!("restricted_host_platform_unsupported")
}
