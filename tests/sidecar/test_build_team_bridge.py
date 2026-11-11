"""Behaviour tests for scripts/packaging/build_team_bridge.py (no cargo needed)."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "packaging"))

import build_team_bridge as btb  # noqa: E402

LOCK_TEXT = """version = 4

[[package]]
name = "zeta"
version = "1.0.0"

[[package]]
name = "alpha"
version = "2.0.0"
"""
CARGO_TOML = '[package]\nname = "jenny-team-bridge"\nversion = "0.2.0"\nedition = "2021"\n'
GOOD_BINARY = b"\x7fELF" + b"\x00" * 64 + b"static runtime only"
VERSION_LINE = "jenny-team-bridge protocol 1\n"


def make_crate(root: Path) -> Path:
    crate = root / "native" / "jenny-team-bridge"
    crate.mkdir(parents=True)
    (crate / "Cargo.toml").write_text(CARGO_TOML, encoding="utf-8")
    (crate / "Cargo.lock").write_text(LOCK_TEXT, encoding="utf-8")
    return crate


def done(command: list[str], code: int = 0, out: str = "", err: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(command, code, out, err)


class FakeRunner:
    """Stands in for cargo, rustc, git and the built bridge."""

    def __init__(self, binary_bytes: bytes = GOOD_BINARY, version_line: str = VERSION_LINE,
                 cargo_code: int = 0, name: str = "jenny-team-bridge") -> None:
        self.binary_bytes, self.version_line, self.cargo_code = binary_bytes, version_line, cargo_code
        self.name = name
        self.cargo_stderr = "error: boom\n"
        self.writes_binary = True
        self.calls: list[tuple[list[str], Path, int]] = []
        self.shipped_when_cargo_ran: list[bool] = []
        self.output_dir: Path | None = None

    def __call__(self, command: list[str], *, cwd: Path, timeout_seconds: int) -> subprocess.CompletedProcess[str]:
        self.calls.append((command, cwd, timeout_seconds))
        if command[1:3] == ["build", "--release"]:
            built = cwd / "target" / "release" / self.name
            self.shipped_when_cargo_ran.append(built.exists())
            if self.cargo_code == 0 and self.writes_binary:
                built.parent.mkdir(parents=True, exist_ok=True)
                built.write_bytes(self.binary_bytes)
            return done(command, self.cargo_code, "", self.cargo_stderr)
        if command[0] == "cargo-bin" and command[1:] == ["--version"]:
            return done(command, 0, "cargo 1.99.0\n")
        if command[0] == "rustc":
            return done(command, 0, "rustc 1.99.1\n")
        if command[:2] == ["git", "rev-parse"]:
            return done(command, 0, "abc123\n")
        if command[:2] == ["git", "status"]:
            return done(command, 0, "")
        return done(command, 0, self.version_line)  # the bridge itself


def run_main(root: Path, runner: FakeRunner, argv: list[str] | None = None, platform: str = "linux",
             cargo: str | None = "cargo-bin") -> int:
    return btb.main(argv or [], root=root, platform=platform, machine="x86_64", runner=runner,
                    which=lambda name: cargo, env={"SOURCE_DATE_EPOCH": "1700000000"})


@pytest.mark.parametrize(("platform", "name"), [
    ("win32", "jenny-team-bridge.exe"), ("linux", "jenny-team-bridge"), ("darwin", "jenny-team-bridge"),
])
def test_success_writes_binary_and_manifest_on_every_platform(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], platform: str, name: str
) -> None:
    make_crate(tmp_path)
    out = tmp_path / "build" / "sidecar"
    out.mkdir(parents=True)
    (out / "sidecar").write_bytes(b"sidecar")
    runner = FakeRunner(name=name)
    assert run_main(tmp_path, runner, platform=platform) == 0
    assert (out / name).read_bytes() == GOOD_BINARY
    assert (out / "sidecar").read_bytes() == b"sidecar"
    text = (out / "jenny-team-bridge.manifest.json").read_text(encoding="utf-8")
    assert text.endswith("}\n") and "\r" not in text
    manifest = json.loads(text)
    assert list(manifest) == sorted(manifest)
    assert set(manifest) == {"name", "protocol", "platform", "machine", "sha256", "size_bytes", "crate_version",
                             "rustc_version", "cargo_version", "git_commit", "git_dirty", "build_timestamp",
                             "crates"}
    assert manifest["name"] == name and manifest["protocol"] == 1
    assert manifest["platform"] == platform and manifest["machine"] == "x86_64"
    assert manifest["size_bytes"] == len(GOOD_BINARY) and len(manifest["sha256"]) == 64
    assert manifest["crate_version"] == "0.2.0" and manifest["git_dirty"] is False
    assert manifest["rustc_version"] == "rustc 1.99.1" and manifest["cargo_version"] == "cargo 1.99.0"
    assert manifest["build_timestamp"] == "2023-11-14T22:13:20Z"
    assert manifest["crates"] == [{"name": "alpha", "version": "2.0.0"}, {"name": "zeta", "version": "1.0.0"}]
    printed = capsys.readouterr().out
    assert manifest["sha256"] in printed and f"build/sidecar/{name}" in printed


def test_cargo_runs_locked_against_the_crate_manifest_with_a_timeout(tmp_path: Path) -> None:
    crate = make_crate(tmp_path)
    runner = FakeRunner()
    assert run_main(tmp_path, runner) == 0
    command, cwd, timeout = runner.calls[0]
    assert command[:5] == ["cargo-bin", "build", "--release", "--locked", "--manifest-path"]
    assert Path(command[5]) == crate / "Cargo.toml"
    # The crate's .cargo/config.toml (static C runtime) is found from the working directory.
    assert cwd == crate and timeout == 600


def test_stale_copies_are_deleted_before_the_build(tmp_path: Path) -> None:
    crate = make_crate(tmp_path)
    out = tmp_path / "build" / "sidecar"
    out.mkdir(parents=True)
    (out / "jenny-team-bridge").write_bytes(b"old shipped")
    (out / "jenny-team-bridge.manifest.json").write_text("{}", encoding="utf-8")
    left = crate / "target" / "release" / "jenny-team-bridge"
    left.parent.mkdir(parents=True)
    left.write_bytes(b"old built")
    runner = FakeRunner()
    assert run_main(tmp_path, runner) == 0
    assert runner.shipped_when_cargo_ran == [False]
    assert (out / "jenny-team-bridge").read_bytes() == GOOD_BINARY


def test_failed_rebuild_removes_what_an_earlier_run_shipped(tmp_path: Path) -> None:
    make_crate(tmp_path)
    out = tmp_path / "build" / "sidecar"
    assert run_main(tmp_path, FakeRunner()) == 0
    assert (out / "jenny-team-bridge").is_file()
    assert run_main(tmp_path, FakeRunner(cargo_code=101)) == 1
    assert not (out / "jenny-team-bridge").exists()
    assert not (out / "jenny-team-bridge.manifest.json").exists()


def test_a_binary_left_in_target_is_not_shipped_when_cargo_writes_none(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    crate = make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner()) == 0
    assert (crate / "target" / "release" / "jenny-team-bridge").is_file()
    capsys.readouterr()
    silent = FakeRunner()
    silent.writes_binary = False
    assert run_main(tmp_path, silent) == 1
    assert "was not produced" in capsys.readouterr().err
    assert not (tmp_path / "build" / "sidecar" / "jenny-team-bridge").exists()


def test_failing_cargo_raises_with_a_bounded_tail_and_ships_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    make_crate(tmp_path)
    noise = "\n".join(f"line {i}" for i in range(500)) + "\n" + "x" * 20000 + "\nerror: boom\n"
    noisy = FakeRunner(cargo_code=101)
    noisy.cargo_stderr = noise
    assert run_main(tmp_path, noisy) == 1
    err = capsys.readouterr().err
    assert "cargo build failed with exit code 101" in err and "error: boom" in err
    assert "line 0\n" not in err and len(err) < 5000
    assert not (tmp_path / "build").exists()


def test_failing_cargo_surfaces_as_the_build_error_type(tmp_path: Path) -> None:
    crate = make_crate(tmp_path)
    with pytest.raises(btb.TeamBridgeBuildError, match="cargo build failed"):
        btb.build(tmp_path, "cargo-bin", FakeRunner(cargo_code=1), {}, platform="linux", machine="x86_64")
    assert crate.is_dir()


def test_missing_cargo_names_the_required_rust(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    runner = FakeRunner()
    assert run_main(tmp_path, runner, cargo=None) == 1
    err = capsys.readouterr().err
    assert "cargo was not found" in err and "Rust 1.91" in err
    assert runner.calls == [] and not (tmp_path / "build").exists()


def test_missing_crate_directory_is_an_error(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert run_main(tmp_path, FakeRunner()) == 1
    assert "jenny-team-bridge" in capsys.readouterr().err


def test_wrong_version_line_fails_the_build(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(version_line="jenny-team-bridge protocol 2\n")) == 1
    assert "protocol 2" in capsys.readouterr().err
    assert not (tmp_path / "build").exists()


def test_a_nonzero_version_exit_fails_the_build(tmp_path: Path) -> None:
    make_crate(tmp_path)

    class Failing(FakeRunner):
        def __call__(self, command, *, cwd, timeout_seconds):  # type: ignore[no-untyped-def]
            if command[-1] == "--version" and command[0].endswith("jenny-team-bridge"):
                return done(command, 3, VERSION_LINE)
            return super().__call__(command, cwd=cwd, timeout_seconds=timeout_seconds)

    assert run_main(tmp_path, Failing()) == 1
    assert not (tmp_path / "build").exists()


def test_empty_binary_is_rejected(tmp_path: Path) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(binary_bytes=b"")) == 1
    assert not (tmp_path / "build").exists()


def test_windows_requires_static_linking(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    dynamic = b"MZ" + b"\x00" * 64 + b"VCRUNTIME140.dll"
    assert run_main(tmp_path, FakeRunner(binary_bytes=dynamic, name="jenny-team-bridge.exe"),
                    platform="win32") == 1
    assert "not statically linked" in capsys.readouterr().err
    assert not (tmp_path / "build").exists()


def test_static_link_check_flags_vcruntime_in_any_case() -> None:
    btb.check_static_link(GOOD_BINARY)
    for needle in (b"VCRUNTIME140.dll", b"vcruntime140_1.dll"):
        with pytest.raises(btb.TeamBridgeBuildError, match="not statically linked"):
            btb.check_static_link(b"MZ" + needle + b"\x00")


def test_static_link_check_is_windows_only(tmp_path: Path) -> None:
    # A Linux or macOS binary may legitimately mention the string; it is not a Windows image.
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(binary_bytes=GOOD_BINARY + b"vcruntime"), platform="linux") == 0


@pytest.mark.skipif(sys.platform.startswith("win"), reason="POSIX mode bits")
@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_posix_binary_is_executable(tmp_path: Path, platform: str) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(), platform=platform) == 0
    mode = (tmp_path / "build" / "sidecar" / "jenny-team-bridge").stat().st_mode & 0o777
    assert mode == 0o755


def test_output_dir_option_redirects_the_binary_and_manifest(tmp_path: Path) -> None:
    make_crate(tmp_path)
    target = tmp_path / "elsewhere"
    assert run_main(tmp_path, FakeRunner(), ["--output-dir", str(target)]) == 0
    assert (target / "jenny-team-bridge").is_file()
    assert (target / "jenny-team-bridge.manifest.json").is_file()
    assert not (tmp_path / "build").exists()


def test_help_exits_zero_and_names_the_option(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as stop:
        btb.main(["--help"])
    assert stop.value.code == 0
    assert "--output-dir" in capsys.readouterr().out


def test_timeout_is_a_one_line_error(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)

    def hangs(command: list[str], *, cwd: Path, timeout_seconds: int) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(command, timeout_seconds)

    code = btb.main([], root=tmp_path, platform="linux", machine="x86_64", runner=hangs,
                    which=lambda name: "cargo-bin", env={})
    assert code == 1
    err = capsys.readouterr().err
    assert "timed out after 600 seconds" in err and err.count("\n") == 1

