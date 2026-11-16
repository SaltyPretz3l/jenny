//! The numbers of the frozen interface, ABI version 1. Pure.
//!
//! `abi.json` beside the crate is the one written copy of the interface. Every
//! constant here is compared with it by `tests/abi.rs`, and the Python client's
//! `ctypes` table is compared with it by its own test.
#![forbid(unsafe_code)]

pub const ABI_VERSION: u32 = 1;

/// One numbered list of the interface, written once: the enum, and the same
/// list as `(name, value)` pairs in the spelling of `abi.json`.
macro_rules! numbered {
    ($(#[$meta:meta])* $name:ident as $repr:ident { $($variant:ident = $value:literal, $text:literal;)* }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        #[repr($repr)]
        pub enum $name {
            $($variant = $value,)*
        }

        impl $name {
            pub const ALL: &'static [(&'static str, $name)] = &[$(($text, $name::$variant),)*];

            pub const fn code(self) -> $repr {
                self as $repr
            }
        }
    };
}

numbered! {
    /// What an export returns. Values 20 and above come from `jfa_root_open` only.
    Status as i32 {
        Ok = 0, "ok";
        PathRefused = 1, "path_refused";
        NotFound = 2, "not_found";
        IoFailed = 3, "io_failed";
        Busy = 4, "busy";
        DurabilityUncertain = 5, "durability_uncertain";
        BufferTooSmall = 6, "buffer_too_small";
        InvalidArgument = 7, "invalid_argument";
        Internal = 8, "internal";
        PlatformUnsupported = 9, "platform_unsupported";
        ApiMissing = 20, "api_missing";
        Elevated = 21, "elevated";
        BackupPrivilege = 22, "backup_privilege";
        VolumeUnsupported = 23, "volume_unsupported";
        RootInvalid = 24, "root_invalid";
        RootIdentity = 25, "root_identity";
        SelfcheckFailed = 26, "selfcheck_failed";
    }
}

impl Status {
    pub const fn root_open_only(self) -> bool {
        self.code() >= Status::ApiMissing.code()
    }
}

numbered! {
    /// The first number of the detail pair. Not `None` only beside `Status::PathRefused`.
    Reason as u32 {
        None = 0, "none";
        NameInvalid = 1, "name_invalid";
        ReparsePoint = 2, "reparse_point";
        NotRegular = 3, "not_regular";
        AliasMismatch = 4, "alias_mismatch";
        MissingDirectory = 5, "missing_directory";
        TooDeep = 6, "too_deep";
        TargetReadOnly = 7, "target_read_only";
        RootChanged = 8, "root_changed";
    }
}

/// The `out_detail` pair as the caller sees it: the reason number, then the
/// system's own code (an NTSTATUS or a Win32 error). It never carries a path.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct DetailOut {
    pub reason: u32,
    pub system: u32,
}

/// Why a call did not succeed, inside the library.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: Status,
    pub reason: Reason,
    pub system: u32,
}

impl Refusal {
    pub const fn of(status: Status) -> Self {
        Self::system(status, 0)
    }

    /// A status with the system's own code beside it.
    pub const fn system(status: Status, system: u32) -> Self {
        Self {
            status,
            reason: Reason::None,
            system,
        }
    }

    /// `path_refused` with the reason that says which rule refused.
    pub const fn path(reason: Reason) -> Self {
        Self {
            status: Status::PathRefused,
            reason,
            system: 0,
        }
    }

    pub const fn detail(self) -> DetailOut {
        DetailOut {
            reason: self.reason.code(),
            system: self.system,
        }
    }
}

pub const BUILD_FLAG_TEST_SEAMS: u32 = 1 << 0;
pub const BUILD_FLAGS: [(&str, u32); 1] = [("test_seams", BUILD_FLAG_TEST_SEAMS)];

/// What `jfa_build_flags()` returns for this build.
pub const fn build_flags() -> u32 {
    BUILD_FLAG_TEST_SEAMS * cfg!(feature = "test-seams") as u32
}

pub const EXPECT_MUST_NOT_EXIST: u32 = 0;
pub const EXPECT_NO_EXPECTATION: u32 = 1;
pub const EXPECT_BYTES: u32 = 2;
pub const EXPECTATION_KINDS: [(&str, u32); 3] = [
    ("must_not_exist", EXPECT_MUST_NOT_EXIST),
    ("no_expectation", EXPECT_NO_EXPECTATION),
    ("bytes", EXPECT_BYTES),
];

pub const WRITE_NOT_MATCHED: u32 = 0;
pub const WRITE_REPLACED: u32 = 1;
pub const WRITE_OUTCOMES: [(&str, u32); 2] = [
    ("not_matched", WRITE_NOT_MATCHED),
    ("replaced", WRITE_REPLACED),
];

pub const SEGMENT_TERMINATOR: u16 = 0;
pub const MAX_SEGMENT_UNITS: usize = 255;
pub const MAX_DEPTH: usize = 64;

pub const PIN_TABLE_ENTRIES: usize = 32;
pub const FILE_TABLE_ENTRIES: usize = 256;
pub const MAX_WRITE_BYTES: usize = 2_147_483_647;
pub const MAX_LISTING_BUFFER_BYTES: usize = 16 * 1024 * 1024;

/// A listing record: little-endian and unpadded. The fixed fields in order,
/// with their sizes in bytes, then `name_units` UTF-16 code units.
pub const LISTING_FIELDS: [(&str, usize); 3] = [("flags", 4), ("size", 8), ("name_units", 2)];
pub const LISTING_HEADER_BYTES: usize = 14;
pub const LISTING_FLAG_DIRECTORY: u32 = 1 << 0;
pub const LISTING_FLAG_REPARSE_POINT: u32 = 1 << 1;
pub const LISTING_FLAG_SIZE_KNOWN: u32 = 1 << 2;
pub const LISTING_FLAGS: [(&str, u32); 3] = [
    ("directory", LISTING_FLAG_DIRECTORY),
    ("reparse_point", LISTING_FLAG_REPARSE_POINT),
    ("size_known", LISTING_FLAG_SIZE_KNOWN),
];

/// The one export that exists only in the test-seams build.
pub const TEST_SEAMS_ONLY_EXPORT: &str = "jfa_test_set_token_state";
