//! The C boundary: the panic guard and, on Windows, every export with its
//! argument checks and out-parameter writes.
//!
//! With the `win::sys` module (`win/sys.rs` and `win/sys/file.rs`), the only
//! code that may contain `unsafe`. The rules it keeps are the spec's
//! "Boundary rules": a status comes back from every call, results go only
//! through out-pointers checked for null, a buffer is borrowed for the call
//! only, no raw handle value is accepted, and no panic crosses.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::abi::Status;

/// Set by the first caught panic or `internal` status. Never cleared: the
/// backend stays off for the rest of the process.
static LATCHED: AtomicBool = AtomicBool::new(false);

/// Runs one export body and turns a panic into the `internal` status.
///
/// After a panic, or after a body reports `internal` (a poisoned table lock),
/// every later call returns `internal` without running its body.
pub fn guard(body: impl FnOnce() -> Status) -> i32 {
    guard_with(&LATCHED, body)
}

/// `guard` on a latch the caller owns. The exports use the process's one
/// latch; a test passes its own, so it does not switch the process off.
pub fn guard_with(latch: &AtomicBool, body: impl FnOnce() -> Status) -> i32 {
    if latch.load(Ordering::SeqCst) {
        return Status::Internal.code();
    }
    let status = match catch_unwind(AssertUnwindSafe(body)) {
        Ok(status) => status,
        Err(payload) => {
            // Leaked, not dropped: a payload's destructor may panic, and that
            // panic would cross the boundary.
            std::mem::forget(payload);
            Status::Internal
        }
    };
    if status == Status::Internal {
        latch.store(true, Ordering::SeqCst);
    }
    status.code()
}

/// Whether the backend has latched off in this process.
pub fn latched() -> bool {
    LATCHED.load(Ordering::SeqCst)
}

/// The guard for the two exports that return a plain number. A panic gives a
/// value no caller accepts as a version or as production build flags.
pub fn guard_value(body: impl FnOnce() -> u32) -> u32 {
    catch_unwind(AssertUnwindSafe(body)).unwrap_or_else(|payload| {
        std::mem::forget(payload);
        u32::MAX
    })
}

#[cfg(windows)]
pub mod exports {
    use super::{guard, guard_value};
    use crate::abi::{self, DetailOut, Refusal, Status, MAX_DEPTH, MAX_SEGMENT_UNITS};
    use crate::win::dir;
    use crate::win::policy::RealProbe;
    use crate::win::root::{self, Identity, PINS};
    use crate::win::walk::{self, FILES};
    use crate::win::write::{self, Expectation, Outcome};

    /// The longest segment list that can be valid: 64 segments of 255 units,
    /// each with its terminator. A longer count is refused before any read.
    const MAX_LIST_UNITS: usize = MAX_DEPTH * (MAX_SEGMENT_UNITS + 1);

    /// Borrows `count` UTF-16 code units for the length of one call.
    ///
    /// # Safety
    /// `pointer` is null, or valid for reading `count` code units until the
    /// export returns.
    unsafe fn units<'a>(pointer: *const u16, count: u32) -> Option<&'a [u16]> {
        if pointer.is_null() || !pointer.is_aligned() {
            return None;
        }
        // SAFETY: the pointer is not null and is aligned (both checked), and
        // the caller keeps it valid for `count` reads for the whole call. The
        // slice never outlives the export that asked for it.
        Some(unsafe { std::slice::from_raw_parts(pointer, count as usize) })
    }

    /// Borrows a segment list for one call. An empty list may be null; a
    /// count above `MAX_LIST_UNITS` is refused before anything is read.
    ///
    /// # Safety
    /// As `units`.
    unsafe fn segment_list<'a>(pointer: *const u16, count: u32) -> Option<&'a [u16]> {
        match count as usize {
            0 => Some(&[]),
            n if n > MAX_LIST_UNITS => None,
            // SAFETY: the caller's promise is passed on unchanged.
            _ => unsafe { units(pointer, count) },
        }
    }

    /// Borrows a writable byte buffer for one call. An empty one may be null.
    ///
    /// # Safety
    /// `pointer` is null, or valid for writing `length` bytes until the export
    /// returns, and nothing else reads or writes it meanwhile.
    unsafe fn bytes_mut<'a>(pointer: *mut u8, length: usize) -> Option<&'a mut [u8]> {
        if length == 0 {
            return Some(&mut []);
        }
        if pointer.is_null() {
            return None;
        }
        // SAFETY: not null (checked), bytes need no alignment, and the caller keeps it valid and unshared for `length` writes for the call.
        Some(unsafe { std::slice::from_raw_parts_mut(pointer, length) })
    }

