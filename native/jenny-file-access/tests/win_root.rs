//! The root pin on a real NTFS temp directory: the root, identity and
//! rename-while-pinned rows of the spec's test matrix, the root shapes it
//! refuses, and the root exports.
//!
//! The safe-core tests use a probe that is real except for a plain token, so
//! they also run where the test process itself is elevated.
#![cfg(windows)]

mod common;

use std::fs;
use std::path::Path;

use common::{
    a_token_the_exports_accept, identity_of, make_junction, rename_is_denied, short_path, skipped,
    units_of, wide, ClosePin, Injected, TempDir, STALE_DETAIL,
};
use jenny_file_access::abi::{DetailOut, Refusal, Status, PIN_TABLE_ENTRIES};
use jenny_file_access::pins::{Kind, Table};
use jenny_file_access::win::root::{
    check_root_shape, open_root, pin_close, pin_identity, pin_root, Identity, RootPin,
    MAX_ROOT_UNITS,
};
use jenny_file_access::win::sys::SysError;
use jenny_file_access::{jfa_pin_close, jfa_pin_identity, jfa_root_open};

fn table() -> Table<RootPin> {
    Table::new(Kind::Pin, PIN_TABLE_ENTRIES)
}

fn refused(status: Status) -> Refusal {
    Refusal::of(status)
}

fn open_plain(root: &Path, expected: Identity) -> Result<RootPin, Refusal> {
    open_root(&Injected::plain(), &wide(root), expected)
}

#[test]
fn a_pinned_root_reports_its_identity_and_cannot_be_renamed_until_closed() {
    let temp = TempDir::new("pin");
    let parent = temp.dir("parent");
    let root = temp.dir(r"parent\project");
    let expected = identity_of(&root);
    assert!(expected.device != 0 && expected.inode != 0);

    let pins = table();
    let pin = pin_root(&Injected::plain(), &pins, &wide(&root), expected).expect("the root pins");
    assert_eq!(pin_identity(&pins, pin), Ok(expected));
    assert_eq!(pins.live(), Ok(1));

    // While the pin is held: the root and its ancestor can be neither renamed
    // nor deleted, and the root still takes new entries.
    assert!(
        rename_is_denied(&root, &parent.join("renamed")),
        "rename of the root"
    );
    assert!(
        rename_is_denied(&parent, &temp.path().join("moved")),
        "rename of the ancestor"
    );
    assert!(fs::remove_dir(&root).is_err(), "delete of the root");
    fs::write(root.join("inside.txt"), b"x").expect("a file inside the pinned root");
    fs::remove_file(root.join("inside.txt")).expect("and its removal");

    assert_eq!(pin_close(&pins, pin), Ok(()));
    assert_eq!(
        pin_close(&pins, pin),
        Err(refused(Status::InvalidArgument)),
        "a second close"
    );
    assert_eq!(
        pin_identity(&pins, pin),
        Err(refused(Status::InvalidArgument)),
        "a stale pin"
    );
    assert_eq!(pins.live(), Ok(0));

    // After the close both succeed, and the directory is removable.
    fs::rename(&parent, temp.path().join("moved")).expect("rename of the ancestor after close");
    fs::remove_dir(temp.path().join(r"moved\project")).expect("the root is removable");
}

#[test]
fn an_identity_that_is_wrong_or_zero_is_refused() {
    let temp = TempDir::new("identity");
    let root = temp.dir("project");
    let real = identity_of(&root);
    let wrong = [
        (real.device, real.inode + 1),
        (real.device + 1, real.inode),
        (0, real.inode),
        (real.device, 0),
        (0, 0),
    ];
    for (device, inode) in wrong {
        let expected = Identity { device, inode };
        let result = open_plain(&root, expected).map(|_| ());
        assert_eq!(result, Err(refused(Status::RootIdentity)), "{expected:?}");
    }
    // Nothing stayed open: the root can be renamed at once.
    fs::rename(&root, temp.path().join("renamed")).expect("no handle was left on the root");
}

