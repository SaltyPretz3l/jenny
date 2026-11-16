//! Availability: API presence, the process token, the volume and the
//! self-check, behind one `SystemProbe` trait so tests inject the answers.
//!
//! The decisions are pure functions of the facts a probe returns. A check that
//! cannot tell refuses: a failed query is never read as "fine".
#![forbid(unsafe_code)]

use std::ffi::CStr;

use super::sys::{self, Module, OwnedHandle, Privilege, SysError};
use crate::abi::Status;

/// What the process token says (W10).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenFacts {
    pub elevated: bool,
    pub backup_privilege: bool,
    pub restore_privilege: bool,
}

/// What the root's volume says (W9), read by the root handle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeFacts {
    pub file_system: Vec<u16>,
    pub flags: u32,
    pub device_type: u32,
    pub characteristics: u32,
}

/// Which kind of volume was refused. The interface has no number for it yet,
/// so it stops inside the library (see the spec's as-built notes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VolumeKind {
    Network,
    Removable,
    FatOrExfat,
    Refs,
    Other,
}

/// Every system query `jfa_root_open` makes before it trusts a root.
pub trait SystemProbe {
    /// Every function the library needs resolves.
    fn api_present(&self) -> bool;
    fn token(&self) -> Result<TokenFacts, SysError>;
    /// Opens the root by its `\\?\` path, NUL-terminated.
    fn open_root(&self, path: &[u16]) -> Result<OwnedHandle, SysError>;
    fn volume(&self, root: &OwnedHandle) -> Result<VolumeFacts, SysError>;
    /// The read-only self-check on the opened root.
    fn self_check(&self, root: &OwnedHandle) -> Result<(), SysError>;
}

// Volume flags (winnt.h), device type and characteristics (wdm.h).
pub const FILE_PERSISTENT_ACLS: u32 = 0x0000_0008;
pub const FILE_SUPPORTS_REPARSE_POINTS: u32 = 0x0000_0080;
pub const FILE_DEVICE_DISK: u32 = 0x0000_0007;
pub const FILE_REMOVABLE_MEDIA: u32 = 0x0000_0001;
pub const FILE_FLOPPY_DISKETTE: u32 = 0x0000_0004;
pub const FILE_REMOTE_DEVICE: u32 = 0x0000_0010;

pub fn check_token(facts: &TokenFacts) -> Result<(), Status> {
    if facts.elevated {
        return Err(Status::Elevated);
    }
    if facts.backup_privilege || facts.restore_privilege {
        return Err(Status::BackupPrivilege);
    }
    Ok(())
}

fn name_is(units: &[u16], name: &str) -> bool {
    units.iter().copied().eq(name.encode_utf16())
}

/// Local NTFS on a fixed disk, with reparse points and persistent access
/// lists, and nothing else.
pub fn check_volume(facts: &VolumeFacts) -> Result<(), VolumeKind> {
    if facts.characteristics & FILE_REMOTE_DEVICE != 0 {
        return Err(VolumeKind::Network);
    }
    if facts.characteristics & (FILE_REMOVABLE_MEDIA | FILE_FLOPPY_DISKETTE) != 0 {
        return Err(VolumeKind::Removable);
    }
    if facts.device_type != FILE_DEVICE_DISK {
        return Err(VolumeKind::Other);
    }
    let name = facts.file_system.as_slice();
    if !name_is(name, "NTFS") {
        return Err(
            if ["FAT", "FAT12", "FAT16", "FAT32", "exFAT"]
                .iter()
                .any(|n| name_is(name, n))
            {
                VolumeKind::FatOrExfat
            } else if name_is(name, "ReFS") {
                VolumeKind::Refs
            } else {
                VolumeKind::Other
            },
        );
    }
    let needed = FILE_SUPPORTS_REPARSE_POINTS | FILE_PERSISTENT_ACLS;
    if facts.flags & needed != needed {
        return Err(VolumeKind::Other);
    }
    Ok(())
}

