//! Availability with an injected probe: an elevated token, backup and restore
//! privilege, a missing API and every unsupported kind of volume each give
//! their own status, and none leaves a root open.
//!
//! The token and API cases never open the root at all. A volume is read by the
//! root handle, so those cases open the root once, refuse it and close it.
#![cfg(windows)]

mod common;

use std::fs;

use common::{extended, identity_of, wide, Injected, TempDir};
use jenny_file_access::abi::{DetailOut, Refusal, Status};
use jenny_file_access::win::policy::{
    check_token, check_volume, RealProbe, SystemProbe, TokenFacts, VolumeFacts, VolumeKind,
    FILE_DEVICE_DISK, FILE_FLOPPY_DISKETTE, FILE_PERSISTENT_ACLS, FILE_REMOTE_DEVICE,
    FILE_REMOVABLE_MEDIA, FILE_SUPPORTS_REPARSE_POINTS,
};
use jenny_file_access::win::root::open_root;
use jenny_file_access::win::sys::{self, Luid, SysError};
use windows_sys::core::w;
use windows_sys::Win32::Foundation::LUID;
use windows_sys::Win32::Security::LookupPrivilegeValueW;

const NTFS_FLAGS: u32 = FILE_SUPPORTS_REPARSE_POINTS | FILE_PERSISTENT_ACLS;

fn volume(file_system: &str, flags: u32, device_type: u32, characteristics: u32) -> VolumeFacts {
    VolumeFacts {
        file_system: file_system.encode_utf16().collect(),
        flags,
        device_type,
        characteristics,
    }
}

/// Runs the whole root decision on a fresh real directory with one probe.
/// Returns the result and how many times the root was opened. Afterwards the
/// directory must be free: a refusal leaves no handle on it.
fn decide(probe: Injected) -> (Result<(), Refusal>, u32) {
    let temp = TempDir::new("policy");
    let root = temp.dir("project");
    let result = open_root(&probe, &wide(&root), identity_of(&root)).map(drop);
    fs::rename(&root, temp.path().join("renamed")).expect("no handle was left on the root");
    (result, probe.opens.get())
}

#[test]
fn a_missing_api_is_refused_without_opening_the_root() {
    let probe = Injected {
        api_present: false,
        ..Injected::plain()
    };
    assert_eq!(decide(probe), (Err(Refusal::of(Status::ApiMissing)), 0));
    // It is the first check: an elevated token does not change the answer.
    let elevated = TokenFacts {
        elevated: true,
        ..TokenFacts::default()
    };
    let probe = Injected {
        api_present: false,
        token: Ok(elevated),
        ..Injected::plain()
    };
    assert_eq!(decide(probe), (Err(Refusal::of(Status::ApiMissing)), 0));
}

#[test]
fn each_token_state_gives_its_status_without_opening_the_root() {
    let plain = TokenFacts::default();
    let cases = [
        (
            TokenFacts {
                elevated: true,
                ..plain
            },
            Status::Elevated,
        ),
        (
            TokenFacts {
                backup_privilege: true,
                ..plain
            },
            Status::BackupPrivilege,
        ),
        (
            TokenFacts {
                restore_privilege: true,
                ..plain
            },
            Status::BackupPrivilege,
        ),
        (
            TokenFacts {
                backup_privilege: true,
                restore_privilege: true,
                ..plain
            },
            Status::BackupPrivilege,
        ),
        (
            TokenFacts {
                elevated: true,
                backup_privilege: true,
                restore_privilege: true,
            },
            Status::Elevated,
        ),
    ];
    for (facts, status) in cases {
        assert_eq!(check_token(&facts), Err(status), "{facts:?}");
        let probe = Injected {
            token: Ok(facts),
            ..Injected::plain()
        };
        assert_eq!(decide(probe), (Err(Refusal::of(status)), 0), "{facts:?}");
    }
    assert_eq!(check_token(&plain), Ok(()));
}

#[test]
fn a_token_that_cannot_be_read_refuses() {
    let probe = Injected {
        token: Err(SysError(5)),
        ..Injected::plain()
    };
    assert_eq!(
        decide(probe),
        (Err(Refusal::system(Status::IoFailed, 5)), 0)
    );
}

#[test]
fn the_token_is_judged_before_the_roots_shape() {
    let elevated = TokenFacts {
        elevated: true,
        ..TokenFacts::default()
    };
    let probe = Injected {
        token: Ok(elevated),
        ..Injected::plain()
    };
    let drive_root: Vec<u16> = r"C:\".encode_utf16().collect();
    let identity = jenny_file_access::win::root::Identity {
        device: 1,
        inode: 1,
    };
    let result = open_root(&probe, &drive_root, identity).map(drop);
    assert_eq!(result, Err(Refusal::of(Status::Elevated)));
    assert_eq!(probe.opens.get(), 0);
}

