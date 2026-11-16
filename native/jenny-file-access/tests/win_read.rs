//! The read side on a real NTFS temp directory: the read, link, alias, listing
//! and long-path rows of the spec's test matrix, through the safe core and
//! once each through the exports.
#![cfg(windows)]

mod common;

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::FromRawHandle;
use std::path::Path;

use common::{
    a_token_the_exports_accept, export_pin, long_segments, make_deep_file, make_junction, records,
    segments, set_third_party_reparse_point, short_path, skipped, units_of, ClosePin, Project,
    TempDir, STALE_DETAIL,
};
use jenny_file_access::abi::{
    DetailOut, Reason, Refusal, Status, LISTING_FLAG_DIRECTORY, LISTING_FLAG_SIZE_KNOWN,
};
use jenny_file_access::win::walk;
use jenny_file_access::win::write::{self, Expectation, WriteHooks};
use jenny_file_access::{
    jfa_file_check, jfa_file_close, jfa_file_take, jfa_list, jfa_open_file, jfa_pin_close,
};
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

fn export_open(pin: u64, list: &[u16]) -> (i32, u64, DetailOut) {
    let (mut token, mut detail) = (77u64, STALE_DETAIL);
    let count = u32::try_from(list.len()).expect("a short list");
    // SAFETY: the list is valid for `count` units and both out-pointers point at locals.
    let status = unsafe { jfa_open_file(pin, list.as_ptr(), count, &mut token, &mut detail) };
    (status, token, detail)
}

fn export_list(pin: u64, list: &[u16], max: u32, capacity: usize) -> (i32, Vec<u8>, u32, u32) {
    let mut buffer = vec![0xEE_u8; capacity];
    let (mut used, mut count, mut detail) = (77u32, 77u32, STALE_DETAIL);
    let pointer = if list.is_empty() {
        std::ptr::null()
    } else {
        list.as_ptr()
    };
    // SAFETY: the list is valid for its length (or null with a zero count), the
    // buffer for `capacity` bytes, and every out-pointer points at a local.
    let status = unsafe {
        jfa_list(
            pin,
            pointer,
            u32::try_from(list.len()).expect("a short list"),
            max,
            buffer.as_mut_ptr(),
            u32::try_from(capacity).expect("a small buffer"),
            &mut used,
            &mut count,
            &mut detail,
        )
    };
    buffer.truncate(if status == Status::Ok.code() {
        used as usize
    } else {
        0
    });
    (status, buffer, used, count)
}

