//! Windows system calls. With `ffi.rs`, the only module that may contain
//! `unsafe`; its child `sys/file.rs` holds the calls below the root.
//!
//! The declarations come from `windows-sys`. Each call has one safe wrapper
//! here, so the rest of the crate never sees a raw handle or a raw pointer.
//! No handle opened here is inheritable, and none is opened with delete sharing.

use std::ffi::{c_void, CStr};
use std::ptr;

use windows_sys::core::{w, PCWSTR};
use windows_sys::Wdk::Storage::FileSystem::{
    FileFsDeviceInformation, NtQueryVolumeInformationFile,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, ERROR_INSUFFICIENT_BUFFER,
    ERROR_INVALID_DATA, ERROR_INVALID_PARAMETER, HANDLE, INVALID_HANDLE_VALUE, LUID,
};
use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
use windows_sys::Win32::Security::{
    GetTokenInformation, LookupPrivilegeValueW, TokenElevation, TokenPrivileges, SE_BACKUP_NAME,
    SE_RESTORE_NAME, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileInformationByHandle, GetFinalPathNameByHandleW,
    GetVolumeInformationByHandleW, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, SYNCHRONIZE, VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

pub mod file;

/// The system's own code for a failed call: a Win32 error, or an NTSTATUS from
/// an `Nt` call. It never carries a name or a path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SysError(pub u32);

fn last_error() -> SysError {
    // SAFETY: GetLastError only reads this thread's last-error value.
    SysError(unsafe { GetLastError() })
}

/// A kernel handle this value alone owns. Closed once, when it is dropped.
#[derive(Debug)]
pub struct OwnedHandle(HANDLE);

// SAFETY: a kernel handle is a process-wide number with no thread affinity, and
// this type is its only owner, so moving it to another thread is sound.
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful open or duplicate, nothing
        // else holds its value, and this is the only place that closes it.
        unsafe { CloseHandle(self.0) };
    }
}

impl OwnedHandle {
    /// A second handle to the same open object, with the same access. It
    /// shares the original's share mode, so it keeps denying deletion.
    pub fn duplicate(&self) -> Result<OwnedHandle, SysError> {
        let mut copy: HANDLE = ptr::null_mut();
        // SAFETY: `self.0` is a live handle owned by `self`; `copy` is a local
        // the call writes; the process pseudo-handle needs no closing. The
        // copy is not inheritable.
        let ok = unsafe {
            let process = GetCurrentProcess();
            DuplicateHandle(
                process,
                self.0,
                process,
                &mut copy,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if ok == 0 || copy.is_null() {
            return Err(last_error());
        }
        Ok(OwnedHandle(copy))
    }

    /// Gives the handle up without closing it: from here on the caller of
    /// `jfa_file_take` owns it.
    pub fn release(self) -> TakenHandle {
        let handle = self.0;
        std::mem::forget(self);
        TakenHandle(handle)
    }
}

/// A handle `jfa_file_take` handed out. Dropping it closes nothing; only
/// `reclaim`, which consumes it, closes it, so the library closes it at most once.
#[derive(Debug)]
pub struct TakenHandle(HANDLE);

// SAFETY: as for `OwnedHandle`: a process-wide number with no thread affinity.
unsafe impl Send for TakenHandle {}

impl TakenHandle {
    /// The value written to `jfa_file_take`'s out-pointer.
    pub fn value(&self) -> usize {
        self.0 as usize
    }

    /// Closes the handle: the caller took it and no descriptor came to own it.
    pub fn reclaim(self) {
        // SAFETY: the value came from a successful open, nothing in Python owns it (the caller says so), and `self` is consumed.
        unsafe { CloseHandle(self.0) };
    }
}

/// Opens the configured root directory itself (W4), by its `\\?\` path.
///
/// `path` must end with its only NUL. The handle can list and read
/// attributes, is shared for read and write but not for delete, opens a
/// reparse point as itself and is not inheritable.
pub fn open_root_directory(path: &[u16]) -> Result<OwnedHandle, SysError> {
    if path.last() != Some(&0) || path.iter().filter(|&&unit| unit == 0).count() != 1 {
        return Err(SysError(ERROR_INVALID_PARAMETER));
    }
    // SAFETY: `path` is a live slice that ends with its only NUL, so the call
    // reads a terminated string that lies inside it. The security attributes
    // and the template are null, which the call allows.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_LIST_DIRECTORY | SYNCHRONIZE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(last_error());
    }
    Ok(OwnedHandle(handle))
}

/// What `GetFileInformationByHandle` says about an open file or directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileInformation {
    pub attributes: u32,
    pub volume_serial: u32,
    pub file_index: u64,
    pub links: u32,
    pub size: u64,
    pub last_write: u64,
}

