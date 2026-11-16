//! The system calls below the root: the relative open, the queries a walk
//! and a listing make by handle, and the write's read, write, flush, rename,
//! delete and random source. A child of `win/sys.rs`, which it extends:
//! the same rules hold, and `unsafe` here is the `win::sys` module's.

use std::ffi::c_void;
use std::mem::offset_of;
use std::ptr;

use windows_sys::Wdk::Storage::FileSystem::{
    FileRenameInformation, FileRenameInformationEx, NtSetInformationFile, FILE_OPEN_REPARSE_POINT,
    FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{
    ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, ERROR_WRITE_FAULT, HANDLE, NTSTATUS,
    OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, STATUS_OBJECT_NAME_INVALID, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    FileBasicInfo, FileDispositionInfo, FileDispositionInfoEx, FileIdBothDirectoryInfo,
    FileIdBothDirectoryRestartInfo, FlushFileBuffers, GetFileInformationByHandleEx, GetFileType,
    ReadFile, SetFileInformationByHandle, WriteFile, FILE_BASIC_INFO, FILE_DISPOSITION_FLAG_DELETE,
    FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX,
    FILE_RENAME_INFO, FILE_RENAME_INFO_0, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK,
    SYNCHRONIZE,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

use super::{last_error, OwnedHandle, SysError};

/// `OBJECT_ATTRIBUTES` (wdm.h). windows-sys carries it, and `NtCreateFile`,
/// only under its `Wdk_Foundation` feature, which the shipped library does not
/// enable; a unit test below checks this layout against windows-sys's.
#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *const UNICODE_STRING,
    attributes: u32,
    security_descriptor: *const c_void,
    security_quality_of_service: *const c_void,
}

#[link(name = "ntdll.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    fn NtCreateFile(
        handle: *mut HANDLE,
        access: u32,
        attributes: *const ObjectAttributes,
        io: *mut IO_STATUS_BLOCK,
        allocation_size: *const i64,
        file_attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea_buffer: *const c_void,
        ea_length: u32,
    ) -> NTSTATUS;
}

/// What one relative open asks for. Delete sharing is masked off.
#[derive(Clone, Copy, Debug)]
pub struct Open {
    pub access: u32,
    pub share: u32,
    pub disposition: u32,
    pub options: u32,
}

/// Opens one component relative to an open directory (W2): never through a
/// reparse point, as the link object itself, case-insensitive, synchronous and
/// not inheritable. An empty name opens `parent` again as a handle of its own.
pub fn open_relative(
    parent: &OwnedHandle,
    name: &[u16],
    open: Open,
) -> Result<OwnedHandle, SysError> {
    let invalid = SysError(STATUS_OBJECT_NAME_INVALID as u32);
    let bytes = u16::try_from(size_of_val(name)).map_err(|_| invalid)?;
    let object_name = UNICODE_STRING {
        Length: bytes,
        MaximumLength: bytes,
        Buffer: name.as_ptr().cast_mut(),
    };
    let attributes = ObjectAttributes {
        length: size_of::<ObjectAttributes>() as u32,
        root_directory: parent.0,
        object_name: &object_name,
        attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        security_descriptor: ptr::null(),
        security_quality_of_service: ptr::null(),
    };
    let mut handle: HANDLE = ptr::null_mut();
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: every pointer is to a local or to `name`, all alive for the call; the name's byte count is its slice's; `parent` is live.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            open.access | SYNCHRONIZE,
            &attributes,
            &mut io,
            ptr::null(),
            0,
            open.share & (FILE_SHARE_READ | FILE_SHARE_WRITE),
            open.disposition,
            open.options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    };
    if status < 0 || handle.is_null() {
        return Err(SysError(status as u32));
    }
    Ok(OwnedHandle(handle))
}

/// The change time (`FILE_BASIC_INFO`), which no caller can set back.
pub fn change_time(handle: &OwnedHandle) -> Result<i64, SysError> {
    let mut info = FILE_BASIC_INFO::default();
    let size = size_of::<FILE_BASIC_INFO>() as u32;
    let out = ptr::from_mut(&mut info).cast::<c_void>();
    // SAFETY: the handle is live; `info` is a local of the class's type and its exact size is passed.
    if unsafe { GetFileInformationByHandleEx(handle.0, FileBasicInfo, out, size) } == 0 {
        return Err(last_error());
    }
    Ok(info.ChangeTime)
}

/// Whether an open file is a disk file (W6), not a pipe or a character device.
pub fn is_disk_file(handle: &OwnedHandle) -> Result<bool, SysError> {
    // SAFETY: the handle is live; the call only reads it.
    let kind = unsafe { GetFileType(handle.0) };
    if kind == 0 {
        // Unknown type, or a failure: the last error says which.
        let error = last_error();
        if error.0 != 0 {
            return Err(error);
        }
    }
    Ok(kind == FILE_TYPE_DISK)
}