    /// Borrows `length` bytes for reading during one call. An empty buffer may
    /// be null; a length above `MAX_WRITE_BYTES` is refused before any read.
    ///
    /// # Safety
    /// `pointer` is null, or valid for reading `length` bytes until the export
    /// returns.
    unsafe fn bytes<'a>(pointer: *const u8, length: usize) -> Option<&'a [u8]> {
        if length == 0 {
            return Some(&[]);
        }
        if pointer.is_null() || length > abi::MAX_WRITE_BYTES {
            return None;
        }
        // SAFETY: not null (checked), bytes need no alignment, the length is at most `isize::MAX` (checked), and the caller keeps it valid for `length` reads for the call.
        Some(unsafe { std::slice::from_raw_parts(pointer, length) })
    }

    /// Writes a refusal's detail and returns its status.
    ///
    /// # Safety
    /// As `put`.
    unsafe fn refused(out_detail: *mut DetailOut, refusal: Refusal) -> Status {
        // SAFETY: the caller's promise is passed on unchanged.
        unsafe { put(out_detail, refusal.detail()) };
        refusal.status
    }

    fn status_of(result: Result<(), Refusal>) -> Status {
        result.map_or_else(|refusal| refusal.status, |()| Status::Ok)
    }

    /// Writes one result through an out-pointer.
    ///
    /// # Safety
    /// `pointer` is not null and is valid for writing one `T`.
    unsafe fn put<T>(pointer: *mut T, value: T) {
        // SAFETY: the caller checked for null and keeps the pointer valid for
        // one write; an unaligned write needs no alignment.
        unsafe { pointer.write_unaligned(value) };
    }

    #[no_mangle]
    pub extern "C" fn jfa_abi_version() -> u32 {
        guard_value(|| abi::ABI_VERSION)
    }

    #[no_mangle]
    pub extern "C" fn jfa_build_flags() -> u32 {
        guard_value(abi::build_flags)
    }

    /// Runs every availability check and the root checks, then pins the root.
    ///
    /// # Safety
    /// `root` is null or valid for reading `root_units` UTF-16 code units, and
    /// `out_pin` and `out_detail` are each null or valid for one write, for
    /// the length of the call.
    #[no_mangle]
    pub unsafe extern "C" fn jfa_root_open(
        root: *const u16,
        root_units: u32,
        expected_device: u64,
        expected_inode: u64,
        out_pin: *mut u64,
        out_detail: *mut DetailOut,
    ) -> i32 {
        guard(|| {
            if out_pin.is_null() || out_detail.is_null() {
                return Status::InvalidArgument;
            }
            // SAFETY: both pointers were checked for null just above and the
            // caller keeps them valid for a write.
            unsafe {
                put(out_pin, 0);
                put(out_detail, DetailOut::default());
            }
            // Refused before a slice of that length exists; the shape check
            // gives the same answer for a root this long.
            if root_units as usize > root::MAX_ROOT_UNITS {
                return Status::RootInvalid;
            }
            // SAFETY: the caller keeps `root` valid for `root_units` reads.
            let Some(root) = (unsafe { units(root, root_units) }) else {
                return Status::InvalidArgument;
            };
            let expected = Identity {
                device: expected_device,
                inode: expected_inode,
            };
            match root::pin_root(&RealProbe, &PINS, root, expected) {
                Ok(pin) => {
                    // SAFETY: checked for null above; valid for a write.
                    unsafe { put(out_pin, pin) };
                    Status::Ok
                }
                // SAFETY: checked for null above; valid for a write.
                Err(refusal) => unsafe { refused(out_detail, refusal) },
            }
        })
    }

    /// Reports the pinned root's volume serial number and file index.
    ///
    /// # Safety
    /// `out_device` and `out_inode` are each null or valid for one write, for
    /// the length of the call.
    #[no_mangle]
    pub unsafe extern "C" fn jfa_pin_identity(
        pin: u64,
        out_device: *mut u64,
        out_inode: *mut u64,
    ) -> i32 {
        guard(|| {
            if out_device.is_null() || out_inode.is_null() {
                return Status::InvalidArgument;
            }
            // SAFETY: both pointers were checked for null just above and the
            // caller keeps them valid for a write.
            unsafe {
                put(out_device, 0);
                put(out_inode, 0);
            }
            match root::pin_identity(&PINS, pin) {
                Ok(identity) => {
                    // SAFETY: checked for null above; valid for a write.
                    unsafe {
                        put(out_device, identity.device);
                        put(out_inode, identity.inode);
                    }
                    Status::Ok
                }
                Err(refusal) => refusal.status,
            }
        })
    }

