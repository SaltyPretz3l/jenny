//! The race loop (W14's machine half): writes run while another thread swaps
//! the leaf's parent for a junction to an outside directory and the leaf for
//! a hard link to an outside file. Whatever wins each race, nothing outside
//! the project changes and no temp is left.
//!
//! 200 iterations by default; `JENNY_RACE_ITERATIONS` raises the count (a
//! smaller value is ignored, a larger one is capped at 5,000). The run fails
//! when no race took place: no swap landed and no write met a junction. The
//! counts are printed.
#![cfg(windows)]

mod common;

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use common::{make_junction, names_in, note, plain_directory, segments, temps, Project};
use jenny_file_access::abi::{Reason, Status};
use jenny_file_access::win::write::{self, Expectation, Outcome, WriteHooks};

const DEFAULT_ITERATIONS: u32 = 200;
const MAX_ITERATIONS: u32 = 5_000;
const SECRET: &[u8] = b"secret";

fn iterations() -> u32 {
    std::env::var("JENNY_RACE_ITERATIONS")
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
        .map_or(DEFAULT_ITERATIONS, |asked| {
            asked.clamp(DEFAULT_ITERATIONS, MAX_ITERATIONS)
        })
}

/// What one attacker round managed.
#[derive(Default)]
struct Landed {
    /// The junction stood at the parent's name.
    swaps: u64,
    /// The hard link to the outside file stood at the leaf's name.
    links: u64,
}

/// One round of the attacker. Every step may fail, and none may panic: the
/// write it races holds handles that make some steps impossible.
fn attack(root: &Path, outside: &Path, landed: &mut Landed) {
    let (parent, parked, link) = (root.join("p"), root.join("p-old"), root.join("pj"));
    // The parent for the junction: possible only while no write holds it.
    if fs::rename(&parent, &parked).is_ok() {
        if fs::rename(&link, &parent).is_ok() {
            landed.swaps += 1;
            // Long enough for writes to meet the junction.
            thread::sleep(Duration::from_millis(1));
        }
        if !plain_directory(&parent) {
            let _ = fs::rename(&parent, &link);
        }
        if fs::rename(&parked, &parent).is_err() {
            // A write made a new `p` meanwhile; the parked one goes.
            let _ = fs::remove_dir_all(&parked);
        }
    }
    // The leaf for a hard link to the outside file, only in a real parent.
    if plain_directory(&parent) {
        let leaf = parent.join("t.txt");
        let _ = fs::remove_file(&leaf);
        if fs::hard_link(outside.join("secret.txt"), &leaf).is_ok() {
            landed.links += 1;
            thread::yield_now();
            let _ = fs::remove_file(&leaf);
        }
    }
}

fn outside_unchanged(outside: &Path) {
    assert_eq!(fs::read(outside.join("secret.txt")).expect("reads"), SECRET);
    assert_eq!(
        names_in(outside),
        ["secret.txt"],
        "nothing was made outside"
    );
}

#[test]
fn racing_swaps_never_reach_outside_the_project_and_leave_no_temp() {
    let project = Project::new("race");
    let root = project.root.clone();
    let outside = project.temp.dir("outside");
    fs::write(outside.join("secret.txt"), SECRET).expect("an outside file");
    fs::create_dir(root.join("p")).expect("a parent");
    make_junction(&root.join("pj"), &outside);

    let stop = Arc::new(AtomicBool::new(false));
    let attacker = {
        let (stop, root, outside) = (Arc::clone(&stop), root.clone(), outside.clone());
        thread::spawn(move || {
            let (mut rounds, mut landed) = (0u64, Landed::default());
            while !stop.load(Ordering::SeqCst) {
                attack(&root, &outside, &mut landed);
                rounds += 1;
                // Gives the writer the core between rounds.
                thread::yield_now();
            }
            (rounds, landed)
        })
    };

    let count = iterations();
    let list = segments(&["p", "t.txt"]);
    let (mut replaced, mut refused, mut met_junction) = (0u32, 0u32, 0u32);
    for iteration in 0..count {
        let content = format!("ours {iteration}");
        let result = write::write_atomic(
            project.root_handle(),
            &list,
            content.as_bytes(),
            Expectation::NoExpectation,
            &mut WriteHooks::default(),
        );
        match result {
            Ok(Outcome::Replaced) => replaced += 1,
            Ok(Outcome::NotMatched) => panic!("no expectation is never not matched"),
            Err(refusal) => {
                // What a lost race may answer: a refusal of the swapped
                // name, a changed leaf, a held name, or the system's own
                // failure while a name moves. `alias_mismatch` comes from
                // the leaf query: it opens for attributes only, which takes
                // part in no sharing check, so the attacker can delete the
                // name under it and the final path then names the deleted
                // file, not `t.txt`.
                let expected = matches!(
                    (refusal.status, refusal.reason),
                    (
                        Status::PathRefused,
                        Reason::None
                            | Reason::ReparsePoint
                            | Reason::NotRegular
                            | Reason::MissingDirectory
                            | Reason::AliasMismatch
                    ) | (
                        Status::NotFound | Status::Busy | Status::IoFailed,
                        Reason::None
                    )
                );
                assert!(expected, "iteration {iteration}: {refusal:?}");
                refused += 1;
                if refusal.reason == Reason::ReparsePoint {
                    met_junction += 1;
                }
            }
        }
        outside_unchanged(&outside);
        // A write holds the parent almost all the time; every fourth one is
        // followed by a pause in which a swap can land.
        if iteration % 4 == 3 {
            thread::sleep(Duration::from_millis(1));
        }
    }
    stop.store(true, Ordering::SeqCst);
    let (rounds, landed) = attacker.join().expect("the attacker ends");

    outside_unchanged(&outside);
    let left = temps(&root);
    assert!(left.is_empty(), "temps left: {left:?}");
    let counts = format!(
        "{count} writes ({replaced} replaced, {refused} refused, {met_junction} met the junction) {}",
        format_args!(
            "against {rounds} attacker rounds ({} swaps and {} hard links landed)",
            landed.swaps, landed.links
        )
    );
    note(
        "RACE",
        "racing_swaps_never_reach_outside_the_project_and_leave_no_temp",
        &counts,
    );
    assert!(
        landed.swaps > 0 || met_junction > 0,
        "no race took place: {counts}"
    );
}
