//! Atomic write and conditional replacement on a real NTFS temp directory:
//! the write rows of the spec's test matrix, through the safe core with its
//! hooks, and once through the export.
#![cfg(windows)]

mod common;

use std::fs;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::Instant;

use common::{
    a_token_the_exports_accept, export_pin, long_segments, make_junction, names_in, note,
    rename_is_denied, segments, set_readonly, skipped, temps, ClosePin, Project, STALE_DETAIL,
};
use jenny_file_access::abi::{
    DetailOut, Reason, Refusal, Status, EXPECT_BYTES, EXPECT_MUST_NOT_EXIST, EXPECT_NO_EXPECTATION,
    MAX_WRITE_BYTES, WRITE_NOT_MATCHED, WRITE_REPLACED,
};
use jenny_file_access::jfa_write_atomic;
use jenny_file_access::win::sys::SysError;
use jenny_file_access::win::write::{self, Expectation, Flush, Outcome, WriteHooks};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES,
};

fn export_write(
    pin: u64,
    parts: &[&str],
    content: &[u8],
    kind: u32,
    expected: &[u8],
) -> (i32, u32, DetailOut) {
    let list = segments(parts);
    let (mut outcome, mut detail) = (77u32, STALE_DETAIL);
    // SAFETY: every buffer is valid for the count given and both out-pointers
    // point at locals.
    let status = unsafe {
        jfa_write_atomic(
            pin,
            list.as_ptr(),
            u32::try_from(list.len()).expect("a short list"),
            content.as_ptr(),
            content.len(),
            kind,
            expected.as_ptr(),
            expected.len(),
            &mut outcome,
            &mut detail,
        )
    };
    (status, outcome, detail)
}

#[test]
fn the_write_export_creates_replaces_and_refuses() {
    let Some(_token) = a_token_the_exports_accept() else {
        skipped(
            "the_write_export_creates_replaces_and_refuses",
            "this process's token is elevated or lists backup or restore rights, so the exports \
             refuse every root; the test-seams build runs this test with a plain token",
        );
        return;
    };
    let temp = common::TempDir::new("write-export");
    let root = temp.dir("project");
    let pin = export_pin(&root);
    let _close = ClosePin(pin);
    let file = root.join(r"a\b\new.txt");
    let ok = Status::Ok.code();

    // Missing parents are created; must-not-exist then finds the file.
    let (status, outcome, detail) = export_write(
        pin,
        &["a", "b", "new.txt"],
        b"one",
        EXPECT_MUST_NOT_EXIST,
        &[],
    );
    assert_eq!(
        (status, outcome, detail),
        (ok, WRITE_REPLACED, DetailOut::default())
    );
    assert_eq!(fs::read(&file).expect("written"), b"one");
    let (status, outcome, _) = export_write(
        pin,
        &["a", "b", "new.txt"],
        b"two",
        EXPECT_MUST_NOT_EXIST,
        &[],
    );
    assert_eq!((status, outcome), (ok, WRITE_NOT_MATCHED));

    // Expected bytes: a match replaces, a mismatch does not.
    let (status, outcome, _) =
        export_write(pin, &["a", "b", "new.txt"], b"two", EXPECT_BYTES, b"one");
    assert_eq!((status, outcome), (ok, WRITE_REPLACED));
    let (status, outcome, _) =
        export_write(pin, &["a", "b", "new.txt"], b"three", EXPECT_BYTES, b"one");
    assert_eq!((status, outcome), (ok, WRITE_NOT_MATCHED));
    assert_eq!(fs::read(&file).expect("kept"), b"two");
    let (status, outcome, _) =
        export_write(pin, &["a", "b", "new.txt"], b"", EXPECT_NO_EXPECTATION, &[]);
    assert_eq!((status, outcome), (ok, WRITE_REPLACED));
    assert_eq!(fs::read(&file).expect("emptied"), b"");

    // A read-only target is refused and keeps its attribute.
    let mut permissions = fs::metadata(&file).expect("metadata").permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&file, permissions.clone()).expect("read only");
    let (status, outcome, detail) = export_write(
        pin,
        &["a", "b", "new.txt"],
        b"x",
        EXPECT_NO_EXPECTATION,
        &[],
    );
    assert_eq!((status, outcome), (Status::PathRefused.code(), 0));
    assert_eq!(detail.reason, Reason::TargetReadOnly.code());
    assert!(fs::metadata(&file)
        .expect("metadata")
        .permissions()
        .readonly());
    #[allow(clippy::permissions_set_readonly_false)] // Lets the temp directory go.
    permissions.set_readonly(false);
    fs::set_permissions(&file, permissions).expect("writable again");

    // Arguments: an unknown kind, an over-long length, a null buffer.
    let invalid = Status::InvalidArgument.code();
    let (status, _, _) = export_write(pin, &["x.txt"], b"x", 3, &[]);
    assert_eq!(status, invalid);
    let list = segments(&["x.txt"]);
    let (mut outcome, mut detail) = (77u32, STALE_DETAIL);
    // SAFETY: no call reads the content: each is refused on its length first.
    unsafe {
        let null = std::ptr::null();
        for (content, length) in [(b"x".as_ptr(), MAX_WRITE_BYTES + 1), (null, 1)] {
            let status = jfa_write_atomic(
                pin,
                list.as_ptr(),
                6,
                content,
                length,
                EXPECT_NO_EXPECTATION,
                null,
                0,
                &mut outcome,
                &mut detail,
            );
            assert_eq!((status, outcome), (invalid, 0), "{length}");
        }
        let status = jfa_write_atomic(
            pin,
            list.as_ptr(),
            6,
            b"x".as_ptr(),
            1,
            EXPECT_BYTES,
            null,
            1,
            &mut outcome,
            &mut detail,
        );
        assert_eq!(status, invalid, "expected bytes behind a null pointer");
    }
    assert!(!root.join("x.txt").exists());
    assert!(temps(&root.join(r"a\b")).is_empty(), "no temp left");
}

