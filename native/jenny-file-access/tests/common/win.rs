//! Helpers for the Windows tests. Every file is made under a temp directory
//! the test creates and removes; nothing needs elevation.

use std::cell::Cell;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use jenny_file_access::abi::{DetailOut, Refusal, Status};
use jenny_file_access::pins::{Kind as PinKind, Table};
use jenny_file_access::win::dir;
use jenny_file_access::win::policy::{RealProbe, SystemProbe, TokenFacts, VolumeFacts};
use jenny_file_access::win::root::{pin_root, pinned_handle, Identity, RootPin};
use jenny_file_access::win::sys::{OwnedHandle, SysError};
use jenny_file_access::win::walk::{self, OpenFile};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{
    HANDLE, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, GetShortPathNameW, BY_HANDLE_FILE_INFORMATION,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE,
};
use windows_sys::Win32::System::IO::{DeviceIoControl, IO_STATUS_BLOCK};

use super::units_of;

pub const ERROR_ACCESS_DENIED: i32 = 5;
pub const ERROR_SHARING_VIOLATION: i32 = 32;

/// What a test leaves in a detail before a call, to see that the call wrote it.
pub const STALE_DETAIL: DetailOut = DetailOut {
    reason: 99,
    system: 99,
};

pub fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().collect()
}