#[test]
fn the_root_shapes_the_spec_refuses_are_refused_before_any_open() {
    let nonzero = Identity {
        device: 1,
        inode: 1,
    };
    // Every component is a valid name, so only the whole length can refuse it.
    let root_of = |units: usize| {
        let mut root = String::from(r"C:");
        while root.len() < units {
            root.push('\\');
            root.push_str(&"a".repeat((units - root.len()).min(200)));
        }
        assert_eq!(root.len(), units);
        root
    };
    let (longest, too_long) = (root_of(MAX_ROOT_UNITS), root_of(MAX_ROOT_UNITS + 1));
    let shapes = [
        "",
        "C:\\pro\0ject",
        "C:\\project\0",
        too_long.as_str(),
        r"C:\",
        "C:",
        r"\\server\share\project",
        r"\\?\C:\project",
        r"\\.\C:\project",
        r"\\?\UNC\server\share\project",
        r"\\?\Volume{4c1b02c1-d990-11dc-99ae-806e6f6e6963}\project",
        r"project",
        r"project\below",
        r".\project",
        r"..\project",
        r"\project",
        r"C:project",
        r"C:/project",
        r"C:\project\",
        r"C:\\project",
        r"C:\project\..\other",
        r"C:\project\.\below",
        r"C:\project/below",
        r"C:\project\con",
        r"C:\project\name.",
        r"C:\project\name ",
        r"C:\project\a:b",
        r"C:\project\a*",
        r"1:\project",
        r"CD:\project",
    ];
    for shape in shapes {
        let units = units_of(shape);
        // The start is enough to name a root that is over the limit.
        let shown: String = shape.chars().take(40).collect();
        assert_eq!(
            check_root_shape(&units),
            Err(refused(Status::RootInvalid)),
            "{shown:?}"
        );
        let probe = Injected::plain();
        let result = open_root(&probe, &units, nonzero).map(|_| ());
        assert_eq!(result, Err(refused(Status::RootInvalid)), "{shown:?}");
        assert_eq!(probe.opens.get(), 0, "{shown:?} was opened");
    }
    for shape in [r"C:\project", r"c:\a\b c\d.e", r"Z:\x", longest.as_str()] {
        let shown: String = shape.chars().take(40).collect();
        assert_eq!(check_root_shape(&units_of(shape)), Ok(()), "{shown:?}");
    }
}

#[test]
fn a_root_that_is_a_junction_or_a_symlink_is_refused() {
    let temp = TempDir::new("link");
    let target = temp.dir("target");
    let junction = temp.path().join("junction");
    make_junction(&junction, &target);
    // The junction resolves to the target, so the target's identity is what a
    // caller that followed the link would have recorded.
    let followed = identity_of(&junction);
    assert_eq!(followed, identity_of(&target));
    let probe = Injected::plain();
    let result = open_root(&probe, &wide(&junction), followed).map(|_| ());
    assert_eq!(result, Err(refused(Status::RootInvalid)));
    assert_eq!(
        probe.opens.get(),
        1,
        "the junction itself was opened, seen and closed"
    );
    fs::rename(&target, temp.path().join("target-moved")).expect("the target was never pinned");

    let target = temp.dir("second-target");
    let symlink = temp.path().join("symlink");
    if let Err(error) = std::os::windows::fs::symlink_dir(&target, &symlink) {
        skipped(
            "the directory symlink case of a_root_that_is_a_junction_or_a_symlink_is_refused",
            &format!("this account cannot create a symlink ({error}); the junction case ran"),
        );
        return;
    }
    let result = open_plain(&symlink, identity_of(&target)).map(|_| ());
    assert_eq!(result, Err(refused(Status::RootInvalid)));
}