/// The bytes of a records buffer, in place.
pub fn record_bytes(words: &[u64]) -> &[u8] {
    // SAFETY: a `u64` slice is initialized and has no padding, `u8` needs no alignment, and the view covers exactly the slice's memory for the slice's lifetime.
    unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), size_of_val(words)) }
}

/// Fills `buffer` with the next `FILE_ID_BOTH_DIR_INFO` records of an open
/// directory, from its first entry when `restart`. `Ok(false)` at the end.
pub fn directory_records(
    handle: &OwnedHandle,
    restart: bool,
    buffer: &mut [u64],
) -> Result<bool, SysError> {
    let class = if restart {
        FileIdBothDirectoryRestartInfo
    } else {
        FileIdBothDirectoryInfo
    };
    let size = u32::try_from(size_of_val(buffer)).map_err(|_| SysError(ERROR_INVALID_PARAMETER))?;
    let out = buffer.as_mut_ptr().cast::<c_void>();
    // SAFETY: the handle is live; the buffer is 8-byte aligned, as the class needs, and `size` is its exact size in bytes.
    if unsafe { GetFileInformationByHandleEx(handle.0, class, out, size) } != 0 {
        return Ok(true);
    }
    match last_error() {
        SysError(ERROR_NO_MORE_FILES) => Ok(false),
        error => Err(error),
    }
}

/// The most one `WriteFile` call is handed.
const WRITE_CHUNK: usize = 8 * 1024 * 1024;