fn write_with(
    project: &Project,
    parts: &[&str],
    content: &[u8],
    expectation: Expectation<'_>,
    hooks: &mut WriteHooks<'_>,
) -> Result<Outcome, Refusal> {
    write::write_atomic(
        project.root_handle(),
        &segments(parts),
        content,
        expectation,
        hooks,
    )
}

fn write(
    project: &Project,
    parts: &[&str],
    content: &[u8],
    expectation: Expectation<'_>,
) -> Result<Outcome, Refusal> {
    write_with(
        project,
        parts,
        content,
        expectation,
        &mut WriteHooks::default(),
    )
}

fn refused(reason: Reason) -> Result<Outcome, Refusal> {
    Err(Refusal::path(reason))
}

/// The temp's path in `directory`, from the name the hook is given.
fn temp_path(directory: &Path, name: &[u16]) -> PathBuf {
    directory.join(String::from_utf16(name).expect("an ASCII name"))
}

const NONE: Expectation<'static> = Expectation::NoExpectation;

#[test]
fn a_write_creates_its_parents_replaces_and_keeps_the_on_disk_spelling() {
    let project = Project::new("write-core");
    let root = &project.root;
    let file = ["a", "b", "f.txt"];
    let first = write(&project, &file, b"one", Expectation::MustNotExist);
    assert_eq!(first, Ok(Outcome::Replaced));
    assert_eq!(fs::read(root.join(r"a\b\f.txt")).expect("written"), b"one");
    let again = write(&project, &file, b"x", Expectation::MustNotExist);
    assert_eq!(again, Ok(Outcome::NotMatched));
    let prefix = write(&project, &file, b"x", Expectation::Bytes(b"on"));
    assert_eq!(
        prefix,
        Ok(Outcome::NotMatched),
        "a prefix is not the content"
    );
    let matched = write(&project, &file, b"two", Expectation::Bytes(b"one"));
    assert_eq!(matched, Ok(Outcome::Replaced));
    let missing = write(&project, &["missing.txt"], b"x", Expectation::Bytes(b""));
    assert_eq!(missing, Ok(Outcome::NotMatched));
    assert!(!root.join("missing.txt").exists());

    // Case variants name one file, and the replacement keeps its spelling.
    fs::write(root.join("Mixed.TXT"), b"old").expect("a file");
    let variant = write(&project, &["mixed.txt"], b"new", NONE);
    assert_eq!(variant, Ok(Outcome::Replaced));
    let names = names_in(root);
    assert!(names.contains(&"Mixed.TXT".to_owned()), "{names:?}");
    assert_eq!(fs::read(root.join("Mixed.TXT")).expect("replaced"), b"new");

    // A path longer than 260 characters: three directories of 200.
    let [a, b, c] = long_segments();
    let parts = [a.as_str(), &b, &c, "f.txt"];
    assert_eq!(
        write(&project, &parts, b"deep", NONE),
        Ok(Outcome::Replaced)
    );
    let deep = root.join(&a).join(&b).join(&c);
    assert!(deep.join("f.txt").as_os_str().len() > 600);
    assert_eq!(fs::read(deep.join("f.txt")).expect("long path"), b"deep");
    assert_eq!(project.read(&parts), Ok(b"deep".to_vec()));
    for directory in [root.clone(), root.join(r"a\b"), deep] {
        assert!(temps(&directory).is_empty(), "no temp left");
    }
}