#[test]
fn a_root_whose_final_path_differs_is_refused() {
    let temp = TempDir::new("final");
    let real = temp.dir(r"real\project");
    make_junction(&temp.path().join("via"), &temp.path().join("real"));
    // The root itself is a plain directory; an ancestor of the given path is a link.
    let through_link = temp.path().join(r"via\project");
    let identity = identity_of(&real);
    assert_eq!(
        identity_of(&through_link),
        identity,
        "both paths reach one directory"
    );
    let result = open_plain(&through_link, identity).map(|_| ());
    assert_eq!(result, Err(refused(Status::RootInvalid)));
    // The same directory by its own path is accepted.
    drop(open_plain(&real, identity).expect("the real path pins"));
}

#[test]
fn a_root_given_by_a_short_name_is_refused() {
    let temp = TempDir::new("short");
    let root = temp.dir("a long directory name.project");
    let short = short_path(&root);
    if short == root {
        skipped(
            "a_root_given_by_a_short_name_is_refused",
            "the temp volume makes no 8.3 short names, so there is no alias to give",
        );
        return;
    }
    let identity = identity_of(&root);
    assert_eq!(
        identity_of(&short),
        identity,
        "both names reach one directory"
    );
    assert_eq!(
        check_root_shape(&wide(&short)),
        Ok(()),
        "the alias has a valid shape"
    );
    // Only the final path tells the alias from the name.
    let probe = Injected::plain();
    let result = open_root(&probe, &wide(&short), identity).map(|_| ());
    assert_eq!(result, Err(refused(Status::RootInvalid)));
    assert_eq!(probe.opens.get(), 1);
    drop(open_plain(&root, identity).expect("the long name pins"));
}

#[test]
fn another_case_of_the_same_root_is_the_same_root() {
    let temp = TempDir::new("case");
    let root = temp.dir("Project");
    let identity = identity_of(&root);
    let upper = units_of(&root.to_str().expect("a text path").to_ascii_uppercase());
    assert_ne!(upper, wide(&root));
    let pin = open_root(&Injected::plain(), &upper, identity).expect("the case variant pins");
    assert_eq!(pin.identity(), identity);
}

#[test]
fn a_file_or_a_missing_path_is_not_a_root() {
    let temp = TempDir::new("notdir");
    let file = temp.path().join("file.txt");
    fs::write(&file, b"x").expect("a file");
    let result = open_plain(&file, identity_of(&file)).map(|_| ());
    assert_eq!(result, Err(refused(Status::RootInvalid)), "a file");

    let missing = temp.path().join("missing");
    let error = open_plain(
        &missing,
        Identity {
            device: 1,
            inode: 1,
        },
    )
    .expect_err("a missing root");
    assert_eq!(error.status, Status::IoFailed);
    assert_eq!(
        error.detail().reason,
        0,
        "a reason only beside path_refused"
    );
    assert!(
        error.system == 2 || error.system == 3,
        "the system's code, got {}",
        error.system
    );
}

/// The directory-enumeration self-check runs once per root in a process, not
/// on every open; every other check still runs each time, and a failed check
/// is never remembered.
#[test]
fn the_self_check_runs_once_per_root_and_a_failure_is_not_remembered() {
    let temp = TempDir::new("once");
    let root = temp.dir("project");
    let identity = identity_of(&root);
    let failing = Injected {
        self_check: Some(SysError(5)),
        ..Injected::plain()
    };
    assert_eq!(
        open_root(&failing, &wide(&root), identity).map(drop),
        Err(Refusal::system(Status::SelfcheckFailed, 5))
    );
    assert_eq!(
        open_root(&failing, &wide(&root), identity).map(drop),
        Err(Refusal::system(Status::SelfcheckFailed, 5)),
        "a failed check is run again, not remembered"
    );
    assert_eq!(failing.self_checks.get(), 2);
    let probe = Injected::plain();
    for _ in 0..3 {
        let pin = open_root(&probe, &wide(&root), identity).expect("the root opens");
        assert_eq!(pin.identity(), identity);
    }
    assert_eq!(probe.opens.get(), 3, "every open still opens the root");
    assert_eq!(probe.self_checks.get(), 1, "the self-check ran once");
    let remembered = Injected {
        self_check: Some(SysError(5)),
        ..Injected::plain()
    };
    assert!(open_root(&remembered, &wide(&root), identity).is_ok());
    assert_eq!(
        remembered.self_checks.get(),
        0,
        "a checked root is not enumerated again"
    );
    // The identity is still verified on every open, checked root or not.
    let mut other = identity;
    other.inode ^= 1;
    assert_eq!(
        open_root(&Injected::plain(), &wide(&root), other).map(drop),
        Err(refused(Status::RootIdentity))
    );
}