#[test]
fn each_unsupported_volume_is_refused_and_the_root_is_closed_again() {
    let disk = FILE_DEVICE_DISK;
    let cases = [
        (volume("FAT", NTFS_FLAGS, disk, 0), VolumeKind::FatOrExfat),
        (volume("FAT32", NTFS_FLAGS, disk, 0), VolumeKind::FatOrExfat),
        (volume("exFAT", NTFS_FLAGS, disk, 0), VolumeKind::FatOrExfat),
        (volume("ReFS", NTFS_FLAGS, disk, 0), VolumeKind::Refs),
        (
            volume("NTFS", NTFS_FLAGS, disk, FILE_REMOTE_DEVICE),
            VolumeKind::Network,
        ),
        (
            volume("NTFS", NTFS_FLAGS, 0x14, FILE_REMOTE_DEVICE),
            VolumeKind::Network,
        ),
        (
            volume("NTFS", NTFS_FLAGS, disk, FILE_REMOVABLE_MEDIA),
            VolumeKind::Removable,
        ),
        (
            volume("NTFS", NTFS_FLAGS, disk, FILE_FLOPPY_DISKETTE),
            VolumeKind::Removable,
        ),
        (volume("NTFS", NTFS_FLAGS, 0x02, 0), VolumeKind::Other), // a CD-ROM device
        (volume("NTFS", NTFS_FLAGS, 0x24, 0), VolumeKind::Other), // a virtual disk device
        (
            volume("NTFS", FILE_PERSISTENT_ACLS, disk, 0),
            VolumeKind::Other,
        ),
        (
            volume("NTFS", FILE_SUPPORTS_REPARSE_POINTS, disk, 0),
            VolumeKind::Other,
        ),
        (volume("ntfs", NTFS_FLAGS, disk, 0), VolumeKind::Other),
        (volume("NTFS5", NTFS_FLAGS, disk, 0), VolumeKind::Other),
        (volume("", NTFS_FLAGS, disk, 0), VolumeKind::Other),
    ];
    for (facts, kind) in cases {
        assert_eq!(check_volume(&facts), Err(kind), "{facts:?}");
        let probe = Injected {
            volume: Some(Ok(facts.clone())),
            ..Injected::plain()
        };
        let (result, opens) = decide(probe);
        let refusal = result.expect_err("an unsupported volume");
        assert_eq!(refusal, Refusal::of(Status::VolumeUnsupported), "{facts:?}");
        // The interface has no number for the kind: the detail stays empty.
        assert_eq!(refusal.detail(), DetailOut::default(), "{facts:?}");
        assert_eq!(opens, 1, "a volume is read by the root handle: {facts:?}");
    }
}

#[test]
fn a_local_ntfs_volume_is_accepted() {
    let facts = volume(
        "NTFS",
        NTFS_FLAGS | 0x0100_0000,
        FILE_DEVICE_DISK,
        0x0002_0000,
    );
    assert_eq!(check_volume(&facts), Ok(()));
    let probe = Injected {
        volume: Some(Ok(facts)),
        ..Injected::plain()
    };
    assert_eq!(decide(probe), (Ok(()), 1));
}

#[test]
fn a_volume_that_cannot_be_read_refuses() {
    let probe = Injected {
        volume: Some(Err(SysError(1))),
        ..Injected::plain()
    };
    assert_eq!(
        decide(probe),
        (Err(Refusal::system(Status::IoFailed, 1)), 1)
    );
}

#[test]
fn a_failed_self_check_refuses_with_the_systems_code() {
    let probe = Injected {
        self_check: Some(SysError(5)),
        ..Injected::plain()
    };
    assert_eq!(
        decide(probe),
        (Err(Refusal::system(Status::SelfcheckFailed, 5)), 1)
    );
}