    /// Closes the root handle and frees the slot. A second close is refused.
    #[no_mangle]
    pub extern "C" fn jfa_pin_close(pin: u64) -> i32 {
        guard(|| status_of(root::pin_close(&PINS, pin)))
    }

    /// Opens a regular file below the pin, read only (W6), and stores it.
    ///
    /// # Safety
    /// `segments` is null or valid for reading `segments_units` code units,
    /// and `out_token` and `out_detail` are each null or valid for one write,
    /// for the length of the call.
    #[no_mangle]
    pub unsafe extern "C" fn jfa_open_file(
        pin: u64,
        segments: *const u16,
        segments_units: u32,
        out_token: *mut u64,
        out_detail: *mut DetailOut,
    ) -> i32 {
        guard(|| {
            if out_token.is_null() || out_detail.is_null() {
                return Status::InvalidArgument;
            }
            // SAFETY: both pointers were checked for null just above and the caller keeps them valid for a write.
            unsafe {
                put(out_token, 0);
                put(out_detail, DetailOut::default());
            }
            // SAFETY: the caller keeps `segments` valid for `segments_units` reads.
            let Some(list) = (unsafe { segment_list(segments, segments_units) }) else {
                return Status::InvalidArgument;
            };
            match walk::file_open(&PINS, &FILES, pin, list) {
                // SAFETY: checked for null above; valid for a write.
                Ok(token) => unsafe { put(out_token, token) },
                // SAFETY: checked for null above; valid for a write.
                Err(refusal) => return unsafe { refused(out_detail, refusal) },
            }
            Status::Ok
        })
    }

    /// Hands the file's original handle to the caller, once.
    ///
    /// # Safety
    /// `out_handle` is null or valid for one write, for the length of the call.
    #[no_mangle]
    pub unsafe extern "C" fn jfa_file_take(token: u64, out_handle: *mut usize) -> i32 {
        guard(|| {
            if out_handle.is_null() {
                return Status::InvalidArgument;
            }
            // SAFETY: checked for null just above; the caller keeps it valid for a write.
            unsafe { put(out_handle, 0) };
            match walk::file_take(&FILES, token) {
                Ok(value) => {
                    // SAFETY: checked for null above; valid for a write.
                    unsafe { put(out_handle, value) };
                    Status::Ok
                }
                Err(refusal) => refusal.status,
            }
        })
    }

    /// Runs the regular-file check again on the library's duplicate.
    #[no_mangle]
    pub extern "C" fn jfa_file_check(token: u64) -> i32 {
        guard(|| status_of(walk::file_check(&FILES, token)))
    }

    /// Frees the token. `reclaim` 1 also closes a taken handle.
    #[no_mangle]
    pub extern "C" fn jfa_file_close(token: u64, reclaim: u32) -> i32 {
        guard(|| match reclaim {
            0 | 1 => status_of(walk::file_close(&FILES, token, reclaim == 1)),
            _ => Status::InvalidArgument,
        })
    }

    /// Lists a directory below the pin into the caller's buffer.
    ///
    /// # Safety
    /// `segments` is null or valid for reading `segments_units` code units;
    /// `buffer` is null or valid for writing `capacity` bytes; each out-pointer
    /// is null or valid for one write; all for the length of the call.
    #[no_mangle]
    #[allow(clippy::too_many_arguments)] // The argument list is the frozen interface.
    pub unsafe extern "C" fn jfa_list(
        pin: u64,
        segments: *const u16,
        segments_units: u32,
        max_entries: u32,
        buffer: *mut u8,
        capacity: u32,
        out_bytes_used: *mut u32,
        out_entry_count: *mut u32,
        out_detail: *mut DetailOut,
    ) -> i32 {
        guard(|| {
            if out_bytes_used.is_null() || out_entry_count.is_null() || out_detail.is_null() {
                return Status::InvalidArgument;
            }
            // SAFETY: all three were checked for null just above and the caller keeps them valid for a write.
            unsafe {
                put(out_bytes_used, 0);
                put(out_entry_count, 0);
                put(out_detail, DetailOut::default());
            }
            if capacity as usize > abi::MAX_LISTING_BUFFER_BYTES {
                return Status::InvalidArgument;
            }
            // SAFETY: the caller keeps `segments` valid for `segments_units` reads.
            let Some(list) = (unsafe { segment_list(segments, segments_units) }) else {
                return Status::InvalidArgument;
            };
            // SAFETY: the caller keeps `buffer` valid for `capacity` writes.
            let Some(buffer) = (unsafe { bytes_mut(buffer, capacity as usize) }) else {
                return Status::InvalidArgument;
            };
            let listing = match dir::list_pinned(&PINS, pin, list, max_entries, buffer) {
                Ok(listing) => listing,
                // SAFETY: checked for null above; valid for a write.
                Err(refusal) => return unsafe { refused(out_detail, refusal) },
            };
            if !listing.complete {
                let needed = u32::try_from(listing.bytes_needed).unwrap_or(u32::MAX);
                // SAFETY: checked for null above; valid for a write.
                unsafe { put(out_bytes_used, needed) };
                return Status::BufferTooSmall;
            }
            // Fits: no more than `capacity` bytes were written.
            let used = listing.bytes_used as u32;
            // SAFETY: checked for null above; valid for a write.
            unsafe {
                put(out_bytes_used, used);
                put(out_entry_count, listing.entries);
            }
            Status::Ok
        })
    }