#[test]
fn a_root_deeper_than_260_characters_pins() {
    let temp = TempDir::new("long");
    let segment = "d".repeat(100);
    let root = temp.dir(&format!(r"{segment}\{segment}\{segment}"));
    assert!(wide(&root).len() > 260);
    let identity = identity_of(&root);
    let pin = open_plain(&root, identity).expect("a long root pins");
    assert_eq!(pin.identity(), identity);
}

#[test]
fn a_full_pin_table_refuses_and_closes_the_root_it_opened() {
    let temp = TempDir::new("full");
    let root = temp.dir("project");
    let identity = identity_of(&root);
    let pins = table();
    let held: Vec<u64> = (0..PIN_TABLE_ENTRIES)
        .map(|_| pin_root(&Injected::plain(), &pins, &wide(&root), identity).expect("a free slot"))
        .collect();
    let probe = Injected::plain();
    let extra = pin_root(&probe, &pins, &wide(&root), identity);
    assert_eq!(
        extra,
        Err(refused(Status::InvalidArgument)),
        "the table is full"
    );
    assert_eq!(probe.opens.get(), 1);
    for pin in held {
        assert_eq!(pin_close(&pins, pin), Ok(()));
    }
    // Had the refused open leaked its handle, the root would still be pinned.
    fs::rename(&root, temp.path().join("renamed")).expect("every handle on the root is closed");
}

#[test]
fn the_exports_pin_report_and_close() {
    let Some(_token) = a_token_the_exports_accept() else {
        skipped(
            "the_exports_pin_report_and_close",
            "this process's token is elevated or lists backup or restore rights, so the exports \
             refuse every root; the test-seams build runs this test with a plain token",
        );
        return;
    };
    let temp = TempDir::new("exports");
    let root = temp.dir("project");
    let identity = identity_of(&root);
    let root_units = wide(&root);
    let count = u32::try_from(root_units.len()).expect("a short path");
    let stale = STALE_DETAIL;

    let (mut pin, mut detail) = (0u64, stale);
    // SAFETY: the root buffer is valid for `count` units and both out-pointers
    // point at locals, for every call in this test.
    let status = unsafe {
        jfa_root_open(
            root_units.as_ptr(),
            count,
            identity.device,
            identity.inode,
            &mut pin,
            &mut detail,
        )
    };
    let _close = ClosePin(pin);
    assert_eq!(status, Status::Ok.code());
    assert_ne!(pin, 0);
    assert_eq!(
        detail,
        DetailOut::default(),
        "the detail is cleared on success"
    );

    let (mut device, mut inode) = (0u64, 0u64);
    // SAFETY: both out-pointers point at locals.
    assert_eq!(
        unsafe { jfa_pin_identity(pin, &mut device, &mut inode) },
        Status::Ok.code()
    );
    assert_eq!(Identity { device, inode }, identity);
    assert!(
        rename_is_denied(&root, &temp.path().join("renamed")),
        "the export's pin holds"
    );

    // A wrong identity through the export: its own status, no pin, no reason.
    let (mut second, mut detail) = (77u64, stale);
    // SAFETY: as above.
    let status = unsafe {
        jfa_root_open(
            root_units.as_ptr(),
            count,
            identity.device,
            identity.inode + 1,
            &mut second,
            &mut detail,
        )
    };
    assert_eq!(status, Status::RootIdentity.code());
    assert_eq!(second, 0, "no pin on a refusal");
    assert_eq!(detail, DetailOut::default());

    // Never-issued tokens close nothing: the root stays pinned.
    for token in [0, 1, u64::MAX, pin + 1, pin ^ (1 << 56)] {
        assert_eq!(
            jfa_pin_close(token),
            Status::InvalidArgument.code(),
            "{token:#x}"
        );
        (device, inode) = (5, 6);
        // SAFETY: both out-pointers point at locals.
        let status = unsafe { jfa_pin_identity(token, &mut device, &mut inode) };
        assert_eq!(status, Status::InvalidArgument.code(), "{token:#x}");
        assert_eq!((device, inode), (0, 0), "no identity on a refusal");
    }
    assert!(
        rename_is_denied(&root, &temp.path().join("renamed")),
        "still pinned"
    );

    assert_eq!(jfa_pin_close(pin), Status::Ok.code());
    assert_eq!(
        jfa_pin_close(pin),
        Status::InvalidArgument.code(),
        "a repeated close"
    );
    // SAFETY: both out-pointers point at locals.
    let status = unsafe { jfa_pin_identity(pin, &mut device, &mut inode) };
    assert_eq!(status, Status::InvalidArgument.code(), "a stale pin");
    fs::rename(&root, temp.path().join("renamed")).expect("the pin is closed");
}