#[test]
fn links_junctions_and_read_only_targets_are_refused_and_nothing_outside_changes() {
    let project = Project::new("write-links");
    let root = &project.root;
    let outside = project.temp.dir("outside");
    fs::write(outside.join("secret.txt"), b"secret").expect("an outside file");
    make_junction(&root.join("j"), &outside);

    // Through a junction, as the leaf's parent and further up, creating or not.
    let through = write(&project, &["j", "secret.txt"], b"x", NONE);
    assert_eq!(through, refused(Reason::ReparsePoint));
    let nested = write(&project, &["j", "n1", "n2", "x.txt"], b"x", NONE);
    assert_eq!(nested, refused(Reason::ReparsePoint));
    // The junction as the leaf; a directory as the leaf; a file where the
    // walk needs a directory.
    assert_eq!(
        write(&project, &["j"], b"x", NONE),
        refused(Reason::NotRegular)
    );
    fs::create_dir(root.join("d")).expect("a directory");
    assert_eq!(
        write(&project, &["d"], b"x", NONE),
        refused(Reason::NotRegular)
    );
    fs::write(root.join("f"), b"f").expect("a file");
    let under_file = write(&project, &["f", "x.txt"], b"x", NONE);
    assert_eq!(under_file, refused(Reason::MissingDirectory));

    // A hard-linked target, with and without an expectation.
    fs::write(root.join("a.txt"), b"a").expect("a file");
    fs::hard_link(root.join("a.txt"), outside.join("other.txt")).expect("a hard link");
    for expectation in [NONE, Expectation::Bytes(b"a")] {
        let linked = write(&project, &["a.txt"], b"x", expectation);
        assert_eq!(linked, refused(Reason::NotRegular));
    }

    // Read only: refused, the attribute kept.
    let ro = root.join("ro.txt");
    fs::write(&ro, b"ro").expect("a file");
    set_readonly(&ro, true);
    let read_only = write(&project, &["ro.txt"], b"x", NONE);
    assert_eq!(read_only, refused(Reason::TargetReadOnly));
    assert!(fs::metadata(&ro)
        .expect("metadata")
        .permissions()
        .readonly());
    set_readonly(&ro, false);

    assert_eq!(fs::read(&ro).expect("kept"), b"ro");
    assert_eq!(fs::read(root.join("a.txt")).expect("kept"), b"a");
    assert_eq!(fs::read(outside.join("other.txt")).expect("kept"), b"a");
    assert_eq!(
        fs::read(outside.join("secret.txt")).expect("kept"),
        b"secret"
    );
    assert_eq!(
        names_in(&outside),
        ["other.txt", "secret.txt"],
        "nothing made outside"
    );
    assert!(temps(root).is_empty(), "no temp left");
}

#[test]
fn the_pinned_parent_and_the_held_temp_cannot_be_swapped_before_the_rename() {
    let project = Project::new("write-swap");
    let root = project.root.clone();
    let outside = project.temp.dir("outside");
    let parent = root.join("p");
    fs::create_dir(&parent).expect("a parent");
    fs::write(parent.join("t.txt"), b"old").expect("a target");
    fs::write(root.join("other.tmp"), b"other").expect("a stand-in");
    let mut checked = false;
    let mut swap = |name: &[u16]| {
        let temp = temp_path(&parent, name);
        assert_eq!(fs::read(&temp).expect("the temp reads"), b"new");
        // The temp can be neither moved, deleted nor replaced.
        assert!(rename_is_denied(&temp, &parent.join("moved.tmp")));
        assert!(fs::remove_file(&temp).is_err());
        assert!(rename_is_denied(&root.join("other.tmp"), &temp));
        // The parent the write holds cannot be moved to make way for a junction.
        assert!(rename_is_denied(&parent, &root.join("p-old")));
        checked = true;
    };
    let mut hooks = WriteHooks {
        before_rename: Some(&mut swap),
        flush: None,
    };
    let expectation = Expectation::Bytes(b"old");
    let result = write_with(&project, &["p", "t.txt"], b"new", expectation, &mut hooks);
    assert_eq!(result, Ok(Outcome::Replaced));
    assert!(checked);
    assert_eq!(fs::read(parent.join("t.txt")).expect("replaced"), b"new");
    assert!(names_in(&outside).is_empty());
    assert!(temps(&parent).is_empty());
}