/// The spec's list, plus the one volume query this crate adds.
const REQUIRED: [(Module, &CStr); 8] = [
    (Module::Ntdll, c"NtCreateFile"),
    (Module::Ntdll, c"NtQueryVolumeInformationFile"),
    (Module::Ntdll, c"NtSetInformationFile"),
    (Module::Kernel32, c"GetFileInformationByHandleEx"),
    (Module::Kernel32, c"SetFileInformationByHandle"),
    (Module::Kernel32, c"GetFinalPathNameByHandleW"),
    (Module::Kernel32, c"GetVolumeInformationByHandleW"),
    (Module::Kernel32, c"FlushFileBuffers"),
];

/// The probe every export uses: it asks the system.
pub struct RealProbe;

impl SystemProbe for RealProbe {
    fn api_present(&self) -> bool {
        REQUIRED
            .iter()
            .all(|&(module, name)| sys::procedure_present(module, name))
    }

    fn token(&self) -> Result<TokenFacts, SysError> {
        #[cfg(feature = "test-seams")]
        if let Some(facts) = seam::token_facts() {
            return Ok(facts);
        }
        let token = sys::open_process_token()?;
        let listed = sys::token_privileges(&token)?;
        Ok(TokenFacts {
            elevated: sys::token_is_elevated(&token)?,
            backup_privilege: listed.contains(&sys::privilege_luid(Privilege::Backup)?),
            restore_privilege: listed.contains(&sys::privilege_luid(Privilege::Restore)?),
        })
    }

    fn open_root(&self, path: &[u16]) -> Result<OwnedHandle, SysError> {
        sys::open_root_directory(path)
    }

    fn volume(&self, root: &OwnedHandle) -> Result<VolumeFacts, SysError> {
        let (file_system, flags) = sys::volume_information(root)?;
        let (device_type, characteristics) = sys::device_information(root)?;
        Ok(VolumeFacts {
            file_system,
            flags,
            device_type,
            characteristics,
        })
    }

    /// Lists the root from a handle of its own, and opens and closes one
    /// existing child through the walk (`dir::self_check`).
    fn self_check(&self, root: &OwnedHandle) -> Result<(), SysError> {
        super::dir::self_check(root)
    }
}

/// The one seam that crosses the C interface, in the test-seams build only:
/// end-to-end tests on a runner whose own token is elevated.
#[cfg(feature = "test-seams")]
pub mod seam {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::TokenFacts;

    /// The states `jfa_test_set_token_state` accepts.
    pub const TOKEN_REAL: u32 = 0;
    pub const TOKEN_PLAIN: u32 = 1;
    pub const TOKEN_ELEVATED: u32 = 2;
    pub const TOKEN_BACKUP_PRIVILEGE: u32 = 3;
    pub const TOKEN_RESTORE_PRIVILEGE: u32 = 4;

    static TOKEN_STATE: AtomicU32 = AtomicU32::new(TOKEN_REAL);

    /// False for a state that does not exist; nothing changes then.
    pub fn set_token_state(state: u32) -> bool {
        if state > TOKEN_RESTORE_PRIVILEGE {
            return false;
        }
        TOKEN_STATE.store(state, Ordering::SeqCst);
        true
    }

    pub(super) fn token_facts() -> Option<TokenFacts> {
        let plain = TokenFacts::default();
        match TOKEN_STATE.load(Ordering::SeqCst) {
            TOKEN_PLAIN => Some(plain),
            TOKEN_ELEVATED => Some(TokenFacts {
                elevated: true,
                ..plain
            }),
            TOKEN_BACKUP_PRIVILEGE => Some(TokenFacts {
                backup_privilege: true,
                ..plain
            }),
            TOKEN_RESTORE_PRIVILEGE => Some(TokenFacts {
                restore_privilege: true,
                ..plain
            }),
            _ => None,
        }
    }
}
