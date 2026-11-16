"""Build the Windows file-access library (jenny_file_access.dll) into build/sidecar/.

Windows only: on other systems the script prints a skip and exits 0. The library
is always the default build; the test-seams variant is never built here, and a
library that reports or exports the test seam is refused. build/sidecar/ is
shipped as resources/sidecar by electron-builder, so run this after the sidecar
build, which clears that directory.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping, Sequence

# Run as a script, this directory is on sys.path; the launcher's build owns the
# shared runner, tail and lock-file helpers.
from build_native_launcher import (
    Runner,
    parse_lock_crates,
    read_crate_version,
    run_command,
    tail_text,
    write_manifest,
)

ROOT = Path(__file__).resolve().parents[2]
CRATE_RELATIVE = Path("native") / "jenny-file-access"
OUTPUT_RELATIVE = Path("build") / "sidecar"
LIBRARY_NAME = "jenny_file_access.dll"
MANIFEST_NAME = "jenny_file_access.manifest.json"
ABI_VERSION = 1
SEAM_SYMBOL = "jfa_test_set_token_state"
BUILD_TIMEOUT_SECONDS = 600
TOOL_TIMEOUT_SECONDS = 30


class FileAccessBuildError(RuntimeError):
    """A build step failed; the message is safe to print."""


@dataclass(frozen=True)
class LibraryFacts:
    """What a loaded library says about itself, and whether the seam symbol resolves."""

    abi_version: int
    build_flags: int
    exports_test_seam: bool


Inspector = Callable[[Path], LibraryFacts]


def inspect_library(path: Path) -> LibraryFacts:
    """Load the library by its full path, read its two version exports, and unload it."""
    import _ctypes
    import ctypes

    library = ctypes.WinDLL(str(path))  # type: ignore[attr-defined]  # Windows only
    try:
        for name in ("jfa_abi_version", "jfa_build_flags"):
            try:
                function = getattr(library, name)
            except AttributeError:
                raise FileAccessBuildError(f"file-access library does not export {name}") from None
            function.argtypes = []
            function.restype = ctypes.c_uint32
        facts = LibraryFacts(
            abi_version=int(library.jfa_abi_version()),
            build_flags=int(library.jfa_build_flags()),
            # A second, independent check: the symbol table, not what the library claims.
            exports_test_seam=hasattr(library, SEAM_SYMBOL),
        )
    finally:
        _ctypes.FreeLibrary(library._handle)  # type: ignore[attr-defined]  # Windows only
    return facts


def check_static_link(data: bytes) -> None:
    if b"vcruntime" in data.lower():
        raise FileAccessBuildError("file-access library is not statically linked")


def check_facts(facts: LibraryFacts) -> None:
    if facts.abi_version != ABI_VERSION:
        raise FileAccessBuildError(
            f"file-access library reports ABI version {facts.abi_version}, expected {ABI_VERSION}"
        )
    if facts.build_flags != 0:
        raise FileAccessBuildError(
            f"file-access library reports build flags {facts.build_flags}, expected 0 "
            "(a test-seams build must never ship)"
        )
    if facts.exports_test_seam:
        raise FileAccessBuildError(
            f"file-access library exports {SEAM_SYMBOL}; a test-seams build must never ship"
        )


def remove_previous_output(output_dir: Path) -> None:
    """Nothing from an earlier run may pass for this one."""
    for stale in (output_dir / LIBRARY_NAME, output_dir / MANIFEST_NAME):
        stale.unlink(missing_ok=True)


def _tool_version(runner: Runner, command: list[str], cwd: Path) -> str:
    completed = runner(command, cwd=cwd, timeout_seconds=TOOL_TIMEOUT_SECONDS)
    text = (completed.stdout or "").strip()
    if completed.returncode != 0 or not text:
        raise FileAccessBuildError(f"{Path(command[0]).stem} --version failed")
    return text


def _git_metadata(runner: Runner, root: Path) -> dict[str, object]:
    try:
        commit = runner(["git", "rev-parse", "HEAD"], cwd=root, timeout_seconds=TOOL_TIMEOUT_SECONDS)
        # Only the crate's own files decide what the library is.
        status = runner(["git", "status", "--porcelain", "--", CRATE_RELATIVE.as_posix()],
                        cwd=root, timeout_seconds=TOOL_TIMEOUT_SECONDS)
    except OSError:
        return {"git_commit": None, "git_dirty": None}
    if commit.returncode != 0 or not (commit.stdout or "").strip():
        return {"git_commit": None, "git_dirty": None}
    return {"git_commit": commit.stdout.strip(),
            "git_dirty": bool(status.stdout.strip()) if status.returncode == 0 else None}


def _build_timestamp(env: Mapping[str, str]) -> str:
    epoch = env.get("SOURCE_DATE_EPOCH", "")
    if epoch.isdigit():
        moment = datetime.fromtimestamp(int(epoch), tz=timezone.utc)
    else:
        moment = datetime.now(timezone.utc)
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build(  # noqa: PLR0913 - injected seams keep the build testable without cargo
    root: Path, cargo: str, runner: Runner, env: Mapping[str, str], inspector: Inspector
) -> tuple[Path, str]:
    crate_dir = root / CRATE_RELATIVE
    if not (crate_dir / "Cargo.toml").is_file():
        raise FileAccessBuildError(f"file-access crate is missing: {crate_dir}")
    built_library = crate_dir / "target" / "release" / LIBRARY_NAME
    output_dir = root / OUTPUT_RELATIVE
    # Not a library left in target/ when cargo is configured to write elsewhere.
    # (The shipped copy was already removed in main, before anything could fail.)
    built_library.unlink(missing_ok=True)
    # Release profile, default features: the test-seams feature is never passed.
    # Run from the crate directory so its .cargo/config.toml (static C runtime) applies.
    built = runner([cargo, "build", "--release", "--locked"], cwd=crate_dir,
                   timeout_seconds=BUILD_TIMEOUT_SECONDS)
    if built.returncode != 0:
        output = tail_text((built.stderr or "") + (built.stdout or ""))
        raise FileAccessBuildError(f"cargo build failed with exit code {built.returncode}\n{output}")
    data = built_library.read_bytes() if built_library.is_file() else b""
    if not data:
        raise FileAccessBuildError(f"file-access library was not produced or is empty: {built_library}")
    check_static_link(data)
    check_facts(inspector(built_library))
    crates = parse_lock_crates((crate_dir / "Cargo.lock").read_text(encoding="utf-8"))
    manifest: dict[str, object] = {
        "name": LIBRARY_NAME,
        "abi_version": ABI_VERSION,
        "build_flags": 0,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
        "crate_version": read_crate_version((crate_dir / "Cargo.toml").read_text(encoding="utf-8")),
        "rustc_version": _tool_version(runner, ["rustc", "--version"], crate_dir),
        "cargo_version": _tool_version(runner, [cargo, "--version"], crate_dir),
        **_git_metadata(runner, root),
        "build_timestamp": _build_timestamp(env),
        "crates": crates,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / LIBRARY_NAME
    # The bytes that were hashed and checked are the bytes that ship.
    destination.write_bytes(data)
    write_manifest(destination.with_name(MANIFEST_NAME), manifest)
    return destination, str(manifest["sha256"])


def main(  # noqa: PLR0913 - injected seams keep the build testable without cargo
    argv: Sequence[str] | None = None,
    *,
    root: Path = ROOT,
    platform: str = sys.platform,
    runner: Runner = run_command,
    which: Callable[[str], str | None] = shutil.which,
    env: Mapping[str, str] | None = None,
    inspector: Inspector = inspect_library,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--allow-missing-toolchain", action="store_true",
                        help="skip with exit 0 when cargo is not on PATH")
    args = parser.parse_args(argv)
    if not platform.startswith("win"):
        print("file access: skipped (Windows only)")
        return 0
    # Every Windows exit leaves no library from an earlier run, whatever fails next.
    remove_previous_output(root / OUTPUT_RELATIVE)
    cargo = which("cargo")
    if cargo is None:
        if args.allow_missing_toolchain:
            print("file access: skipped (cargo not found)")
            return 0
        print("file access: error: cargo was not found on PATH; install a Rust toolchain "
              "or pass --allow-missing-toolchain", file=sys.stderr)
        return 1
    try:
        destination, digest = build(root, cargo, runner, os.environ if env is None else env, inspector)
    except subprocess.TimeoutExpired as error:
        print(f"file access: error: {Path(str(error.cmd[0])).stem} timed out after "
              f"{error.timeout} seconds", file=sys.stderr)
        return 1
    except (FileAccessBuildError, OSError, KeyError, ValueError) as error:
        print(f"file access: error: {error}", file=sys.stderr)
        return 1
    print(f"file access: {destination.relative_to(root).as_posix()}")
    print(f"file access: {destination.with_name(MANIFEST_NAME).relative_to(root).as_posix()}")
    print(f"file access: sha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