pub fn file_information(handle: &OwnedHandle) -> Result<FileInformation, SysError> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is live and `info` is a local of the type the call fills.
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(last_error());
    }
    let pair = |high: u32, low: u32| (u64::from(high) << 32) | u64::from(low);
    let written = info.ftLastWriteTime;
    Ok(FileInformation {
        attributes: info.dwFileAttributes,
        volume_serial: info.dwVolumeSerialNumber,
        file_index: pair(info.nFileIndexHigh, info.nFileIndexLow),
        links: info.nNumberOfLinks,
        size: pair(info.nFileSizeHigh, info.nFileSizeLow),
        last_write: pair(written.dwHighDateTime, written.dwLowDateTime),
    })
}

/// The most code units a final path may need; anything longer is refused.
const FINAL_PATH_UNITS: u32 = 32_768;
/// The first buffer: enough for an ordinary path in one call.
const FINAL_PATH_FIRST_UNITS: usize = 2_048;

/// The normalized DOS path of an open handle, as the system reports it
/// (`\\?\C:\...` or `\\?\UNC\...`), without a terminator. Short names come
/// back as long names.
pub fn final_path(handle: &OwnedHandle) -> Result<Vec<u16>, SysError> {
    let mut buffer = vec![0u16; FINAL_PATH_FIRST_UNITS];
    // Twice at most: the second call has the size the first one reported.
    for _ in 0..2 {
        let capacity = buffer.len() as u32;
        // SAFETY: the handle is live and the buffer holds exactly `capacity` code units.
        let written = unsafe {
            let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
            GetFinalPathNameByHandleW(handle.0, buffer.as_mut_ptr(), capacity, flags)
        };
        if written == 0 {
            return Err(last_error());
        }
        if written < capacity {
            buffer.truncate(written as usize);
            return Ok(buffer);
        }
        // Too small: `written` is the size needed, terminator included.
        if written > FINAL_PATH_UNITS {
            break;
        }
        buffer.resize(written as usize, 0);
    }
    Err(SysError(ERROR_INSUFFICIENT_BUFFER))
}

const FILE_SYSTEM_NAME_UNITS: u32 = 261;