/// Writes every byte at the file's position, at most 8 MiB per call. A write
/// that moves nothing is a failure, never a loop.
pub fn write_all(handle: &OwnedHandle, mut bytes: &[u8]) -> Result<(), SysError> {
    while !bytes.is_empty() {
        // At most 8 MiB, so it fits a u32.
        let chunk = bytes.len().min(WRITE_CHUNK) as u32;
        let mut written = 0u32;
        // SAFETY: the handle is live and synchronous; `bytes` is valid for `chunk` reads; `written` is a local; no overlapped structure.
        let ok = unsafe {
            WriteFile(
                handle.0,
                bytes.as_ptr(),
                chunk,
                &mut written,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        if written == 0 {
            return Err(SysError(ERROR_WRITE_FAULT));
        }
        bytes = bytes.get(written as usize..).unwrap_or_default();
    }
    Ok(())
}

/// Reads until `buffer` is full or the file ends; returns the bytes read.
pub fn read_up_to(handle: &OwnedHandle, buffer: &mut [u8]) -> Result<usize, SysError> {
    let mut filled = 0usize;
    while let Some(rest) = buffer.get_mut(filled..).filter(|rest| !rest.is_empty()) {
        let chunk = u32::try_from(rest.len()).unwrap_or(u32::MAX);
        let mut read = 0u32;
        // SAFETY: the handle is live and synchronous; `rest` is valid for `chunk` writes; `read` is a local; no overlapped structure.
        let ok = unsafe {
            ReadFile(
                handle.0,
                rest.as_mut_ptr(),
                chunk,
                &mut read,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        if read == 0 {
            break;
        }
        filled = filled.saturating_add(read as usize);
    }
    Ok(filled)
}

/// `FlushFileBuffers` on an open file.
pub fn flush(handle: &OwnedHandle) -> Result<(), SysError> {
    // SAFETY: the handle is live; the call only names it.
    if unsafe { FlushFileBuffers(handle.0) } == 0 {
        return Err(last_error());
    }
    Ok(())
}

/// Which rename class a rename uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenameClass {
    /// `FileRenameInformationEx`, with POSIX semantics.
    Extended,
    /// `FileRenameInformation`, the fallback where the extended class is refused.
    Plain,
}

const RENAME_REPLACE_IF_EXISTS: u32 = 0x1;
const RENAME_POSIX_SEMANTICS: u32 = 0x2;

/// Renames an open file to `name` inside `directory`, by handle (spike fact
/// 8: only `NtSetInformationFile` honours the root directory). `Err` carries
/// the NTSTATUS.
pub fn rename_into(
    file: &OwnedHandle,
    directory: &OwnedHandle,
    name: &[u16],
    replace: bool,
    class: RenameClass,
) -> Result<(), SysError> {
    let invalid = SysError(STATUS_OBJECT_NAME_INVALID as u32);
    let name_bytes = u32::try_from(size_of_val(name)).map_err(|_| invalid)?;
    let (information_class, flags) = match class {
        RenameClass::Extended => (
            FileRenameInformationEx,
            RENAME_POSIX_SEMANTICS | if replace { RENAME_REPLACE_IF_EXISTS } else { 0 },
        ),
        // The plain class reads the first byte as `ReplaceIfExists`.
        RenameClass::Plain => (FileRenameInformation, u32::from(replace)),
    };
    // The structure's size plus the name's bytes, as kernel32 insists (spike
    // fact 8), in 8-byte words for the structure's alignment.
    let bytes = size_of::<FILE_RENAME_INFO>() + size_of_val(name);
    let length = u32::try_from(bytes).map_err(|_| invalid)?;
    let mut words = vec![0u64; bytes.div_ceil(8)];
    let base = words.as_mut_ptr().cast::<u8>();
    let info = FILE_RENAME_INFO {
        Anonymous: FILE_RENAME_INFO_0 { Flags: flags },
        RootDirectory: directory.0,
        FileNameLength: name_bytes,
        FileName: [0],
    };
    // SAFETY: `words` is 8-byte aligned and holds `bytes` bytes, at least the structure's size, so the structure fits at its start and `name` fits from the name field's offset to the end.
    unsafe {
        base.cast::<FILE_RENAME_INFO>().write(info);
        let name_at = base
            .add(offset_of!(FILE_RENAME_INFO, FileName))
            .cast::<u16>();
        ptr::copy_nonoverlapping(name.as_ptr(), name_at, name.len());
    }
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: both handles are live; `io` is a local; the buffer is valid for `length` bytes and outlives the call.
    let status =
        unsafe { NtSetInformationFile(file.0, &mut io, base.cast(), length, information_class) };
    if status < 0 {
        return Err(SysError(status as u32));
    }
    Ok(())
}

/// Marks an open file for deletion; its name goes when the handle closes
/// (spike fact 10). POSIX semantics first, the plain class as fallback.
pub fn delete_on_close(handle: &OwnedHandle) -> Result<(), SysError> {
    let mut extended = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    let out = ptr::from_mut(&mut extended).cast::<c_void>();
    let size = size_of::<FILE_DISPOSITION_INFO_EX>() as u32;
    // SAFETY: the handle is live; `extended` is a local of the class's type and its exact size is passed.
    if unsafe { SetFileInformationByHandle(handle.0, FileDispositionInfoEx, out, size) } != 0 {
        return Ok(());
    }
    let mut plain = FILE_DISPOSITION_INFO { DeleteFile: true };
    let out = ptr::from_mut(&mut plain).cast::<c_void>();
    let size = size_of::<FILE_DISPOSITION_INFO>() as u32;
    // SAFETY: as above, with the plain class's type and size.
    if unsafe { SetFileInformationByHandle(handle.0, FileDispositionInfo, out, size) } == 0 {
        return Err(last_error());
    }
    Ok(())
}

/// `BCRYPT_USE_SYSTEM_PREFERRED_RNG` (bcrypt.h).
const SYSTEM_PREFERRED_RNG: u32 = 0x2;

#[link(name = "bcrypt.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    fn BCryptGenRandom(
        algorithm: *mut c_void,
        buffer: *mut u8,
        length: u32,
        flags: u32,
    ) -> NTSTATUS;
}

/// Fills `buffer` from the system's random source.
pub fn random_bytes(buffer: &mut [u8; 16]) -> Result<(), SysError> {
    // SAFETY: no algorithm handle with the system-preferred flag; the buffer is a live array of the length passed.
    let status = unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(SysError(status as u32));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::mem::{align_of, offset_of, size_of};

    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;

    use super::ObjectAttributes;

    /// The hand-declared structure has windows-sys's layout, field by field.
    #[test]
    fn object_attributes_match_windows_sys() {
        assert_eq!(
            size_of::<ObjectAttributes>(),
            size_of::<OBJECT_ATTRIBUTES>()
        );
        assert_eq!(
            align_of::<ObjectAttributes>(),
            align_of::<OBJECT_ATTRIBUTES>()
        );
        let ours = [
            offset_of!(ObjectAttributes, length),
            offset_of!(ObjectAttributes, root_directory),
            offset_of!(ObjectAttributes, object_name),
            offset_of!(ObjectAttributes, attributes),
            offset_of!(ObjectAttributes, security_descriptor),
            offset_of!(ObjectAttributes, security_quality_of_service),
        ];
        let theirs = [
            offset_of!(OBJECT_ATTRIBUTES, Length),
            offset_of!(OBJECT_ATTRIBUTES, RootDirectory),
            offset_of!(OBJECT_ATTRIBUTES, ObjectName),
            offset_of!(OBJECT_ATTRIBUTES, Attributes),
            offset_of!(OBJECT_ATTRIBUTES, SecurityDescriptor),
            offset_of!(OBJECT_ATTRIBUTES, SecurityQualityOfService),
        ];
        assert_eq!(ours, theirs);
    }
}