#[test]
fn the_exports_open_take_check_close_and_list() {
    let Some(_token) = a_token_the_exports_accept() else {
        skipped(
            "the_exports_open_take_check_close_and_list",
            "this process's token is elevated or lists backup or restore rights, so the exports \
             refuse every root; the test-seams build runs this test with a plain token",
        );
        return;
    };
    let temp = TempDir::new("read-exports");
    let root = temp.dir("project");
    fs::create_dir(root.join("a")).expect("a directory");
    fs::write(root.join(r"a\b.txt"), b"hello").expect("a file");
    let pin = export_pin(&root);
    let _close = ClosePin(pin);

    // Open, take, read, check, close: the taken handle outlives the token.
    let (status, token, detail) = export_open(pin, &segments(&["a", "b.txt"]));
    assert_eq!(status, Status::Ok.code());
    assert_ne!(token, 0);
    assert_eq!(detail, DetailOut::default(), "the detail is cleared");
    let mut value = 0usize;
    // SAFETY: the out-pointer points at a local.
    assert_eq!(unsafe { jfa_file_take(token, &mut value) }, 0);
    assert_ne!(value, 0);
    // SAFETY: the library handed this value out once; the File owns it now.
    let mut file = unsafe { File::from_raw_handle(value as *mut _) };
    let mut text = String::new();
    file.read_to_string(&mut text)
        .expect("the taken handle reads");
    assert_eq!(text, "hello");
    let mut again = 77usize;
    // SAFETY: the out-pointer points at a local.
    let status = unsafe { jfa_file_take(token, &mut again) };
    assert_eq!(
        (status, again),
        (Status::InvalidArgument.code(), 0),
        "a second take"
    );
    assert_eq!(jfa_file_check(token), Status::Ok.code());
    assert!(
        fs::remove_file(root.join(r"a\b.txt")).is_err(),
        "the open file denies deletion"
    );
    assert_eq!(jfa_file_close(token, 0), Status::Ok.code());
    assert_eq!(
        jfa_file_close(token, 0),
        Status::InvalidArgument.code(),
        "a second close"
    );
    assert_eq!(
        jfa_file_check(token),
        Status::InvalidArgument.code(),
        "a stale token"
    );
    file.seek(SeekFrom::Start(0)).expect("still usable");
    text.clear();
    file.read_to_string(&mut text)
        .expect("reclaim 0 leaves the taken handle open");
    assert_eq!(text, "hello");
    drop(file);

    // reclaim 1 closes the taken value; afterwards the file can be deleted.
    fs::write(root.join("c.txt"), b"c").expect("a file");
    let (status, token, _) = export_open(pin, &segments(&["c.txt"]));
    assert_eq!(status, Status::Ok.code());
    let mut value = 0usize;
    // SAFETY: the out-pointer points at a local.
    assert_eq!(unsafe { jfa_file_take(token, &mut value) }, 0);
    assert_eq!(
        jfa_file_close(token, 2),
        Status::InvalidArgument.code(),
        "reclaim is 0 or 1"
    );
    assert!(fs::remove_file(root.join("c.txt")).is_err(), "still open");
    assert_eq!(jfa_file_close(token, 1), Status::Ok.code());
    fs::remove_file(root.join("c.txt")).expect("reclaim closed the taken handle");

    // A missing leaf, a missing directory, a directory as the leaf.
    let (status, token, detail) = export_open(pin, &segments(&["a", "missing.txt"]));
    assert_eq!(
        (status, token, detail),
        (Status::NotFound.code(), 0, DetailOut::default())
    );
    let (status, _, detail) = export_open(pin, &segments(&["missing", "b.txt"]));
    assert_eq!(status, Status::PathRefused.code());
    assert_eq!(detail.reason, Reason::MissingDirectory.code());
    let (status, _, detail) = export_open(pin, &segments(&["a"]));
    assert_eq!(status, Status::PathRefused.code());
    assert_eq!(detail.reason, Reason::NotRegular.code());
    let (status, _, detail) = export_open(pin, &segments(&["a", "b.txt."]));
    assert_eq!((status, detail.reason), (1, Reason::NameInvalid.code()));
    // An empty list names the root, which only a listing accepts.
    let (status, _, _) = export_open(pin, &[]);
    assert_eq!(status, Status::InvalidArgument.code());

    // Listing: a directory, the root, a small buffer, the limit.
    let (status, buffer, _, count) = export_list(pin, &segments(&["a"]), 100, 4096);
    assert_eq!((status, count), (0, 1));
    assert_eq!(
        records(&buffer),
        [(LISTING_FLAG_SIZE_KNOWN, 5, "b.txt".to_owned())]
    );
    let (status, buffer, _, _) = export_list(pin, &[], 100, 4096);
    assert_eq!(status, 0);
    assert_eq!(
        records(&buffer),
        [(LISTING_FLAG_DIRECTORY, 0, "a".to_owned())]
    );
    let (status, _, used, count) = export_list(pin, &segments(&["a"]), 100, 10);
    assert_eq!(status, Status::BufferTooSmall.code());
    assert_eq!((used, count), (14 + 2 * 5, 0), "the size the listing needs");
    fs::write(root.join(r"a\d.txt"), b"").expect("a second file");
    let (status, _, _, count) = export_list(pin, &segments(&["a"]), 1, 4096);
    assert_eq!((status, count), (0, 1), "the limit stops the scan");
    let (status, _, _, _) = export_list(pin, &segments(&["a", "b.txt"]), 100, 4096);
    assert_eq!(
        status,
        Status::PathRefused.code(),
        "a file is not a directory"
    );
}

