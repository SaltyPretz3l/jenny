//! Owned Win32 handles and the three standard handles for the target.

use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::GetCurrentProcess;

/// A handle closed exactly once, when this value is dropped.
pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    /// Take ownership of `raw`. Returns `None` for a null or invalid handle.
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

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a valid handle that this value owns exclusively
        // (it came from a successful Win32 call and is never copied out as an
        // owner), so closing it once here cannot double-close.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Duplicate `source` into this process as an inheritable handle.
fn duplicate_inheritable(source: HANDLE) -> Option<OwnedHandle> {
    let mut duplicate: HANDLE = null_mut();
    // SAFETY: `GetCurrentProcess` returns a pseudo handle that is always
    // valid; `duplicate` is a valid out pointer; a bad `source` makes the
    // call fail with an error code rather than cause undefined behaviour.
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            source,
            GetCurrentProcess(),
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if ok == 0 {
        return None;
    }
    OwnedHandle::from_raw(duplicate)
}

/// Open the `NUL` device with an inheritable handle.
pub fn open_nul() -> Option<OwnedHandle> {
    let name: Vec<u16> = "NUL".encode_utf16().chain(std::iter::once(0)).collect();
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the
    // call; `attributes` is a fully initialised struct that outlives the
    // call; the template handle is null as the API allows.
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    OwnedHandle::from_raw(raw)
}

/// An inheritable duplicate of one of this process's own standard output
/// handles, or `NUL` when there is none that can be duplicated.
fn std_output_or_nul(id: u32) -> Option<OwnedHandle> {
    // SAFETY: `GetStdHandle` takes a plain constant and has no pointer
    // arguments; it returns null or an invalid value when nothing is set.
    let own = unsafe { GetStdHandle(id) };
    if own.is_null() || own == INVALID_HANDLE_VALUE {
        return open_nul();
    }
    duplicate_inheritable(own).or_else(open_nul)
}

/// The target's stdout and stderr: inheritable copies of ours, or `NUL`.
pub fn target_outputs() -> Option<(OwnedHandle, OwnedHandle)> {
    Some((
        std_output_or_nul(STD_OUTPUT_HANDLE)?,
        std_output_or_nul(STD_ERROR_HANDLE)?,
    ))
}

/// A new anonymous pipe: `(read end for the target, write end for us)`. The
/// read end is inheritable; the write end is not.
pub fn input_pipe() -> Option<(OwnedHandle, OwnedHandle)> {
    let mut read: HANDLE = null_mut();
    let mut write: HANDLE = null_mut();
    // SAFETY: both out pointers are valid for the call; the security
    // attributes pointer is null, which makes both ends non-inheritable.
    let ok = unsafe { CreatePipe(&mut read, &mut write, null(), 0) };
    if ok == 0 {
        return None;
    }
    let read = OwnedHandle::from_raw(read);
    let write = OwnedHandle::from_raw(write);
    let (read, write) = (read?, write?);
    let inheritable_read = duplicate_inheritable(read.raw())?;
    Some((inheritable_read, write))
}
