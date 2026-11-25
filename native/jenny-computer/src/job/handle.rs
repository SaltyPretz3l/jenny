//! An owned kernel handle, closed when dropped.

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};

/// A handle closed exactly once, when this value is dropped.
pub struct Handle(HANDLE);

// SAFETY: a kernel handle is a process-wide token, not tied to the thread that created it; the calls this
// crate makes with these handles (wait, read, query, terminate, close) are safe from any thread, and
// `Drop` closes the handle once because the value is never copied.
unsafe impl Send for Handle {}
// SAFETY: see above; shared references only pass the handle value to thread-safe kernel calls.
unsafe impl Sync for Handle {}

impl Handle {
    /// Take ownership of `raw`. `None` for a null or invalid handle.
    pub fn from_raw(raw: HANDLE) -> Option<Self> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self(raw))
        }
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a valid handle this value owns exclusively (it came from a successful call
        // and is never copied out as an owner), so closing it once here cannot double-close.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