#[test]
fn the_file_exports_refuse_tokens_they_did_not_issue() {
    let Some(_token) = a_token_the_exports_accept() else {
        skipped(
            "the_file_exports_refuse_tokens_they_did_not_issue",
            "this process's token is elevated or lists backup or restore rights",
        );
        return;
    };
    let temp = TempDir::new("read-tokens");
    let root = temp.dir("project");
    fs::write(root.join("f.txt"), b"f").expect("a file");
    let pin = export_pin(&root);
    let _close = ClosePin(pin);
    let invalid = Status::InvalidArgument.code();

    let (status, file, _) = export_open(pin, &segments(&["f.txt"]));
    assert_eq!(status, 0);
    let mut value = 77usize;
    for token in [0, 1, u64::MAX, pin, file + 1, file ^ (1 << 56)] {
        // SAFETY: the out-pointer points at a local.
        assert_eq!(
            unsafe { jfa_file_take(token, &mut value) },
            invalid,
            "{token:#x}"
        );
        assert_eq!(value, 0, "the output is cleared first");
        assert_eq!(jfa_file_check(token), invalid, "{token:#x}");
        assert_eq!(jfa_file_close(token, 1), invalid, "{token:#x}");
    }
    // A file token is not a pin, and a pin is not a file.
    assert_eq!(jfa_pin_close(file), invalid);
    let (status, token, _) = export_open(file, &segments(&["f.txt"]));
    assert_eq!((status, token), (invalid, 0));
    // Nothing above closed anything: the file still denies deletion and the
    // root still denies renaming.
    assert!(fs::remove_file(root.join("f.txt")).is_err());
    assert!(fs::rename(&root, temp.path().join("moved")).is_err());
    assert_eq!(jfa_file_close(file, 0), 0);
    fs::remove_file(root.join("f.txt")).expect("closed now");

    // Null and misaligned pointers, and an unterminated list.
    let list = segments(&["f.txt"]);
    let mut detail = STALE_DETAIL;
    let mut token = 77u64;
    // SAFETY: every non-null pointer points at a live local or buffer; the
    // calls refuse before they read past the counts given.
    unsafe {
        assert_eq!(
            jfa_open_file(pin, list.as_ptr(), 6, std::ptr::null_mut(), &mut detail),
            invalid
        );
        assert_eq!(
            detail, STALE_DETAIL,
            "nothing is written beside a null out-pointer"
        );
        assert_eq!(
            jfa_open_file(pin, std::ptr::null(), 6, &mut token, &mut detail),
            invalid
        );
        assert_eq!((token, detail), (0, DetailOut::default()));
        let misaligned = list.as_ptr().cast::<u8>().wrapping_add(1).cast::<u16>();
        assert_eq!(
            jfa_open_file(pin, misaligned, 2, &mut token, &mut detail),
            invalid
        );
        assert_eq!(
            jfa_open_file(pin, list.as_ptr(), 5, &mut token, &mut detail),
            invalid
        );
        assert_eq!(jfa_file_take(1, std::ptr::null_mut()), invalid);
    }
}

fn refused(reason: Reason) -> Result<Vec<u8>, Refusal> {
    Err(Refusal::path(reason))
}

#[test]
fn a_regular_file_reads_and_case_variants_name_the_same_file() {
    let project = Project::new("read");
    fs::create_dir(project.root.join("Docs")).expect("a directory");
    fs::write(project.root.join(r"Docs\Readme.md"), b"content").expect("a file");
    assert_eq!(
        project.read(&["Docs", "Readme.md"]),
        Ok(b"content".to_vec())
    );
    assert_eq!(
        project.read(&["docs", "README.MD"]),
        Ok(b"content".to_vec())
    );
    assert_eq!(
        project.read(&["Docs", "missing"]),
        Err(Refusal::of(Status::NotFound))
    );
    assert_eq!(project.read(&["Docs"]), refused(Reason::NotRegular));
    assert_eq!(
        project.read(&["Docs", "Readme.md", "x"]),
        refused(Reason::MissingDirectory),
        "a file where a directory must be"
    );
    // Names are judged before any system call; so is the depth.
    for bad in ["a.txt:s", "a.txt::$DATA", "con.txt", "com0", "x.", ".."] {
        assert_eq!(
            project.read(&["Docs", bad]),
            refused(Reason::NameInvalid),
            "{bad}"
        );
    }
    let deep: Vec<String> = (0..65).map(|depth| format!("d{depth}")).collect();
    let deep: Vec<&str> = deep.iter().map(String::as_str).collect();
    assert_eq!(project.read(&deep), refused(Reason::TooDeep));
}

