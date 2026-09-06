use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Result};
use std::path::Path;

pub struct LockedImage {
    pub file: File,
    pub digest: String,
}

#[cfg(windows)]
fn open_locked(path: &Path) -> Result<File> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ};
    OpenOptions::new().read(true).share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path)
}

#[cfg(not(windows))]
fn open_locked(path: &Path) -> Result<File> { File::open(path) }

pub fn open_and_hash(path: &Path) -> Result<LockedImage> {
    let canonical = path.canonicalize()?;
    if !canonical.is_file() {
        return Err(std::io::Error::other("image identity rejected"));
    }
    let mut file = open_locked(&canonical)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(LockedImage { file, digest: hex::encode(hasher.finalize()) })
}