#[test]
fn the_exports_refuse_null_and_misaligned_pointers() {
    let root_units = units_of(r"C:\project");
    let count = u32::try_from(root_units.len()).expect("a short path");
    let invalid = Status::InvalidArgument.code();
    let stale = STALE_DETAIL;
    let (mut pin, mut detail) = (77u64, stale);
    let null_units = std::ptr::null::<u16>();
    // One byte past an aligned address is never aligned for a u16.
    let misaligned = root_units
        .as_ptr()
        .cast::<u8>()
        .wrapping_add(1)
        .cast::<u16>();

    // SAFETY: every non-null pointer below points at a live local or buffer,
    // and the calls are expected to refuse before they read the root.
    unsafe {
        let status = jfa_root_open(
            root_units.as_ptr(),
            count,
            1,
            1,
            std::ptr::null_mut(),
            &mut detail,
        );
        assert_eq!(status, invalid, "a null out_pin");
        assert_eq!(
            detail, stale,
            "nothing is written when an out-pointer is null"
        );
        let status = jfa_root_open(
            root_units.as_ptr(),
            count,
            1,
            1,
            &mut pin,
            std::ptr::null_mut(),
        );
        assert_eq!((status, pin), (invalid, 77), "a null out_detail");
        assert_eq!(
            jfa_root_open(null_units, count, 1, 1, &mut pin, &mut detail),
            invalid
        );
        assert_eq!(
            (pin, detail),
            (0, DetailOut::default()),
            "the outputs are cleared first"
        );
        pin = 77;
        assert_eq!(
            jfa_root_open(misaligned, 1, 1, 1, &mut pin, &mut detail),
            invalid
        );
        assert_eq!(pin, 0);

        // A count over the root limit is refused before the buffer is read,
        // whatever the buffer holds, with the status of an over-long root.
        for over in [MAX_ROOT_UNITS as u32 + 1, u32::MAX] {
            (pin, detail) = (77, stale);
            let status = jfa_root_open(root_units.as_ptr(), over, 1, 1, &mut pin, &mut detail);
            assert_eq!(status, Status::RootInvalid.code(), "{over}");
            assert_eq!((pin, detail), (0, DetailOut::default()));
        }

        let (mut device, mut inode) = (5u64, 6u64);
        assert_eq!(
            jfa_pin_identity(0, std::ptr::null_mut(), &mut inode),
            invalid
        );
        assert_eq!(
            jfa_pin_identity(0, &mut device, std::ptr::null_mut()),
            invalid
        );
        assert_eq!((device, inode), (5, 6));
    }
}