/// The privilege list is parsed by hand, and every injected case answers
/// "not listed", which a wrong offset or a swapped half would answer too. So
/// the parser is held against a privilege every token lists.
#[test]
fn the_privilege_list_of_the_real_token_is_read_correctly() {
    let mut luid = LUID::default();
    // SAFETY: the name is a NUL-terminated constant, the system name is null
    // (this machine) and `luid` is a local the call writes.
    let ok = unsafe {
        LookupPrivilegeValueW(std::ptr::null(), w!("SeChangeNotifyPrivilege"), &mut luid)
    };
    assert_ne!(ok, 0, "LookupPrivilegeValueW");
    let change_notify = Luid {
        low: luid.LowPart,
        high: luid.HighPart,
    };

    let token = sys::open_process_token().expect("the process token opens");
    let listed = sys::token_privileges(&token).expect("the privilege list is readable");
    assert!(!listed.is_empty());
    let zero = Luid { low: 0, high: 0 };
    assert!(!listed.contains(&zero), "an all-zero id: {listed:?}");
    let found = listed.iter().filter(|&&id| id == change_notify).count();
    assert_eq!(
        found, 1,
        "SeChangeNotifyPrivilege {change_notify:?} in {listed:?}"
    );
}

#[link(name = "shell32")]
extern "system" {
    /// Whether the caller's token has the Administrators group enabled.
    fn IsUserAnAdmin() -> i32;
}

/// The real probe against the system: it finds every API, reads this
/// process's own token the way an independent admin check does, sees the temp
/// volume as local NTFS, and refuses a really elevated process.
#[test]
fn the_real_probe_agrees_with_the_system() {
    assert!(RealProbe.api_present());

    let facts = RealProbe.token().expect("the process token is readable");
    // SAFETY: the call takes no arguments and only reads the caller's token.
    let admin = unsafe { IsUserAnAdmin() } != 0;
    assert_eq!(
        facts.elevated, admin,
        "TokenElevation against IsUserAnAdmin"
    );

    let temp = TempDir::new("real");
    let root = temp.dir("project");
    let handle = RealProbe
        .open_root(&extended(&root))
        .expect("the root opens");
    let volume = RealProbe.volume(&handle).expect("the volume is readable");
    assert_eq!(
        check_volume(&volume),
        Ok(()),
        "the temp directory must be on local NTFS: {volume:?}"
    );
    assert_eq!(RealProbe.self_check(&handle), Ok(()));
    drop(handle);

    let result = open_root(&RealProbe, &wide(&root), identity_of(&root)).map(drop);
    match check_token(&facts) {
        Ok(()) => assert_eq!(result, Ok(()), "a plain token pins"),
        Err(status) => assert_eq!(result, Err(Refusal::of(status)), "this token is refused"),
    }

    // The seam is process-wide, so it is exercised here, after the real
    // token was read, and not in a test that could run beside this one.
    #[cfg(feature = "test-seams")]
    the_token_seam_replaces_the_real_token(facts, &root);
}

#[cfg(feature = "test-seams")]
fn the_token_seam_replaces_the_real_token(real: TokenFacts, root: &std::path::Path) {
    use jenny_file_access::jfa_test_set_token_state;
    use jenny_file_access::win::policy::seam;

    let plain = TokenFacts::default();
    let pin = |probe: &RealProbe| open_root(probe, &wide(root), identity_of(root)).map(drop);
    // The real token comes back when this test ends, however it ends.
    let _reset = common::SeamToken::set(seam::TOKEN_ELEVATED);
    assert_eq!(
        RealProbe.token(),
        Ok(TokenFacts {
            elevated: true,
            ..plain
        })
    );
    assert_eq!(pin(&RealProbe), Err(Refusal::of(Status::Elevated)));
    assert_eq!(
        jfa_test_set_token_state(seam::TOKEN_BACKUP_PRIVILEGE),
        Status::Ok.code()
    );
    assert_eq!(
        RealProbe.token(),
        Ok(TokenFacts {
            backup_privilege: true,
            ..plain
        })
    );
    assert_eq!(
        jfa_test_set_token_state(seam::TOKEN_RESTORE_PRIVILEGE),
        Status::Ok.code()
    );
    assert_eq!(
        RealProbe.token(),
        Ok(TokenFacts {
            restore_privilege: true,
            ..plain
        })
    );
    assert_eq!(
        jfa_test_set_token_state(seam::TOKEN_PLAIN),
        Status::Ok.code()
    );
    assert_eq!(RealProbe.token(), Ok(plain));
    assert_eq!(
        pin(&RealProbe),
        Ok(()),
        "a plain token pins, whatever the real one is"
    );
    assert_eq!(
        jfa_test_set_token_state(5),
        Status::InvalidArgument.code(),
        "no such state"
    );
    assert_eq!(
        RealProbe.token(),
        Ok(plain),
        "a refused state changes nothing"
    );
    assert_eq!(
        jfa_test_set_token_state(seam::TOKEN_REAL),
        Status::Ok.code()
    );
    assert_eq!(RealProbe.token(), Ok(real));
}
