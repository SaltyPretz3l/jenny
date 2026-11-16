# jenny-file-access

A small Rust library that gives a Jenny team host on Windows the same confined
file access a Linux or macOS host gets from directory file descriptors. The
Python sidecar loads `jenny_file_access.dll` and calls its `jfa_` exports; a
name, a junction, a link, a short-name alias or a swapped folder must never
take a file tool outside the project root.

The design, the boundary rules every export keeps and what is built so far are
in `docs/plans/TEAM_WINDOWS_FILE_ACCESS_SPEC.md`. The interface is frozen as
data in `abi.json` beside this file: exports, argument kinds, status and detail
numbers, the listing record and the limits. A Rust test and a Python test both
compare their side with that file, so the two cannot drift silently. A change
to `abi.json` goes through the team program's orchestrator.

**Nothing ships or loads this library yet.**

## Layout

| File | Role |
|---|---|
| `src/lib.rs` | Lints and the module list |
| `src/abi.rs` | The interface's numbers. Pure |
| `src/names.rs` | Segment validation and segment-list splitting. Pure |
| `src/pins.rs` | Generation-checked token tables. Pure |
| `src/listing.rs` | The listing record encoder. Pure |
| `src/ffi.rs` | The exports, the argument checks and the panic guard |
| `src/win/sys.rs` | One safe wrapper per system call, and the owned handle |
| `src/win/sys/file.rs` | The calls below the root: the relative open, queries by handle, enumeration, read, write, flush, rename and delete by handle, the random source |
| `src/win/policy.rs` | Token, volume, API presence and self-check behind `SystemProbe` |
| `src/win/root.rs` | Root shape, open, final path, identity and the pin table |
| `src/win/walk.rs` | The segment walk and the write's creating walk (mkdir), the on-disk name check, the regular-file open and the file table |
| `src/win/dir.rs` | Listing a directory by its own handle, and the root's self-check |
| `src/win/write.rs` | Atomic write and conditional replacement, with its Rust-only hooks |
| `src/stub.rs` | The same symbols on other systems, each `platform_unsupported` |

## Build and test

Run cargo from this folder: `.cargo/config.toml`, which links the C runtime
statically, is read from the current folder and not from `--manifest-path`.

```
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --release --locked
```

The Windows tests make their files under a temp directory they create and
remove, need no elevation, and need that temp directory on local NTFS. A case
that cannot run on the account prints a line that starts with `SKIPPED` and
says why. `tests/win_race.rs` runs 200 racing writes by default; set
`JENNY_RACE_ITERATIONS` to run more (a smaller number is ignored, a larger
one is capped at 5,000).

On Linux and macOS the crate compiles, the pure tests run, and the Windows
tests are compiled out.

## The test-seams build

Add `--features test-seams --target-dir target/seams` to the clippy and test
commands for the variant that exports `jfa_test_set_token_state` and reports
bit 0 in `jfa_build_flags()`. It exists so end-to-end tests can run on a CI
runner whose own token is elevated. `tests/exports.rs` reads the export table
of the library cargo just built and checks both builds: the symbol is absent
from the default build and present in this one. A shipped library is always the
default build; the loader and the packaging step refuse the other.