#[test]
fn a_junction_is_never_traversed_and_never_read() {
    let project = Project::new("junction");
    let outside = project.temp.dir("outside");
    fs::write(outside.join("secret.txt"), b"outside").expect("a file outside the root");
    make_junction(&project.root.join("link"), &outside);
    // As an intermediate directory, and as the leaf.
    assert_eq!(
        project.read(&["link", "secret.txt"]),
        refused(Reason::ReparsePoint)
    );
    assert_eq!(project.read(&["link"]), refused(Reason::NotRegular));
    assert_eq!(
        fs::read(outside.join("secret.txt")).expect("unchanged"),
        b"outside"
    );
}

#[test]
fn a_symbolic_link_is_refused_where_the_account_can_make_one() {
    let project = Project::new("symlink");
    let outside = project.temp.dir("outside");
    fs::write(outside.join("secret.txt"), b"outside").expect("a file outside the root");
    let target = outside.join("secret.txt");
    if let Err(error) = std::os::windows::fs::symlink_file(target, project.root.join("file-link")) {
        skipped(
            "a_symbolic_link_is_refused_where_the_account_can_make_one",
            &format!("this account cannot make a symbolic link ({error}); junctions cover links"),
        );
        return;
    }
    std::os::windows::fs::symlink_dir(&outside, project.root.join("dir-link"))
        .expect("a directory link, where a file link could be made");
    assert_eq!(project.read(&["file-link"]), refused(Reason::ReparsePoint));
    assert_eq!(
        project.read(&["dir-link", "secret.txt"]),
        refused(Reason::ReparsePoint)
    );
}

#[test]
fn a_hard_linked_file_is_refused_and_its_other_name_is_unchanged() {
    let project = Project::new("hardlink");
    let outside = project.temp.dir("outside");
    fs::write(outside.join("secret.txt"), b"outside").expect("a file outside the root");
    fs::hard_link(outside.join("secret.txt"), project.root.join("linked.txt")).expect("a link");
    assert_eq!(project.read(&["linked.txt"]), refused(Reason::NotRegular));
    assert_eq!(
        fs::read(outside.join("secret.txt")).expect("unchanged"),
        b"outside"
    );
}

#[test]
fn a_short_name_alias_is_refused() {
    let project = Project::new("alias");
    let long = project.root.join("a long directory name");
    fs::create_dir(&long).expect("a directory");
    fs::write(long.join("a long file name.txt"), b"x").expect("a file");
    let short_dir = short_path(&long);
    if short_dir == long {
        skipped(
            "a_short_name_alias_is_refused",
            "this volume makes no 8.3 names",
        );
        return;
    }
    let short_file = short_path(&long.join("a long file name.txt"));
    let name = |path: &Path| {
        path.file_name()
            .expect("a name")
            .to_str()
            .expect("text")
            .to_owned()
    };
    let (dir_alias, file_alias) = (name(&short_dir), name(&short_file));
    assert_eq!(
        project.read(&[&dir_alias, "a long file name.txt"]),
        refused(Reason::AliasMismatch)
    );
    assert_eq!(
        project.read(&["a long directory name", &file_alias]),
        refused(Reason::AliasMismatch)
    );
    let long_names = ["a long directory name", "a long file name.txt"];
    assert_eq!(project.read(&long_names), Ok(b"x".to_vec()));
}