#[test]
fn a_target_changed_after_the_temp_flush_is_not_replaced() {
    let project = Project::new("write-changed");
    let target = project.root.join("t.txt");

    // An attribute change: not matched with an expectation, refused without.
    for (expectation, expected) in [
        (Expectation::Bytes(b"old"), Ok(Outcome::NotMatched)),
        (NONE, refused(Reason::None)),
    ] {
        fs::write(&target, b"old").expect("a target");
        let mut chmod = |_: &[u16]| set_readonly(&target, true);
        let mut hooks = WriteHooks {
            before_rename: Some(&mut chmod),
            flush: None,
        };
        let result = write_with(&project, &["t.txt"], b"new", expectation, &mut hooks);
        assert_eq!(result, expected);
        set_readonly(&target, false);
        assert_eq!(fs::read(&target).expect("kept"), b"old");
    }

    // A rewrite of the same length with its write time put back: only the
    // change time tells.
    fs::write(&target, b"old").expect("a target");
    let mut rewrite = |_: &[u16]| {
        let metadata = fs::metadata(&target).expect("metadata");
        let written = metadata.modified().expect("a write time");
        fs::write(&target, b"OLD").expect("rewritten");
        let file = fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .expect("opens");
        file.set_modified(written)
            .expect("the write time is put back");
    };
    let mut hooks = WriteHooks {
        before_rename: Some(&mut rewrite),
        flush: None,
    };
    let expectation = Expectation::Bytes(b"old");
    let result = write_with(&project, &["t.txt"], b"new", expectation, &mut hooks);
    assert_eq!(result, Ok(Outcome::NotMatched));
    assert_eq!(fs::read(&target).expect("the rewrite survives"), b"OLD");

    // A file that appears where none was expected.
    let theirs = project.root.join("n.txt");
    let mut create = |_: &[u16]| fs::write(&theirs, b"theirs").expect("made");
    let mut hooks = WriteHooks {
        before_rename: Some(&mut create),
        flush: None,
    };
    let expectation = Expectation::MustNotExist;
    let result = write_with(&project, &["n.txt"], b"ours", expectation, &mut hooks);
    assert_eq!(result, Ok(Outcome::NotMatched));
    assert_eq!(fs::read(&theirs).expect("kept"), b"theirs");
    assert!(temps(&project.root).is_empty());
}

