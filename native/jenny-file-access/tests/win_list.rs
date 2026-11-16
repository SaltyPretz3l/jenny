//! Listing on a real NTFS temp directory through the safe core: the listing
//! and long-path rows of the spec's test matrix, and the root's self-check,
//! which now opens one child through the walk. The export runs once in
//! `tests/win_read.rs`.
#![cfg(windows)]

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use common::{long_segments, make_deep_file, make_junction, segments, Project, TempDir};
use jenny_file_access::abi::{
    Reason, Refusal, LISTING_FLAG_DIRECTORY, LISTING_FLAG_REPARSE_POINT, LISTING_FLAG_SIZE_KNOWN,
};
use jenny_file_access::win::dir;
use jenny_file_access::win::policy::{RealProbe, SystemProbe};
use jenny_file_access::win::sys;
use jenny_file_access::win::walk;

#[test]
fn a_listing_reports_files_directories_and_links_as_themselves() {
    let project = Project::new("list");
    let outside = project.temp.dir("outside");
    fs::write(outside.join("secret.txt"), b"outside").expect("a file outside the root");
    fs::write(project.root.join("file.txt"), b"12345").expect("a file");
    fs::create_dir(project.root.join("sub")).expect("a directory");
    make_junction(&project.root.join("link"), &outside);
    let listed = project.list(&[], 100).expect("the root lists");
    assert_eq!(
        listed,
        [
            (LISTING_FLAG_SIZE_KNOWN, 5, "file.txt".to_owned()),
            // A link is a non-directory of unknown size, never followed.
            (LISTING_FLAG_REPARSE_POINT, 0, "link".to_owned()),
            (LISTING_FLAG_DIRECTORY, 0, "sub".to_owned()),
        ]
    );
    assert_eq!(
        project.list(&["sub"], 100),
        Ok(Vec::new()),
        "an empty directory"
    );
    assert_eq!(
        project.list(&["link"], 100),
        Err(Refusal::path(Reason::ReparsePoint)),
        "a link is not listed through"
    );
    assert_eq!(
        project.list(&["missing"], 100),
        Err(Refusal::path(Reason::MissingDirectory))
    );
}

/// Duplicates of the pin share one directory position, so each listing must
/// enumerate a handle of its own (3b-2a's limit, repaid in 3b-2b). Two
/// listing handles of one pinned directory: the second one's first read,
/// without a restart, starts at the first entry; on a duplicate it would go
/// on where the first stopped.
#[test]
fn each_listing_enumerates_a_directory_handle_of_its_own() {
    let project = Project::new("list-own");
    for index in 0..40 {
        fs::write(project.root.join(format!("f{index:02}.txt")), b"x").expect("a file");
    }
    let root = project.root_handle();
    let first = walk::reopen_directory(&root).expect("a listing handle");
    let second = walk::reopen_directory(&root).expect("another listing handle");
    // 512 bytes: the first few records only.
    let (mut one, mut two) = (vec![0u64; 64], vec![0u64; 64]);
    assert!(sys::file::directory_records(&first, true, &mut one).expect("reads"));
    assert!(sys::file::directory_records(&second, false, &mut two).expect("reads"));
    assert_eq!(one, two, "the second handle starts at the first entry");
}

#[test]
fn a_long_listing_spans_buffers_and_the_limit_stops_it() {
    let project = Project::new("list-many");
    let many = project.root.join("many");
    fs::create_dir(&many).expect("a directory");
    // About 200 bytes of name each: far more than one 64 KiB enumeration call.
    let count = 600;
    for index in 0..count {
        fs::write(many.join(format!("{index:04}-{}", "n".repeat(90))), b"").expect("a file");
    }
    assert_eq!(project.list(&["many"], 10_000).expect("lists").len(), count);
    assert_eq!(
        project.list(&["many"], 7).expect("lists").len(),
        7,
        "the limit"
    );
    assert_eq!(project.list(&["many"], 0).expect("lists").len(), 0);

    // A small buffer: a prefix, the size the whole listing needs, then a
    // retry with that size returns every entry.
    let list = segments(&["many"]);
    let mut small = vec![0u8; 1000];
    let first = dir::list(project.root_handle(), &list, 10_000, &mut small).expect("lists");
    assert!(!first.complete);
    assert!(first.bytes_used <= 1000 && first.bytes_needed > 1000);
    let mut exact = vec![0u8; first.bytes_needed];
    let second = dir::list(project.root_handle(), &list, 10_000, &mut exact).expect("lists");
    assert!(second.complete);
    assert_eq!(second.bytes_used, first.bytes_needed);
    assert_eq!(second.entries as usize, count);
}