/// A path in its `\\?\` form with a terminator, as the root open takes it.
pub fn extended(path: &Path) -> Vec<u16> {
    let mut units = units_of(r"\\?\");
    units.extend(wide(path));
    units.push(0);
    units
}

/// A directory of this test's own, under the real (final) temp path, removed
/// when the value is dropped.
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        // The final path, so no component is a link or a short alias.
        let base = fs::canonicalize(std::env::temp_dir()).expect("the temp directory resolves");
        let base = base.to_str().expect("a text temp path");
        let base = PathBuf::from(base.strip_prefix(r"\\?\").unwrap_or(base));
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.subsec_nanos());
        let name = format!(
            "jfa-{label}-{}-{}-{nanos}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        let path = base.join(name);
        fs::create_dir(&path).expect("the test directory is new");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Creates and returns a directory below this one.
    pub fn dir(&self, name: &str) -> PathBuf {
        let path = self.path.join(name);
        fs::create_dir_all(&path).expect("a directory below the test directory");
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Does not follow links: a junction is removed as a link.
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Opens a directory the way std allows, shared for read, write and delete.
pub fn open_directory(path: &Path, write: bool, flags: u32) -> File {
    OpenOptions::new()
        .read(true)
        .write(write)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | flags)
        .open(path)
        .expect("the directory opens")
}

/// The volume serial number and file index of a path, read by this test's own
/// call, not through the library.
pub fn identity_of(path: &Path) -> Identity {
    let directory = open_directory(path, false, 0);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is open for the length of the call and `info` is a
    // local of the type the call fills.
    let ok = unsafe { GetFileInformationByHandle(directory.as_raw_handle() as HANDLE, &mut info) };
    assert_ne!(ok, 0, "GetFileInformationByHandle");
    Identity {
        device: u64::from(info.dwVolumeSerialNumber),
        inode: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    }
}

/// The 8.3 form of an existing path, as the system gives it. Where the volume
/// makes no short names it is the path unchanged.
pub fn short_path(path: &Path) -> PathBuf {
    let mut long = wide(path);
    long.push(0);
    let mut buffer = vec![0u16; 32_768];
    // SAFETY: `long` ends with a NUL and the buffer holds the number of code
    // units passed as its size.
    let written = unsafe { GetShortPathNameW(long.as_ptr(), buffer.as_mut_ptr(), 32_768) };
    assert!(written > 0 && written < 32_768, "GetShortPathNameW");
    buffer.truncate(written as usize);
    PathBuf::from(OsString::from_wide(&buffer))
}

const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;

/// Makes `link` a junction to `target`. A junction needs no privilege.
pub fn make_junction(link: &Path, target: &Path) {
    fs::create_dir(link).expect("the junction's directory is new");
    let directory = open_directory(link, true, FILE_FLAG_OPEN_REPARSE_POINT);
    let target = target.to_str().expect("a text target");
    let substitute = units_of(&format!(r"\??\{target}"));
    let print = units_of(target);
    let (substitute_bytes, print_bytes) = (substitute.len() * 2, print.len() * 2);
    let field = |value: usize| u16::try_from(value).expect("a short path").to_le_bytes();
    // REPARSE_DATA_BUFFER for a mount point: the tag, the data length, a
    // reserved word, four name fields, then both names with terminators.
    let mut data: Vec<u8> = Vec::new();
    data.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    data.extend(field(8 + substitute_bytes + 2 + print_bytes + 2));
    data.extend(field(0));
    data.extend(field(0));
    data.extend(field(substitute_bytes));
    data.extend(field(substitute_bytes + 2));
    data.extend(field(print_bytes));
    for unit in substitute.iter().chain(&[0]).chain(&print).chain(&[0]) {
        data.extend(unit.to_le_bytes());
    }
    let mut returned = 0u32;
    // SAFETY: the handle is open for the length of the call; the input buffer
    // is valid for the length passed; there is no output buffer and no
    // overlapped structure.
    let ok = unsafe {
        DeviceIoControl(
            directory.as_raw_handle() as HANDLE,
            FSCTL_SET_REPARSE_POINT,
            data.as_ptr().cast(),
            u32::try_from(data.len()).expect("a short buffer"),
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(
        ok,
        0,
        "FSCTL_SET_REPARSE_POINT: {}",
        std::io::Error::last_os_error()
    );
}

/// A tag without the Microsoft bit: a third-party reparse point, which needs
/// no privilege to set and no driver to exist.
const THIRD_PARTY_TAG: u32 = 0x0000_1234;

/// Gives an existing file, or an empty directory, a third-party reparse
/// point (`REPARSE_GUID_DATA_BUFFER`). Works while another handle holds it
/// shared for read and write.
pub fn set_third_party_reparse_point(path: &Path) {
    let target = OpenOptions::new()
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .expect("opens for the reparse point");
    let payload = b"jenny-test";
    let mut data: Vec<u8> = Vec::new();
    data.extend(THIRD_PARTY_TAG.to_le_bytes());
    data.extend(u16::try_from(payload.len()).expect("short").to_le_bytes());
    data.extend(0u16.to_le_bytes());
    data.extend([0x4A; 16]); // Any GUID: nothing interprets it.
    data.extend(payload);
    let mut returned = 0u32;
    // SAFETY: the handle is open for the length of the call; the input buffer
    // is valid for the length passed; there is no output buffer and no
    // overlapped structure.
    let ok = unsafe {
        DeviceIoControl(
            target.as_raw_handle() as HANDLE,
            FSCTL_SET_REPARSE_POINT,
            data.as_ptr().cast(),
            u32::try_from(data.len()).expect("a short buffer"),
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(
        ok,
        0,
        "FSCTL_SET_REPARSE_POINT with a third-party tag: {}",
        std::io::Error::last_os_error()
    );
}

/// True when a rename fails the way a pinned directory makes it fail.
pub fn rename_is_denied(from: &Path, to: &Path) -> bool {
    match fs::rename(from, to) {
        Ok(()) => false,
        Err(error) => {
            let code = error.raw_os_error();
            assert!(
                code == Some(ERROR_SHARING_VIOLATION) || code == Some(ERROR_ACCESS_DENIED),
                "an unexpected rename failure: {error}"
            );
            true
        }
    }
}

/// A token seam state for the length of a test. The real token comes back
/// when the value is dropped, also when an assertion fails first.
#[cfg(feature = "test-seams")]
pub struct SeamToken;

#[cfg(feature = "test-seams")]
impl SeamToken {
    pub fn set(state: u32) -> Self {
        assert_eq!(jenny_file_access::jfa_test_set_token_state(state), 0);
        Self
    }
}

#[cfg(feature = "test-seams")]
impl Drop for SeamToken {
    fn drop(&mut self) {
        use jenny_file_access::win::policy::seam::TOKEN_REAL;
        let _ = jenny_file_access::jfa_test_set_token_state(TOKEN_REAL);
    }
}

/// A probe whose answers a test sets. What is left unset asks the system, so
/// a test can inject one answer on a real directory.
pub struct Injected {
    pub api_present: bool,
    pub token: Result<TokenFacts, SysError>,
    pub volume: Option<Result<VolumeFacts, SysError>>,
    pub self_check: Option<SysError>,
    /// How many times the root was opened through this probe.
    pub opens: Cell<u32>,
    /// How many times the self-check ran through this probe.
    pub self_checks: Cell<u32>,
}

impl Injected {
    /// Everything real except the token, which is a plain user's. The tests of
    /// the root itself use it so they also run on an elevated runner.
    pub fn plain() -> Self {
        Self {
            api_present: true,
            token: Ok(TokenFacts::default()),
            volume: None,
            self_check: None,
            opens: Cell::new(0),
            self_checks: Cell::new(0),
        }
    }
}

impl SystemProbe for Injected {
    fn api_present(&self) -> bool {
        self.api_present
    }

    fn token(&self) -> Result<TokenFacts, SysError> {
        self.token
    }

    fn open_root(&self, path: &[u16]) -> Result<OwnedHandle, SysError> {
        self.opens.set(self.opens.get() + 1);
        RealProbe.open_root(path)
    }

    fn volume(&self, root: &OwnedHandle) -> Result<VolumeFacts, SysError> {
        match &self.volume {
            Some(answer) => answer.clone(),
            None => RealProbe.volume(root),
        }
    }

    fn self_check(&self, root: &OwnedHandle) -> Result<(), SysError> {
        self.self_checks.set(self.self_checks.get() + 1);
        match self.self_check {
            Some(error) => Err(error),
            None => RealProbe.self_check(root),
        }
    }
}

/// A segment list: every segment ends with U+0000.
pub fn segments(parts: &[&str]) -> Vec<u16> {
    parts
        .iter()
        .flat_map(|part| units_of(part).into_iter().chain([0]))
        .collect()
}

/// Decodes a listing buffer into (flags, size, name) records, sorted by name.
pub fn records(buffer: &[u8]) -> Vec<(u32, u64, String)> {
    let mut rest = buffer;
    let mut out = Vec::new();
    while !rest.is_empty() {
        let flags = u32::from_le_bytes(rest[0..4].try_into().expect("flags"));
        let size = u64::from_le_bytes(rest[4..12].try_into().expect("size"));
        let units = usize::from(u16::from_le_bytes(rest[12..14].try_into().expect("count")));
        let name: Vec<u16> = rest[14..14 + 2 * units]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&pair| u16::from_le_bytes(pair))
            .collect();
        out.push((flags, size, String::from_utf16_lossy(&name)));
        rest = &rest[14 + 2 * units..];
    }
    out.sort_by(|left, right| left.2.cmp(&right.2));
    out
}

/// A temp project pinned through the safe core, with tables of its own: the
/// tests reach the library below the exports, with a plain token, so they
/// also run where the test process is elevated.
pub struct Project {
    pub temp: TempDir,
    pub root: PathBuf,
    pub pins: Table<RootPin>,
    pub files: Table<OpenFile>,
    pub pin: u64,
}

impl Project {
    pub fn new(label: &str) -> Self {
        let temp = TempDir::new(label);
        let root = temp.dir("project");
        let pins = Table::new(PinKind::Pin, 4);
        let pin = pin_root(&Injected::plain(), &pins, &wide(&root), identity_of(&root))
            .expect("the project pins");
        Self {
            temp,
            root,
            pins,
            files: Table::new(PinKind::File, 16),
            pin,
        }
    }

    /// A duplicate of the pinned root, as every operation starts.
    pub fn root_handle(&self) -> OwnedHandle {
        pinned_handle(&self.pins, self.pin)
            .expect("the pin answers")
            .0
    }

    /// Opens, takes, reads, re-checks and closes, as the client does.
    pub fn read(&self, parts: &[&str]) -> Result<Vec<u8>, Refusal> {
        let token = walk::file_open(&self.pins, &self.files, self.pin, &segments(parts))?;
        let value = walk::file_take(&self.files, token).expect("a first take");
        // SAFETY: the library handed this value out once; the File owns it now.
        let mut file = unsafe { File::from_raw_handle(value as *mut _) };
        let mut content = Vec::new();
        file.read_to_end(&mut content)
            .expect("the taken handle reads");
        let checked = walk::file_check(&self.files, token);
        walk::file_close(&self.files, token, false).expect("a first close");
        checked.map(|()| content)
    }

    /// Lists through the safe core into a buffer large enough.
    pub fn list(&self, parts: &[&str], max: u32) -> Result<Vec<(u32, u64, String)>, Refusal> {
        let mut buffer = vec![0u8; 1 << 20];
        let listing = dir::list(self.root_handle(), &segments(parts), max, &mut buffer)?;
        assert!(listing.complete, "a megabyte holds the listing");
        Ok(records(&buffer[..listing.bytes_used]))
    }
}

/// Closes a pin when the test ends, also when an assertion fails first.
pub struct ClosePin(pub u64);

impl Drop for ClosePin {
    fn drop(&mut self) {
        let _ = jenny_file_access::jfa_pin_close(self.0);
    }
}

#[cfg(feature = "test-seams")]
pub fn a_token_the_exports_accept() -> Option<SeamToken> {
    use jenny_file_access::win::policy::seam::TOKEN_PLAIN;
    Some(SeamToken::set(TOKEN_PLAIN))
}

#[cfg(not(feature = "test-seams"))]
pub fn a_token_the_exports_accept() -> Option<()> {
    use jenny_file_access::win::policy::{check_token, RealProbe, SystemProbe};
    let facts = RealProbe.token().expect("the process token is readable");
    check_token(&facts).ok()
}

/// Pins `root` through the export.
pub fn export_pin(root: &Path) -> u64 {
    let identity = identity_of(root);
    let units = wide(root);
    let (mut pin, mut detail) = (0u64, STALE_DETAIL);
    // SAFETY: the root buffer is valid for its length and both out-pointers
    // point at locals.
    let status = unsafe {
        jenny_file_access::jfa_root_open(
            units.as_ptr(),
            u32::try_from(units.len()).expect("a short path"),
            identity.device,
            identity.inode,
            &mut pin,
            &mut detail,
        )
    };
    assert_eq!(status, Status::Ok.code(), "the root pins: {detail:?}");
    pin
}

/// The names in a directory, sorted.
pub fn names_in(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .expect("the directory lists")
        .map(|entry| {
            let entry = entry.expect("an entry");
            entry.file_name().to_string_lossy().into_owned()
        })
        .collect();
    names.sort();
    names
}

/// True when `path` is a real directory, not a junction.
pub fn plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

/// Every name that looks like the write's temp (`.host-*.tmp`) at or below
/// `directory`, junctions not followed.
pub fn temps(directory: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(directory) else {
        return found;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".host-") && name.ends_with(".tmp") {
            found.push(name);
        }
        if plain_directory(&entry.path()) {
            found.extend(temps(&entry.path()));
        }
    }
    found
}

/// Sets or clears the read-only attribute.
pub fn set_readonly(path: &Path, readonly: bool) {
    let mut permissions = fs::metadata(path).expect("metadata").permissions();
    #[allow(clippy::permissions_set_readonly_false)] // Puts files back for the temp directory.
    permissions.set_readonly(readonly);
    fs::set_permissions(path, permissions).expect("the attribute is set");
}

/// Three directory names of 200 characters: with a file below them, a path
/// far past 260 characters.
pub fn long_segments() -> [String; 3] {
    ["a", "b", "c"].map(|letter| letter.repeat(200))
}

/// Makes the three long directories below `root` and `f.txt` holding `deep`
/// in the last one; returns that directory.
pub fn make_deep_file(root: &Path) -> PathBuf {
    let [a, b, c] = long_segments();
    let deep = root.join(a).join(b).join(c);
    fs::create_dir_all(&deep).expect("long directories");
    fs::write(deep.join("f.txt"), b"deep").expect("a deep file");
    assert!(wide(&deep.join("f.txt")).len() > 600);
    deep
}

/// The object attributes every walk open sets.
pub const WALK_ATTRIBUTES: u32 = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE;

/// One relative `NtCreateFile` of one component, as the walk makes it, by
/// the test's own declaration (windows-sys's, under its `Wdk_Foundation`
/// feature), not the library's.
pub fn nt_open(
    parent: &File,
    name: &str,
    access: u32,
    disposition: u32,
    options: u32,
    attributes: u32,
) -> Result<File, u32> {
    let name_units = units_of(name);
    let bytes = u16::try_from(name_units.len() * 2).expect("a short name");
    let object_name = UNICODE_STRING {
        Length: bytes,
        MaximumLength: bytes,
        Buffer: name_units.as_ptr().cast_mut(),
    };
    let object_attributes = OBJECT_ATTRIBUTES {
        Length: u32::try_from(size_of::<OBJECT_ATTRIBUTES>()).expect("a small structure"),
        RootDirectory: parent.as_raw_handle() as HANDLE,
        ObjectName: &object_name,
        Attributes: attributes,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut handle: HANDLE = std::ptr::null_mut();
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: every pointer is to a local that outlives the call; the name
    // buffer holds the bytes its UNICODE_STRING says; the parent is open.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE | FILE_READ_ATTRIBUTES,
            &object_attributes,
            &mut io,
            std::ptr::null(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            disposition,
            options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            std::ptr::null(),
            0,
        )
    };
    if status != 0 {
        return Err(status as u32);
    }
    // SAFETY: the call succeeded, so `handle` is a new handle this test owns.
    Ok(unsafe { File::from_raw_handle(handle.cast()) })
}