#[test]
fn every_failure_leaves_no_temp_and_a_late_flush_failure_is_durability_uncertain() {
    let project = Project::new("write-cleanup");
    let root = project.root.clone();
    let target = root.join("t.txt");
    fs::write(&target, b"old").expect("a target");
    const IO_DEVICE: u32 = 1117; // ERROR_IO_DEVICE, as a failing disk gives it.
    let failing = |at: Flush| {
        move |stage: Flush| {
            if stage == at {
                Err(SysError(IO_DEVICE))
            } else {
                Ok(())
            }
        }
    };

    // The temp's flush fails: io_failed, the old content kept.
    let mut fail_temp = failing(Flush::Temp);
    let mut hooks = WriteHooks {
        before_rename: None,
        flush: Some(&mut fail_temp),
    };
    let result = write_with(&project, &["t.txt"], b"new", NONE, &mut hooks);
    assert_eq!(result, Err(Refusal::system(Status::IoFailed, IO_DEVICE)));
    assert_eq!(fs::read(&target).expect("kept"), b"old");
    assert!(temps(&root).is_empty(), "after the temp flush");

    // A second link to the temp: the temp re-check refuses it.
    let link = root.join("temp-link.bin");
    let mut linked = false;
    let mut link_temp = |name: &[u16]| {
        linked = fs::hard_link(temp_path(&root, name), &link).is_ok();
    };
    let mut hooks = WriteHooks {
        before_rename: Some(&mut link_temp),
        flush: None,
    };
    let result = write_with(&project, &["t.txt"], b"new", NONE, &mut hooks);
    if linked {
        assert_eq!(result, refused(Reason::NotRegular));
        assert_eq!(fs::read(&target).expect("kept"), b"old");
        fs::remove_file(&link).expect("the test's link goes");
    } else {
        note(
            "NOTE",
            "every_failure_leaves_no_temp",
            "the held temp refused a hard link, so the temp re-check was not reached",
        );
        assert_eq!(result, Ok(Outcome::Replaced));
        fs::write(&target, b"old").expect("put back");
    }
    assert!(temps(&root).is_empty(), "after the temp re-check");

    // The target held open without delete sharing: retries, then busy.
    // std shares delete by default; the holder must not.
    let holder = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&target)
        .expect("held");
    let started = Instant::now();
    let result = write(&project, &["t.txt"], b"new", NONE);
    assert_eq!(result, Err(Refusal::system(Status::Busy, 0xC000_0043)));
    assert!(started.elapsed().as_millis() >= 600, "the retries waited");
    drop(holder);
    assert_eq!(fs::read(&target).expect("kept"), b"old");
    assert!(temps(&root).is_empty(), "after busy");

    // The flush after the rename fails: the new content is in place.
    let mut fail_late = failing(Flush::Renamed);
    let mut hooks = WriteHooks {
        before_rename: None,
        flush: Some(&mut fail_late),
    };
    let result = write_with(&project, &["t.txt"], b"new", NONE, &mut hooks);
    let uncertain = Refusal::system(Status::DurabilityUncertain, IO_DEVICE);
    assert_eq!(result, Err(uncertain));
    assert_eq!(fs::read(&target).expect("replaced"), b"new");
    assert!(temps(&root).is_empty(), "after the late flush");
}

/// Steps 6 and 7 run again before every retry of the rename. A holder makes the first rename meet a
/// sharing violation, then changes the target and lets go during the wait.
#[test]
fn a_target_changed_during_the_retry_wait_is_not_replaced() {
    let project = Project::new("write-retry");
    let target = project.root.join("t.txt");
    fs::write(&target, b"old").expect("a target");
    let mut holder = None;
    let mut hold = |_: &[u16]| {
        // std shares delete by default; the holder must not.
        let mut file = fs::OpenOptions::new()
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&target)
            .expect("held");
        holder = Some(std::thread::spawn(move || {
            // The change and the close lie far apart, so they cannot both
            // fall between one re-check and its rename (the accepted window).
            std::thread::sleep(std::time::Duration::from_millis(30));
            std::io::Write::write_all(&mut file, b"HOLDER").expect("the holder writes");
            std::thread::sleep(std::time::Duration::from_millis(170));
            // The handle closes here, well inside the 620 ms of waits.
        }));
    };
    let mut hooks = WriteHooks {
        before_rename: Some(&mut hold),
        flush: None,
    };
    let expectation = Expectation::Bytes(b"old");
    let result = write_with(&project, &["t.txt"], b"new", expectation, &mut hooks);
    holder
        .take()
        .expect("the hook ran")
        .join()
        .expect("the holder ends");
    assert_eq!(result, Ok(Outcome::NotMatched));
    assert_eq!(fs::read(&target).expect("the holder's content"), b"HOLDER");
    assert!(temps(&project.root).is_empty());
}

/// Step 7 asks whether the temp is the same single-link regular file,
/// not whether its times moved. An attribute-only open takes no part in the
/// temp's sharing mode and can reset its times.
#[test]
fn a_temp_whose_times_were_reset_is_still_renamed() {
    let project = Project::new("write-touch");
    let root = project.root.clone();
    let mut touch = |name: &[u16]| {
        let file = fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(temp_path(&root, name))
            .expect("an attribute-only open is not refused by the temp's sharing");
        let past = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1 << 30);
        file.set_modified(past).expect("the write time is reset");
    };
    let mut hooks = WriteHooks {
        before_rename: Some(&mut touch),
        flush: None,
    };
    let result = write_with(&project, &["t.txt"], b"new", NONE, &mut hooks);
    assert_eq!(result, Ok(Outcome::Replaced));
    assert_eq!(fs::read(root.join("t.txt")).expect("written"), b"new");
}