    /// The W7 write: creates missing parents, then writes through a temp and
    /// renames it over the leaf, if the expectation holds.
    ///
    /// # Safety
    /// `segments` is null or valid for reading `segments_units` code units;
    /// `content` and `expected` are each null or valid for reading their
    /// length in bytes; each out-pointer is null or valid for one write; all
    /// for the length of the call.
    #[no_mangle]
    #[allow(clippy::too_many_arguments)] // The argument list is the frozen interface.
    pub unsafe extern "C" fn jfa_write_atomic(
        pin: u64,
        segments: *const u16,
        segments_units: u32,
        content: *const u8,
        content_len: usize,
        expectation_kind: u32,
        expected: *const u8,
        expected_len: usize,
        out_outcome: *mut u32,
        out_detail: *mut DetailOut,
    ) -> i32 {
        guard(|| {
            if out_outcome.is_null() || out_detail.is_null() {
                return Status::InvalidArgument;
            }
            // SAFETY: both pointers were checked for null just above and the caller keeps them valid for a write.
            unsafe {
                put(out_outcome, abi::WRITE_NOT_MATCHED);
                put(out_detail, DetailOut::default());
            }
            // SAFETY: the caller keeps `segments` valid for `segments_units` reads.
            let Some(list) = (unsafe { segment_list(segments, segments_units) }) else {
                return Status::InvalidArgument;
            };
            // SAFETY: the caller keeps `content` valid for `content_len` reads.
            let content = unsafe { bytes(content, content_len) };
            // SAFETY: the caller keeps `expected` valid for `expected_len` reads.
            let expected = unsafe { bytes(expected, expected_len) };
            let (Some(content), Some(expected)) = (content, expected) else {
                return Status::InvalidArgument;
            };
            let expectation = match expectation_kind {
                abi::EXPECT_MUST_NOT_EXIST => Expectation::MustNotExist,
                abi::EXPECT_NO_EXPECTATION => Expectation::NoExpectation,
                abi::EXPECT_BYTES => Expectation::Bytes(expected),
                _ => return Status::InvalidArgument,
            };
            match write::write_pinned(&PINS, pin, list, content, expectation) {
                Ok(outcome) => {
                    let code = match outcome {
                        Outcome::Replaced => abi::WRITE_REPLACED,
                        Outcome::NotMatched => abi::WRITE_NOT_MATCHED,
                    };
                    // SAFETY: checked for null above; valid for a write.
                    unsafe { put(out_outcome, code) };
                    Status::Ok
                }
                Err(refusal) => {
                    if refusal.status == Status::DurabilityUncertain {
                        // The rename happened: the new content is in place.
                        // SAFETY: checked for null above; valid for a write.
                        unsafe { put(out_outcome, abi::WRITE_REPLACED) };
                    }
                    // SAFETY: checked for null above; valid for a write.
                    unsafe { refused(out_detail, refusal) }
                }
            }
        })
    }

    /// Test-seams build only: replaces what the real probe says about the
    /// process token. The states are in `win::policy::seam`.
    #[cfg(feature = "test-seams")]
    #[no_mangle]
    pub extern "C" fn jfa_test_set_token_state(state: u32) -> i32 {
        guard(|| {
            if crate::win::policy::seam::set_token_state(state) {
                Status::Ok
            } else {
                Status::InvalidArgument
            }
        })
    }
}