/// The file system name and flags of the volume an open handle is on.
pub fn volume_information(handle: &OwnedHandle) -> Result<(Vec<u16>, u32), SysError> {
    let mut name = [0u16; FILE_SYSTEM_NAME_UNITS as usize];
    let mut flags = 0u32;
    // SAFETY: the handle is live; the name buffer holds the number of code
    // units passed as its size; `flags` is a local; the outputs not wanted
    // are null with a zero size, which the call allows.
    let ok = unsafe {
        GetVolumeInformationByHandleW(
            handle.0,
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut flags,
            name.as_mut_ptr(),
            FILE_SYSTEM_NAME_UNITS,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    Ok((
        name.iter().copied().take_while(|&unit| unit != 0).collect(),
        flags,
    ))
}

/// `FILE_FS_DEVICE_INFORMATION` (wdm.h): two unsigned 32-bit values.
#[derive(Default)]
#[repr(C)]
struct FsDeviceInformation {
    device_type: u32,
    characteristics: u32,
}

/// The device type and characteristics of the volume an open handle is on, by
/// handle (a drive-letter query would name another volume under a mount point).
pub fn device_information(handle: &OwnedHandle) -> Result<(u32, u32), SysError> {
    let mut info = FsDeviceInformation::default();
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: the handle is live; `io` and `info` are locals; `info` has the
    // layout of the information class asked for and its exact size is passed.
    let status = unsafe {
        NtQueryVolumeInformationFile(
            handle.0,
            &mut io,
            ptr::from_mut(&mut info).cast::<c_void>(),
            size_of::<FsDeviceInformation>() as u32,
            FileFsDeviceInformation,
        )
    };
    if status != 0 {
        return Err(SysError(status as u32));
    }
    Ok((info.device_type, info.characteristics))
}

/// Ordinal comparison with the system's own case folding, the folding the
/// file system uses for names.
pub fn equal_ignore_case(left: &[u16], right: &[u16]) -> Result<bool, SysError> {
    let (Ok(left_units), Ok(right_units)) = (i32::try_from(left.len()), i32::try_from(right.len()))
    else {
        return Err(SysError(ERROR_INVALID_PARAMETER));
    };
    // SAFETY: each pointer is valid for the count passed beside it, and the
    // call only reads.
    let result =
        unsafe { CompareStringOrdinal(left.as_ptr(), left_units, right.as_ptr(), right_units, 1) };
    match result {
        0 => Err(last_error()),
        CSTR_EQUAL => Ok(true),
        _ => Ok(false),
    }
}

/// The token of this process, opened for query only.
pub fn open_process_token() -> Result<OwnedHandle, SysError> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: the process pseudo-handle is always valid and `token` is a local
    // the call writes.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0
        || token.is_null()
    {
        return Err(last_error());
    }
    Ok(OwnedHandle(token))
}

pub fn token_is_elevated(token: &OwnedHandle) -> Result<bool, SysError> {
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0u32;
    // SAFETY: the token handle is live; `elevation` is a local of the type the
    // information class fills and its exact size is passed.
    let ok = unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            ptr::from_mut(&mut elevation).cast::<c_void>(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    Ok(elevation.TokenIsElevated != 0)
}

/// A privilege's locally unique id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Luid {
    pub low: u32,
    pub high: i32,
}

/// Every privilege the token lists, enabled or not.
pub fn token_privileges(token: &OwnedHandle) -> Result<Vec<Luid>, SysError> {
    let mut needed = 0u32;
    // SAFETY: the token handle is live; a null buffer of length zero asks only
    // for the size, which the call writes to the local `needed`.
    unsafe { GetTokenInformation(token.0, TokenPrivileges, ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(last_error());
    }
    let mut words = vec![0u32; (needed as usize).div_ceil(4)];
    let Ok(length) = u32::try_from(size_of_val(words.as_slice())) else {
        return Err(SysError(ERROR_INVALID_DATA));
    };
    // SAFETY: the token handle is live; the buffer is 4-byte aligned, as
    // TOKEN_PRIVILEGES needs, and its exact size in bytes is passed.
    let ok = unsafe {
        GetTokenInformation(
            token.0,
            TokenPrivileges,
            words.as_mut_ptr().cast::<c_void>(),
            length,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    // TOKEN_PRIVILEGES is a count, then that many records of three 32-bit
    // values: the id's low part, its high part, and the attributes.
    let mut rest = words.iter().copied();
    let count = rest.next().ok_or(SysError(ERROR_INVALID_DATA))?;
    let mut privileges = Vec::new();
    for _ in 0..count {
        let (Some(low), Some(high), Some(_attributes)) = (rest.next(), rest.next(), rest.next())
        else {
            return Err(SysError(ERROR_INVALID_DATA));
        };
        privileges.push(Luid {
            low,
            high: high as i32,
        });
    }
    Ok(privileges)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Privilege {
    Backup,
    Restore,
}

/// The id this system gives a privilege name.
pub fn privilege_luid(privilege: Privilege) -> Result<Luid, SysError> {
    let name: PCWSTR = match privilege {
        Privilege::Backup => SE_BACKUP_NAME,
        Privilege::Restore => SE_RESTORE_NAME,
    };
    let mut luid = LUID::default();
    // SAFETY: `name` is a NUL-terminated constant, the system name is null
    // (this machine) and `luid` is a local the call writes.
    if unsafe { LookupPrivilegeValueW(ptr::null(), name, &mut luid) } == 0 {
        return Err(last_error());
    }
    Ok(Luid {
        low: luid.LowPart,
        high: luid.HighPart,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Module {
    Kernel32,
    Ntdll,
}

/// Whether a system library that is always loaded exports a function.
pub fn procedure_present(module: Module, name: &CStr) -> bool {
    let module_name: PCWSTR = match module {
        Module::Kernel32 => w!("kernel32.dll"),
        Module::Ntdll => w!("ntdll.dll"),
    };
    // SAFETY: both names are NUL-terminated and outlive the calls. The module
    // handle is not counted and needs no release: both libraries stay loaded
    // for the life of every Windows process.
    unsafe {
        let module = GetModuleHandleW(module_name);
        !module.is_null() && GetProcAddress(module, name.as_ptr().cast::<u8>()).is_some()
    }
}
