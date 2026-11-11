"""Build the team transport bridge (jenny-team-bridge) into build/sidecar/.

Runs on Windows, macOS and Linux; every platform Jenny ships on builds it.
build/sidecar/ is shipped as resources/sidecar by electron-builder.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import platform as platform_module
import shutil
import subprocess
import sys
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
CRATE_RELATIVE = Path("native") / "jenny-team-bridge"
OUTPUT_RELATIVE = Path("build") / "sidecar"
BINARY_STEM = "jenny-team-bridge"
MANIFEST_NAME = "jenny-team-bridge.manifest.json"
PROTOCOL = 1
EXPECTED_VERSION_LINE = f"{BINARY_STEM} protocol {PROTOCOL}"
MINIMUM_RUST = "1.91"
BUILD_TIMEOUT_SECONDS = 600
VERSION_TIMEOUT_SECONDS = 10
TOOL_TIMEOUT_SECONDS = 30


class TeamBridgeBuildError(RuntimeError):
    """A build step failed; the message is safe to print."""


def is_windows(platform: str) -> bool:
    return platform.startswith("win")


def binary_name(platform: str) -> str:
    return f"{BINARY_STEM}.exe" if is_windows(platform) else BINARY_STEM


def check_static_link(data: bytes) -> None:
    """Windows only: the C runtime must be linked in, not a redistributable dependency."""
    if b"vcruntime" in data.lower():
        raise TeamBridgeBuildError("team bridge is not statically linked")


def check_version(binary: Path, runner: Runner) -> None:
    completed = runner(
        [str(binary), "--version"], cwd=binary.parent, timeout_seconds=VERSION_TIMEOUT_SECONDS
    )
    line = (completed.stdout or "").strip()
    if completed.returncode != 0 or line != EXPECTED_VERSION_LINE:
        raise TeamBridgeBuildError(
            f"team bridge --version printed {tail_text(line)!r}, expected {EXPECTED_VERSION_LINE!r}"
        )


def copy_binary(source: Path, output_dir: Path, platform: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / binary_name(platform)
    shutil.copyfile(source, destination)
    if not is_windows(platform):
        destination.chmod(0o755)
    return destination


def _tool_version(runner: Runner, command: list[str], cwd: Path) -> str:
    completed = runner(command, cwd=cwd, timeout_seconds=TOOL_TIMEOUT_SECONDS)
    text = (completed.stdout or "").strip()
    if completed.returncode != 0 or not text:
        raise TeamBridgeBuildError(f"{Path(command[0]).stem} --version failed")
    return text


def _git_metadata(runner: Runner, root: Path) -> dict[str, object]:
    try:
        commit = runner(
            ["git", "rev-parse", "HEAD"], cwd=root, timeout_seconds=TOOL_TIMEOUT_SECONDS
        )
        # Only the crate's own files decide what the bridge is.
        status = runner(
            ["git", "status", "--porcelain", "--", CRATE_RELATIVE.as_posix()],
            cwd=root,
            timeout_seconds=TOOL_TIMEOUT_SECONDS,
        )
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
    root: Path,
    cargo: str,
    runner: Runner,
    env: Mapping[str, str],
    *,
    platform: str,
    machine: str,
    output_dir: Path | None = None,
) -> tuple[Path, str]:
    crate_dir = root / CRATE_RELATIVE
    name = binary_name(platform)
    if not (crate_dir / "Cargo.toml").is_file():
        raise TeamBridgeBuildError(f"team bridge crate is missing: {crate_dir}")
    built_binary = crate_dir / "target" / "release" / name
    output_dir = output_dir or root / OUTPUT_RELATIVE
    # Nothing from an earlier run may pass for this one: not a binary left in
    # target/ when cargo is configured to write elsewhere, nor a shipped copy
    # left behind by a rebuild that then fails.
    for stale in (built_binary, output_dir / name, output_dir / MANIFEST_NAME):
        stale.unlink(missing_ok=True)
    built = runner(
        [cargo, "build", "--release", "--locked", "--manifest-path",
         (crate_dir / "Cargo.toml").as_posix()],
        # Cargo reads .cargo/config.toml (the static C runtime on Windows) from the
        # working directory upwards, not from the manifest path.
        cwd=crate_dir,
        timeout_seconds=BUILD_TIMEOUT_SECONDS,
    )
    if built.returncode != 0:
        output = tail_text((built.stderr or "") + (built.stdout or ""))
        raise TeamBridgeBuildError(
            f"cargo build failed with exit code {built.returncode}\n{output}"
        )
    data = built_binary.read_bytes() if built_binary.is_file() else b""
    if not data:
        raise TeamBridgeBuildError(f"team bridge was not produced or is empty: {built_binary}")
    if is_windows(platform):
        check_static_link(data)
    check_version(built_binary, runner)
    crates = parse_lock_crates((crate_dir / "Cargo.lock").read_text(encoding="utf-8"))
    manifest: dict[str, object] = {
        "name": name,
        "protocol": PROTOCOL,
        "platform": platform,
        "machine": machine,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
        "crate_version": read_crate_version((crate_dir / "Cargo.toml").read_text(encoding="utf-8")),
        "rustc_version": _tool_version(runner, ["rustc", "--version"], crate_dir),
        "cargo_version": _tool_version(runner, [cargo, "--version"], crate_dir),
        **_git_metadata(runner, root),
        "build_timestamp": _build_timestamp(env),
        "crates": crates,
    }
    destination = copy_binary(built_binary, output_dir, platform)
    write_manifest(destination.with_name(MANIFEST_NAME), manifest)
    return destination, str(manifest["sha256"])


def main(  # noqa: PLR0913 - injected seams keep the build testable without cargo
    argv: Sequence[str] | None = None,
    *,
    root: Path = ROOT,
    platform: str = sys.platform,
    machine: str | None = None,
    runner: Runner = run_command,
    which: Callable[[str], str | None] = shutil.which,
    env: Mapping[str, str] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=None,
                        help="where to put the binary and manifest (default: build/sidecar)")
    args = parser.parse_args(argv)
    cargo = which("cargo")
    if cargo is None:
        print(f"team bridge: error: cargo was not found on PATH; install Rust {MINIMUM_RUST} "
              "or newer (https://rustup.rs)", file=sys.stderr)
        return 1
    output_dir = None if args.output_dir is None else (root / args.output_dir)
    try:
        destination, digest = build(
            root, cargo, runner, os.environ if env is None else env,
            platform=platform, machine=machine or platform_module.machine(),
            output_dir=output_dir,
        )
    except subprocess.TimeoutExpired as error:
        print(f"team bridge: error: {Path(str(error.cmd[0])).stem} timed out after "
              f"{error.timeout} seconds", file=sys.stderr)
        return 1
    except (TeamBridgeBuildError, OSError, KeyError, ValueError) as error:
        print(f"team bridge: error: {error}", file=sys.stderr)
        return 1
    shown = destination.relative_to(root).as_posix() if destination.is_relative_to(root) \
        else destination.as_posix()
    print(f"team bridge: {shown}")
    print(f"team bridge: sha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