#[test]
fn an_open_file_cannot_be_swapped_and_a_new_link_fails_the_check() {
    let project = Project::new("swap");
    let path = project.root.join("f.txt");
    fs::write(&path, b"first").expect("a file");
    fs::write(project.root.join("other.txt"), b"other").expect("another file");
    let list = segments(&["f.txt"]);
    let token = walk::file_open(&project.pins, &project.files, project.pin, &list).expect("open");
    // The open handle denies deletion, so the name cannot be swapped.
    assert!(
        fs::rename(project.root.join("other.txt"), &path).is_err(),
        "no swap"
    );
    assert!(
        fs::rename(&path, project.root.join("moved.txt")).is_err(),
        "no rename"
    );
    assert_eq!(walk::file_check(&project.files, token), Ok(()));
    // A second name added while it is open is what the check catches.
    fs::hard_link(&path, project.root.join("second.txt")).expect("a hard link");
    assert_eq!(
        walk::file_check(&project.files, token),
        Err(Refusal::path(Reason::NotRegular))
    );
    walk::file_close(&project.files, token, false).expect("closes");
    assert_eq!(project.files.live(), Ok(0));
}

#[test]
fn walked_directories_cannot_be_renamed_while_held() {
    let project = Project::new("held");
    fs::create_dir_all(project.root.join(r"a\b")).expect("directories");
    let (a, b) = (units_of("a"), units_of("b"));
    let held = walk::walk(project.root_handle(), &[&a, &b]).expect("the walk");
    assert!(fs::rename(project.root.join("a"), project.root.join("z")).is_err());
    assert!(fs::rename(project.root.join(r"a\b"), project.root.join(r"a\z")).is_err());
    drop(held);
    fs::rename(project.root.join("a"), project.root.join("z")).expect("free after the walk");
}

#[test]
fn a_path_past_260_characters_reads() {
    let project = Project::new("long");
    make_deep_file(&project.root);
    let [a, b, c] = long_segments();
    let parts = [a.as_str(), &b, &c, "f.txt"];
    assert_eq!(project.read(&parts), Ok(b"deep".to_vec()));
}

/// A third-party reparse point on a plain file or directory, which an
/// ordinary account can set: the walk refuses the directory
/// (`check_opened`), and read, write-over and the re-check refuse the file
/// (`check_regular`).
#[test]
fn a_third_party_reparse_point_is_refused_on_a_directory_and_on_a_file() {
    let project = Project::new("third-party-reparse");
    let root = &project.root;
    let reparse = Refusal::path(Reason::ReparsePoint);

    fs::create_dir(root.join("tagged-dir")).expect("an empty directory");
    set_third_party_reparse_point(&root.join("tagged-dir"));
    assert_eq!(project.read(&["tagged-dir", "x.txt"]), Err(reparse));

    fs::write(root.join("tagged.txt"), b"tagged").expect("a file");
    set_third_party_reparse_point(&root.join("tagged.txt"));
    assert_eq!(project.read(&["tagged.txt"]), Err(reparse));
    let over = write::write_atomic(
        project.root_handle(),
        &segments(&["tagged.txt"]),
        b"new",
        Expectation::NoExpectation,
        &mut WriteHooks::default(),
    );
    assert_eq!(over, Err(reparse));

    // Opened while plain, tagged while open: the re-check refuses it.
    fs::write(root.join("later.txt"), b"later").expect("a file");
    let later = segments(&["later.txt"]);
    let token = walk::file_open(&project.pins, &project.files, project.pin, &later)
        .expect("a plain file opens");
    set_third_party_reparse_point(&root.join("later.txt"));
    assert_eq!(walk::file_check(&project.files, token), Err(reparse));
    walk::file_close(&project.files, token, true).expect("closes");
    // std follows an unknown tag (error 1920); read the file itself.
    let mut kept = Vec::new();
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(root.join("tagged.txt"))
        .and_then(|mut file| file.read_to_end(&mut kept))
        .expect("the tagged file reads as itself");
    assert_eq!(kept, b"tagged", "the write over it changed nothing");
}
