"""Behaviour tests for scripts/packaging/build_native_launcher.py (no cargo needed)."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "packaging"))

import build_native_launcher as bnl  # noqa: E402

LOCK_TEXT = """version = 4

[[package]]
name = "zeta"
version = "1.0.0"

[[package]]
name = "alpha"
version = "2.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "alpha"
version = "1.5.0"
"""
CARGO_TOML = '[package]\nname = "jenny-launch"\nversion = "0.3.1"\nedition = "2021"\n'
GOOD_EXE = b"MZ" + b"\x00" * 64 + b"static runtime only"


def make_crate(root: Path) -> Path:
    crate = root / "native" / "jenny-launch"
    crate.mkdir(parents=True)
    (crate / "Cargo.toml").write_text(CARGO_TOML, encoding="utf-8")
    (crate / "Cargo.lock").write_text(LOCK_TEXT, encoding="utf-8")
    return crate


def done(command: list[str], code: int = 0, out: str = "", err: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(command, code, out, err)


class FakeRunner:
    """Stands in for cargo, rustc, git and the built launcher."""

    def __init__(self, exe_bytes: bytes = GOOD_EXE, version_line: str = "jenny-launch protocol 1\n",
                 cargo_code: int = 0, writes_exe: bool = True) -> None:
        self.exe_bytes, self.version_line, self.cargo_code = exe_bytes, version_line, cargo_code
        self.writes_exe = writes_exe
        self.calls: list[tuple[list[str], Path, int]] = []

    def __call__(self, command: list[str], *, cwd: Path, timeout_seconds: int) -> subprocess.CompletedProcess[str]:
        self.calls.append((command, cwd, timeout_seconds))
        if command[1:3] == ["build", "--release"]:
            if self.cargo_code == 0 and self.writes_exe:
                exe = cwd / "target" / "release" / "jenny-launch.exe"
                exe.parent.mkdir(parents=True, exist_ok=True)
                exe.write_bytes(self.exe_bytes)
            return done(command, self.cargo_code, "", "error: boom\n")
        if command[0] == "C:/cargo.exe" and command[1:] == ["--version"]:
            return done(command, 0, "cargo 1.90.0\n")
        if command[0] == "rustc":
            return done(command, 0, "rustc 1.90.0\n")
        if command[:2] == ["git", "rev-parse"]:
            return done(command, 0, "abc123\n")
        if command[:2] == ["git", "status"]:
            return done(command, 0, " M file\n")
        return done(command, 0, self.version_line)  # the launcher itself


def run_main(root: Path, runner: FakeRunner, argv: list[str] | None = None, platform: str = "win32",
             cargo: str | None = "C:/cargo.exe") -> int:
    return bnl.main(argv or [], root=root, platform=platform, runner=runner,
                    which=lambda name: cargo, env={"SOURCE_DATE_EPOCH": "1700000000"})


def test_non_windows_skips_and_writes_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    runner = FakeRunner()
    assert run_main(tmp_path, runner, platform="linux") == 0
    assert "native launcher: skipped (Windows only)" in capsys.readouterr().out
    assert runner.calls == []
    assert list(tmp_path.iterdir()) == []


def test_missing_cargo_skips_only_with_flag(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    runner = FakeRunner()
    assert run_main(tmp_path, runner, ["--allow-missing-toolchain"], cargo=None) == 0
    assert "native launcher: skipped (cargo not found)" in capsys.readouterr().out
    assert run_main(tmp_path, runner, cargo=None) == 1
    assert "cargo" in capsys.readouterr().err
    assert runner.calls == [] and not (tmp_path / "build").exists()


def test_missing_crate_directory_is_an_error(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert run_main(tmp_path, FakeRunner()) == 1
    assert "jenny-launch" in capsys.readouterr().err


def test_failing_cargo_run_prints_tail_and_writes_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(cargo_code=101)) == 1
    assert "error: boom" in capsys.readouterr().err
    assert not (tmp_path / "build").exists()


def test_cargo_runs_locked_in_the_crate_directory_with_timeout(tmp_path: Path) -> None:
    crate = make_crate(tmp_path)
    runner = FakeRunner()
    assert run_main(tmp_path, runner) == 0
    command, cwd, timeout = runner.calls[0]
    assert command == ["C:/cargo.exe", "build", "--release", "--locked"]
    assert cwd == crate and timeout == 600


def test_static_link_check_flags_vcruntime_in_any_case() -> None:
    bnl.check_static_link(GOOD_EXE)
    for needle in (b"VCRUNTIME140.dll", b"vcruntime140_1.dll"):
        with pytest.raises(bnl.LauncherBuildError, match="not statically linked"):
            bnl.check_static_link(b"MZ" + needle + b"\x00")


def test_empty_executable_is_rejected(tmp_path: Path) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(exe_bytes=b"")) == 1
    assert not (tmp_path / "build").exists()


def test_vcruntime_dependency_fails_the_build(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(exe_bytes=GOOD_EXE + b"VCRUNTIME140.dll")) == 1
    assert "not statically linked" in capsys.readouterr().err


def test_wrong_version_line_fails_the_build(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(version_line="jenny-launch protocol 2\n")) == 1
    assert "protocol 2" in capsys.readouterr().err
    assert not (tmp_path / "build").exists()


def test_lock_parsing_keeps_two_versions_sorted() -> None:
    assert bnl.parse_lock_crates(LOCK_TEXT) == [
        {"name": "alpha", "version": "1.5.0"},
        {"name": "alpha", "version": "2.0.0"},
        {"name": "zeta", "version": "1.0.0"},
    ]


def test_successful_build_copies_and_writes_the_manifest(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    out = tmp_path / "build" / "sidecar"
    out.mkdir(parents=True)
    (out / "sidecar.exe").write_bytes(b"sidecar")
    (out / "manifest.json").write_text("{}", encoding="utf-8")
    assert run_main(tmp_path, FakeRunner()) == 0
    assert (out / "jenny-launch.exe").read_bytes() == GOOD_EXE
    assert (out / "sidecar.exe").read_bytes() == b"sidecar"
    assert (out / "manifest.json").read_text(encoding="utf-8") == "{}"
    text = (out / "jenny-launch.manifest.json").read_text(encoding="utf-8")
    assert text.endswith("}\n") and text.startswith('{\n  "build_timestamp"')
    manifest = json.loads(text)
    assert list(manifest) == sorted(manifest)
    assert set(manifest) == {"name", "protocol", "sha256", "size_bytes", "crate_version", "rustc_version",
                             "cargo_version", "git_commit", "git_dirty", "build_timestamp", "crates"}
    assert manifest["name"] == "jenny-launch.exe" and manifest["protocol"] == 1
    assert manifest["size_bytes"] == len(GOOD_EXE) and len(manifest["sha256"]) == 64
    assert manifest["crate_version"] == "0.3.1" and manifest["git_dirty"] is True
    assert manifest["build_timestamp"] == "2023-11-14T22:13:20Z"
    assert manifest["crates"][0] == {"name": "alpha", "version": "1.5.0"}
    printed = capsys.readouterr().out
    assert manifest["sha256"] in printed and "build/sidecar/jenny-launch.exe" in printed


def test_failed_rebuild_removes_the_launcher_an_earlier_run_shipped(tmp_path: Path) -> None:
    make_crate(tmp_path)
    out = tmp_path / "build" / "sidecar"
    assert run_main(tmp_path, FakeRunner()) == 0
    assert (out / "jenny-launch.exe").is_file()
    assert run_main(tmp_path, FakeRunner(cargo_code=101)) == 1
    assert not (out / "jenny-launch.exe").exists()
    assert not (out / "jenny-launch.manifest.json").exists()


def test_binary_left_by_an_earlier_run_is_not_shipped_when_cargo_writes_none(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    crate = make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner()) == 0
    assert (crate / "target" / "release" / "jenny-launch.exe").is_file()
    capsys.readouterr()
    assert run_main(tmp_path, FakeRunner(writes_exe=False)) == 1
    assert "was not produced" in capsys.readouterr().err
    assert not (tmp_path / "build" / "sidecar" / "jenny-launch.exe").exists()


def test_dirty_flag_looks_only_at_the_crate(tmp_path: Path) -> None:
    make_crate(tmp_path)
    runner = FakeRunner()
    assert run_main(tmp_path, runner) == 0
    status = [command for command, _, _ in runner.calls if command[:2] == ["git", "status"]]
    assert status == [["git", "status", "--porcelain", "--", "native/jenny-launch"]]


def test_copy_launcher_creates_the_directory_and_keeps_neighbours(tmp_path: Path) -> None:
    source = tmp_path / "src.exe"
    source.write_bytes(b"exe")
    dest = tmp_path / "out"
    assert bnl.copy_launcher(source, dest) == dest / "jenny-launch.exe"
    (dest / "other.txt").write_text("keep", encoding="utf-8")
    bnl.copy_launcher(source, dest)
    assert (dest / "other.txt").read_text(encoding="utf-8") == "keep"


def test_runner_times_out_and_cleans_up_the_process(tmp_path: Path) -> None:
    beat = tmp_path / "beat.txt"
    script = (
        "import sys, time\n"
        "while True:\n"
        "    open(sys.argv[1], 'a').write('x')\n"
        "    time.sleep(0.05)\n"
    )
    with pytest.raises(subprocess.TimeoutExpired):
        bnl.run_command([sys.executable, "-c", script, str(beat)], cwd=ROOT, timeout_seconds=1)
    written = beat.stat().st_size
    assert written > 0
    time.sleep(0.4)
    assert beat.stat().st_size == written, "the timed-out process is still running"


def test_names_and_version_line_agree_across_their_three_owners() -> None:
    # The build script, the sidecar's resolver and the crate each hold a copy;
    # a bump that misses one would make the sidecar quietly fall back.
    from sidecar.ai.tools.builtins import owned_process_native as native

    assert bnl.EXPECTED_VERSION_LINE == native.NATIVE_LAUNCHER_VERSION_LINE
    assert bnl.EXE_NAME == native.NATIVE_LAUNCHER_FILE_NAME
    assert native.native_launcher_path() == ROOT / bnl.OUTPUT_RELATIVE / bnl.EXE_NAME
    crate_source = (ROOT / bnl.CRATE_RELATIVE / "src" / "lib.rs").read_text(encoding="utf-8")
    assert f'const VERSION_LINE: &str = "{bnl.EXPECTED_VERSION_LINE}\\n";' in crate_source
