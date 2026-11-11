"""Build the native owned-process launcher into build/sidecar/ (Windows only)."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[2]
CRATE_RELATIVE = Path("native") / "jenny-launch"
OUTPUT_RELATIVE = Path("build") / "sidecar"
EXE_NAME = "jenny-launch.exe"
MANIFEST_NAME = "jenny-launch.manifest.json"
PROTOCOL = 1
EXPECTED_VERSION_LINE = f"jenny-launch protocol {PROTOCOL}"
BUILD_TIMEOUT_SECONDS = 600
VERSION_TIMEOUT_SECONDS = 10
TOOL_TIMEOUT_SECONDS = 30
DRAIN_TIMEOUT_SECONDS = 30
TAIL_LINES = 40
TAIL_CHARS = 4000

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


class LauncherBuildError(RuntimeError):
    """A build step failed; the message is safe to print."""


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if sys.platform.startswith("win"):
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       check=False, capture_output=True, text=True)
    else:
        process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run_command(
    command: list[str], *, cwd: Path, timeout_seconds: int
) -> subprocess.CompletedProcess[str]:
    """Run a command, killing its process tree on timeout (same shape as build_sidecar_artifact)."""
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               encoding="utf-8", errors="replace", text=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        _terminate_process_tree(process)
        try:
            stdout, stderr = process.communicate(timeout=DRAIN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            stdout, stderr = "", ""
        raise subprocess.TimeoutExpired(
            command, timeout_seconds, output=stdout, stderr=stderr
        ) from error
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def tail_text(text: str) -> str:
    """Bounded tail of untrusted tool output; it is printed, never evaluated."""
    lines = text.strip().splitlines()[-TAIL_LINES:]
    return "\n".join(lines)[-TAIL_CHARS:]


def parse_lock_crates(lock_text: str) -> list[dict[str, str]]:
    packages = tomllib.loads(lock_text).get("package", [])
    crates = [{"name": str(item["name"]), "version": str(item["version"])} for item in packages]
    return sorted(crates, key=lambda crate: (crate["name"], crate["version"]))


def read_crate_version(cargo_toml_text: str) -> str:
    return str(tomllib.loads(cargo_toml_text)["package"]["version"])


def check_static_link(data: bytes) -> None:
    if b"vcruntime" in data.lower():
        raise LauncherBuildError("native launcher is not statically linked")


def check_version(exe: Path, runner: Runner) -> None:
    completed = runner(
        [str(exe), "--version"], cwd=exe.parent, timeout_seconds=VERSION_TIMEOUT_SECONDS
    )
    line = (completed.stdout or "").strip()
    if completed.returncode != 0 or line != EXPECTED_VERSION_LINE:
        raise LauncherBuildError(
            f"native launcher --version printed {tail_text(line)!r}, "
            f"expected {EXPECTED_VERSION_LINE!r}"
        )


def copy_launcher(source: Path, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / EXE_NAME
    shutil.copyfile(source, destination)
    return destination


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _tool_version(runner: Runner, command: list[str], cwd: Path) -> str:
    completed = runner(command, cwd=cwd, timeout_seconds=TOOL_TIMEOUT_SECONDS)
    text = (completed.stdout or "").strip()
    if completed.returncode != 0 or not text:
        raise LauncherBuildError(f"{command[0]} --version failed")
    return text


def _git_metadata(runner: Runner, root: Path) -> dict[str, object]:
    try:
        commit = runner(
            ["git", "rev-parse", "HEAD"], cwd=root, timeout_seconds=TOOL_TIMEOUT_SECONDS
        )
        # Only the crate's own files decide what the launcher is.
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


def write_manifest(path: Path, manifest: dict[str, object]) -> None:
    text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")


def build(root: Path, cargo: str, runner: Runner, env: Mapping[str, str]) -> tuple[Path, str]:
    crate_dir = root / CRATE_RELATIVE
    if not (crate_dir / "Cargo.toml").is_file():
        raise LauncherBuildError(f"native launcher crate is missing: {crate_dir}")
    exe = crate_dir / "target" / "release" / EXE_NAME
    output_dir = root / OUTPUT_RELATIVE
    # Nothing from an earlier run may pass for this one: not a binary left in
    # target/ when cargo is configured to write elsewhere, nor a shipped copy
    # left behind by a rebuild that then fails.
    for stale in (exe, output_dir / EXE_NAME, output_dir / MANIFEST_NAME):
        stale.unlink(missing_ok=True)
    built = runner(
        [cargo, "build", "--release", "--locked"],
        cwd=crate_dir,
        timeout_seconds=BUILD_TIMEOUT_SECONDS,
    )
    if built.returncode != 0:
        output = tail_text((built.stderr or "") + (built.stdout or ""))
        raise LauncherBuildError(
            f"cargo build failed with exit code {built.returncode}\n{output}"
        )
    data = exe.read_bytes() if exe.is_file() else b""
    if not data:
        raise LauncherBuildError(f"native launcher was not produced or is empty: {exe}")
    check_static_link(data)
    check_version(exe, runner)
    crates = parse_lock_crates((crate_dir / "Cargo.lock").read_text(encoding="utf-8"))
    manifest: dict[str, object] = {
        "name": EXE_NAME,
        "protocol": PROTOCOL,
        "sha256": _sha256(data),
        "size_bytes": len(data),
        "crate_version": read_crate_version((crate_dir / "Cargo.toml").read_text(encoding="utf-8")),
        "rustc_version": _tool_version(runner, ["rustc", "--version"], crate_dir),
        "cargo_version": _tool_version(runner, [cargo, "--version"], crate_dir),
        **_git_metadata(runner, root),
        "build_timestamp": _build_timestamp(env),
        "crates": crates,
    }
    destination = copy_launcher(exe, output_dir)
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
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-missing-toolchain", action="store_true",
                        help="skip with exit 0 when cargo is not on PATH")
    args = parser.parse_args(argv)
    if not platform.startswith("win"):
        print("native launcher: skipped (Windows only)")
        return 0
    cargo = which("cargo")
    if cargo is None:
        if args.allow_missing_toolchain:
            print("native launcher: skipped (cargo not found)")
            return 0
        print("native launcher: error: cargo was not found on PATH; install a Rust toolchain "
              "or pass --allow-missing-toolchain", file=sys.stderr)
        return 1
    try:
        destination, digest = build(root, cargo, runner, os.environ if env is None else env)
    except subprocess.TimeoutExpired as error:
        print(
            f"native launcher: error: {error.cmd[0]} timed out after {error.timeout} seconds",
            file=sys.stderr,
        )
        return 1
    except (LauncherBuildError, OSError, KeyError, ValueError) as error:
        print(f"native launcher: error: {error}", file=sys.stderr)
        return 1
    print(f"native launcher: {destination.relative_to(root).as_posix()}")
    print(f"native launcher: {destination.with_name(MANIFEST_NAME).relative_to(root).as_posix()}")
    print(f"native launcher: sha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
