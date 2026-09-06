#[cfg(windows)]
pub mod windows;
#[cfg(windows)]
pub use windows::launch;
#[cfg(windows)]
pub use windows::ContainedProcess;
#[cfg(windows)]
pub use windows::TerminationHandle;
#[cfg(windows)]
pub use windows::terminate_or_prove_absent;
#[cfg(not(windows))]
pub mod posix;
#[cfg(not(windows))]
pub use posix::launch;
#[cfg(not(windows))]
pub use posix::ContainedProcess;
#[cfg(not(windows))]
pub use posix::TerminationHandle;
#[cfg(not(windows))]
pub use posix::terminate_or_prove_absent;

#[derive(Clone, Copy)]
pub struct WorkloadLimits {
    pub active_process_limit: u32,
    pub process_memory_hard_bytes: usize,
    pub job_memory_hard_bytes: usize,
    pub cpu_hard_cap_percent: u32,
    pub forced_termination_proof_ms: u64,
}