#[test]
fn a_path_past_260_characters_lists() {
    let project = Project::new("list-long");
    make_deep_file(&project.root);
    let [a, b, c] = long_segments();
    let listed = project.list(&[&a, &b, &c], 10).expect("lists");
    assert_eq!(listed, [(LISTING_FLAG_SIZE_KNOWN, 4, "f.txt".to_owned())]);
}

/// The self-check lists the root and opens one child through the walk. It
/// passes on an empty root, on a root whose only entry is a link (skipped,
/// never opened), and on one with a file or a directory.
#[test]
fn the_self_check_opens_one_child_through_the_walk() {
    let temp = TempDir::new("selfcheck");
    let check = |name: &str| {
        let root = temp.path().join(name);
        let handle = sys::open_root_directory(&common::extended(&root)).expect("the root opens");
        RealProbe.self_check(&handle)
    };
    temp.dir("empty");
    assert_eq!(check("empty"), Ok(()));
    let only_link = temp.dir("only-link");
    make_junction(&only_link.join("link"), temp.path());
    assert_eq!(check("only-link"), Ok(()), "a link is skipped, not opened");
    let with_file = temp.dir("with-file");
    fs::write(with_file.join("f.txt"), b"f").expect("a file");
    fs::hard_link(with_file.join("f.txt"), with_file.join("g.txt")).expect("a hard link");
    assert_eq!(
        check("with-file"),
        Ok(()),
        "a child is opened, not judged as W6"
    );
    let with_dir = temp.dir("with-dir");
    fs::create_dir(with_dir.join("sub")).expect("a directory");
    assert_eq!(check("with-dir"), Ok(()));
    // The check leaves no handle behind: the child can be removed at once.
    fs::remove_dir(with_dir.join("sub")).expect("nothing holds the child");
}

/// Another program saving through a temp file in the root (made and removed,
/// its name sorting first) while the check runs never fails the check: an
/// entry gone or delete-pending by the time it is opened is passed over and
/// the next one is opened (R12-F02).
#[test]
fn the_self_check_passes_over_an_entry_that_vanishes_while_it_runs() {
    let temp = TempDir::new("selfcheck-race");
    let root = temp.dir("root");
    fs::write(root.join("zz-existing.txt"), b"x").expect("a stable file");
    let handle = sys::open_root_directory(&common::extended(&root)).expect("the root opens");
    let stop = Arc::new(AtomicBool::new(false));
    let saver = {
        let stop = Arc::clone(&stop);
        let scratch = root.join(".~save.tmp");
        thread::spawn(move || {
            let mut saves = 0u64;
            while !stop.load(Ordering::Relaxed) {
                if fs::write(&scratch, b"draft").is_ok() && fs::remove_file(&scratch).is_ok() {
                    saves += 1;
                }
            }
            saves
        })
    };
    let mut failures: BTreeMap<u32, u32> = BTreeMap::new();
    for _ in 0..5_000 {
        if let Err(error) = RealProbe.self_check(&handle) {
            *failures.entry(error.0).or_default() += 1;
        }
    }
    stop.store(true, Ordering::Relaxed);
    let saves = saver.join().expect("the saver ends");
    assert!(saves > 0, "the saver never saved");
    assert!(
        failures.is_empty(),
        "{saves} saves; failed checks by system code: {failures:x?}"
    );
}
