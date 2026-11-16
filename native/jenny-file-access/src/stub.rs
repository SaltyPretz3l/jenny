//! The exports on systems other than Windows: the same symbols with the same
//! argument lists, each answering `platform_unsupported`. No pointer is used.
//! Nothing packages or loads the library there.

use crate::abi::{self, DetailOut, Status};
use crate::ffi::{guard, guard_value};

#[no_mangle]
pub extern "C" fn jfa_abi_version() -> u32 {
    guard_value(|| abi::ABI_VERSION)
}

#[no_mangle]
pub extern "C" fn jfa_build_flags() -> u32 {
    guard_value(abi::build_flags)
}

/// One export per line: its name and the types of its arguments, in the order
/// of `abi.json`. `tests/abi.rs` checks every argument list against that file.
macro_rules! unsupported {
    ($($(#[$attribute:meta])* $name:ident($($argument:ty),*);)*) => {$(
        $(#[$attribute])*
        #[no_mangle]
        #[allow(clippy::too_many_arguments)] // The argument list is the frozen interface.
        pub extern "C" fn $name($(_: $argument),*) -> i32 {
            guard(|| Status::PlatformUnsupported)
        }
    )*};
}

unsupported! {
    jfa_root_open(*const u16, u32, u64, u64, *mut u64, *mut DetailOut);
    jfa_pin_identity(u64, *mut u64, *mut u64);
    jfa_pin_close(u64);
    jfa_open_file(u64, *const u16, u32, *mut u64, *mut DetailOut);
    jfa_file_take(u64, *mut usize);
    jfa_file_check(u64);
    jfa_file_close(u64, u32);
    jfa_list(u64, *const u16, u32, u32, *mut u8, u32, *mut u32, *mut u32, *mut DetailOut);
    jfa_write_atomic(
        u64, *const u16, u32, *const u8, usize, u32, *const u8, usize, *mut u32, *mut DetailOut
    );
    #[cfg(feature = "test-seams")]
    jfa_test_set_token_state(u32);
}
