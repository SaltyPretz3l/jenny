"""Behaviour tests for scripts/packaging/build_file_access.py (no cargo, no DLL needed)."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "packaging"))

import build_file_access as bfa  # noqa: E402

LOCK_TEXT = """version = 4

[[package]]
name = "zeta"
version = "1.0.0"

[[package]]
name = "alpha"
version = "2.0.0"
"""
CARGO_TOML = '[package]\nname = "jenny-file-access"\nversion = "0.1.0"\nedition = "2021"\n'
GOOD_DLL = b"MZ" + b"\x00" * 64 + b"static runtime only"
ENV = {"SOURCE_DATE_EPOCH": "1700000000", "SECRET_FOR_TEST": "hunter2-do-not-print"}


def make_crate(root: Path) -> Path:
    crate = root / "native" / "jenny-file-access"
    crate.mkdir(parents=True)
    (crate / "Cargo.toml").write_text(CARGO_TOML, encoding="utf-8")
    (crate / "Cargo.lock").write_text(LOCK_TEXT, encoding="utf-8")
    return crate


def done(command: list[str], code: int = 0, out: str = "", err: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(command, code, out, err)


class FakeRunner:
    """Stands in for cargo, rustc and git. `before_build` runs when cargo is called."""

    def __init__(self, dll_bytes: bytes = GOOD_DLL, cargo_code: int = 0, writes_dll: bool = True,
                 before_build=None) -> None:
        self.dll_bytes, self.cargo_code, self.writes_dll = dll_bytes, cargo_code, writes_dll
        self.before_build = before_build
        self.calls: list[tuple[list[str], Path, int]] = []

    def __call__(self, command: list[str], *, cwd: Path, timeout_seconds: int) -> subprocess.CompletedProcess[str]:
        self.calls.append((command, cwd, timeout_seconds))
        if command[1:3] == ["build", "--release"]:
            if self.before_build is not None:
                self.before_build()
            if self.cargo_code == 0 and self.writes_dll:
                dll = cwd / "target" / "release" / bfa.LIBRARY_NAME
                dll.parent.mkdir(parents=True, exist_ok=True)
                dll.write_bytes(self.dll_bytes)
            return done(command, self.cargo_code, "", "error: boom\n")
        if command[0] == "C:/cargo.exe" and command[1:] == ["--version"]:
            return done(command, 0, "cargo 1.99.1\n")
        if command[0] == "rustc":
            return done(command, 0, "rustc 1.99.1\n")
        if command[:2] == ["git", "rev-parse"]:
            return done(command, 0, "abc123\n")
        if command[:2] == ["git", "status"]:
            return done(command, 0, " M file\n")
        raise AssertionError(f"unexpected command {command}")


class FakeInspector:
    """Stands in for loading the library: reports what a real one would."""

    def __init__(self, abi_version: int = 1, build_flags: int = 0, exports_seam: bool = False,
                 error: Exception | None = None) -> None:
        self.facts = bfa.LibraryFacts(abi_version, build_flags, exports_seam)
        self.error = error
        self.paths: list[Path] = []

    def __call__(self, path: Path) -> bfa.LibraryFacts:
        self.paths.append(path)
        if self.error is not None:
            raise self.error
        return self.facts


def run_main(  # noqa: PLR0913 - mirrors the injected seams of bfa.main.
             root: Path, runner: FakeRunner, inspector: FakeInspector | None = None,
             argv: list[str] | None = None, platform: str = "win32", cargo: str | None = "C:/cargo.exe",
             env: dict[str, str] | None = None) -> int:
    return bfa.main(argv or [], root=root, platform=platform, runner=runner,
                    which=lambda name: cargo, env=ENV if env is None else env,
                    inspector=inspector or FakeInspector())


def shipped(root: Path) -> list[str]:
    out = root / "build" / "sidecar"
    return sorted(item.name for item in out.iterdir()) if out.exists() else []


def test_non_windows_skips_and_writes_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    runner, inspector = FakeRunner(), FakeInspector()
    assert run_main(tmp_path, runner, inspector, platform="linux") == 0
    assert "file access: skipped (Windows only)" in capsys.readouterr().out
    assert runner.calls == [] and inspector.paths == []
    assert list(tmp_path.iterdir()) == []


def test_missing_cargo_skips_only_with_flag(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    runner = FakeRunner()
    assert run_main(tmp_path, runner, argv=["--allow-missing-toolchain"], cargo=None) == 0
    assert "file access: skipped (cargo not found)" in capsys.readouterr().out
    assert run_main(tmp_path, runner, cargo=None) == 1
    assert "cargo" in capsys.readouterr().err
    assert runner.calls == [] and not (tmp_path / "build").exists()


def test_missing_cargo_with_flag_still_removes_an_old_library(tmp_path: Path) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner()) == 0
    assert run_main(tmp_path, FakeRunner(), argv=["--allow-missing-toolchain"], cargo=None) == 0
    assert shipped(tmp_path) == []


def test_missing_crate_directory_is_an_error(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert run_main(tmp_path, FakeRunner()) == 1
    assert "jenny-file-access" in capsys.readouterr().err


def test_every_windows_failure_that_precedes_the_build_removes_an_older_library(tmp_path: Path) -> None:
    crate = make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner()) == 0
    assert shipped(tmp_path) == [bfa.LIBRARY_NAME, bfa.MANIFEST_NAME]
    # (a) cargo missing and not allowed to be
    assert run_main(tmp_path, FakeRunner(), cargo=None) == 1
    assert shipped(tmp_path) == []
    assert run_main(tmp_path, FakeRunner()) == 0
    assert shipped(tmp_path) == [bfa.LIBRARY_NAME, bfa.MANIFEST_NAME]
    # (b) the crate directory is gone
    shutil.rmtree(crate)
    assert run_main(tmp_path, FakeRunner()) == 1
    assert shipped(tmp_path) == []


def test_failing_cargo_run_prints_tail_and_writes_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(cargo_code=101)) == 1
    assert "error: boom" in capsys.readouterr().err
    assert shipped(tmp_path) == []


def test_cargo_runs_release_locked_in_the_crate_directory_without_features(tmp_path: Path) -> None:
    crate = make_crate(tmp_path)
    runner = FakeRunner()
    assert run_main(tmp_path, runner) == 0
    command, cwd, timeout = runner.calls[0]
    assert command == ["C:/cargo.exe", "build", "--release", "--locked"]
    assert cwd == crate and timeout == 600
    assert not any("feature" in part or "seams" in part for call, _, _ in runner.calls for part in call)


def test_empty_or_missing_library_is_rejected(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(dll_bytes=b"")) == 1
    assert "not produced or is empty" in capsys.readouterr().err
    assert run_main(tmp_path, FakeRunner(writes_dll=False)) == 1
    assert shipped(tmp_path) == []


def test_vcruntime_import_fails_the_build(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(dll_bytes=GOOD_DLL + b"VCRUNTIME140.dll")) == 1
    assert "not statically linked" in capsys.readouterr().err
    assert shipped(tmp_path) == []


@pytest.mark.parametrize(
    ("inspector", "message"),
    [
        (FakeInspector(abi_version=2), "ABI version 2"),
        (FakeInspector(abi_version=0), "ABI version 0"),
        (FakeInspector(build_flags=1), "build flags 1"),
        (FakeInspector(build_flags=3), "build flags 3"),
        (FakeInspector(exports_seam=True), "jfa_test_set_token_state"),
        (FakeInspector(error=OSError("cannot load")), "cannot load"),
    ],
)
def test_a_refused_library_fails_the_build_and_leaves_nothing_shipped(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], inspector: FakeInspector, message: str
) -> None:
    make_crate(tmp_path)
    out = tmp_path / "build" / "sidecar"
    assert run_main(tmp_path, FakeRunner()) == 0
    assert (out / bfa.LIBRARY_NAME).is_file()
    capsys.readouterr()
    assert run_main(tmp_path, FakeRunner(), inspector) == 1
    assert message in capsys.readouterr().err
    assert shipped(tmp_path) == []


def test_the_library_that_is_checked_is_the_one_cargo_built_and_not_the_shipped_copy(tmp_path: Path) -> None:
    crate = make_crate(tmp_path)
    inspector = FakeInspector()
    assert run_main(tmp_path, FakeRunner(), inspector) == 0
    assert inspector.paths == [crate / "target" / "release" / bfa.LIBRARY_NAME]


def test_the_previous_output_is_deleted_before_the_build_starts(tmp_path: Path) -> None:
    make_crate(tmp_path)
    out = tmp_path / "build" / "sidecar"
    assert run_main(tmp_path, FakeRunner()) == 0
    seen: dict[str, bool] = {}

    def before_build() -> None:
        seen["library"] = (out / bfa.LIBRARY_NAME).exists()
        seen["manifest"] = (out / bfa.MANIFEST_NAME).exists()
        seen["target"] = (tmp_path / "native" / "jenny-file-access" / "target" / "release" / bfa.LIBRARY_NAME).exists()

    assert run_main(tmp_path, FakeRunner(before_build=before_build)) == 0
    assert seen == {"library": False, "manifest": False, "target": False}


def test_a_library_left_in_target_by_an_earlier_run_is_not_shipped_when_cargo_writes_none(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner()) == 0
    capsys.readouterr()
    assert run_main(tmp_path, FakeRunner(writes_dll=False)) == 1
    assert "not produced" in capsys.readouterr().err
    assert shipped(tmp_path) == []


def test_lock_parsing_keeps_names_sorted() -> None:
    assert bfa.parse_lock_crates(LOCK_TEXT) == [
        {"name": "alpha", "version": "2.0.0"},
        {"name": "zeta", "version": "1.0.0"},
    ]


def test_successful_build_copies_and_writes_the_manifest(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)
    out = tmp_path / "build" / "sidecar"
    out.mkdir(parents=True)
    (out / "sidecar.exe").write_bytes(b"sidecar")
    (out / "jenny-launch.manifest.json").write_text("{}", encoding="utf-8")
    assert run_main(tmp_path, FakeRunner()) == 0
    assert (out / bfa.LIBRARY_NAME).read_bytes() == GOOD_DLL
    assert (out / "sidecar.exe").read_bytes() == b"sidecar"
    assert (out / "jenny-launch.manifest.json").read_text(encoding="utf-8") == "{}"
    text = (out / bfa.MANIFEST_NAME).read_text(encoding="utf-8")
    assert text.endswith("}\n") and "\r" not in text
    manifest = json.loads(text)
    assert list(manifest) == sorted(manifest)
    assert set(manifest) == {"name", "abi_version", "build_flags", "sha256", "size_bytes", "crate_version",
                             "rustc_version", "cargo_version", "git_commit", "git_dirty", "build_timestamp",
                             "crates"}
    assert manifest["name"] == "jenny_file_access.dll"
    assert manifest["abi_version"] == 1 and manifest["build_flags"] == 0
    assert manifest["sha256"] == hashlib.sha256((out / bfa.LIBRARY_NAME).read_bytes()).hexdigest()
    assert manifest["size_bytes"] == len(GOOD_DLL)
    assert manifest["crate_version"] == "0.1.0" and manifest["git_dirty"] is True
    assert manifest["build_timestamp"] == "2023-11-14T22:13:20Z"
    assert manifest["crates"] == [{"name": "alpha", "version": "2.0.0"}, {"name": "zeta", "version": "1.0.0"}]
    printed = capsys.readouterr().out
    assert manifest["sha256"] in printed and "build/sidecar/jenny_file_access.dll" in printed


def test_manifest_and_output_carry_no_path_user_or_environment_value(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner()) == 0
    text = (tmp_path / "build" / "sidecar" / bfa.MANIFEST_NAME).read_text(encoding="utf-8")
    seen = text + capsys.readouterr().out
    for private in (str(tmp_path), tmp_path.as_posix(), "hunter2-do-not-print"):
        assert private not in seen
    # The refusal path prints to stderr: the environment value must not reach it either.
    assert run_main(tmp_path, FakeRunner(), FakeInspector(build_flags=1)) == 1
    captured = capsys.readouterr()
    assert "hunter2-do-not-print" not in captured.out + captured.err
    assert str(tmp_path) not in captured.out + captured.err


def test_the_build_reads_only_the_timestamp_variable_from_the_environment(tmp_path: Path) -> None:
    make_crate(tmp_path)
    assert run_main(tmp_path, FakeRunner(), env={}) == 0
    manifest = json.loads((tmp_path / "build" / "sidecar" / bfa.MANIFEST_NAME).read_text(encoding="utf-8"))
    assert manifest["build_timestamp"].endswith("Z")


def test_dirty_flag_looks_only_at_the_crate(tmp_path: Path) -> None:
    make_crate(tmp_path)
    runner = FakeRunner()
    assert run_main(tmp_path, runner) == 0
    status = [command for command, _, _ in runner.calls if command[:2] == ["git", "status"]]
    assert status == [["git", "status", "--porcelain", "--", "native/jenny-file-access"]]


def test_a_timeout_is_reported_without_the_command_line(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    make_crate(tmp_path)

    def hang(command: list[str], *, cwd: Path, timeout_seconds: int) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(command, timeout_seconds)

    code = bfa.main([], root=tmp_path, platform="win32", runner=hang, which=lambda name: "C:/cargo.exe",
                    env=ENV, inspector=FakeInspector())
    assert code == 1
    err = capsys.readouterr().err
    assert "timed out after 600 seconds" in err
    assert "C:/cargo.exe" not in err and "cargo.exe" not in err
    assert shipped(tmp_path) == []


class FakeFunction:
    def __init__(self, value: int) -> None:
        self.value = value
        self.argtypes: object = None
        self.restype: object = None

    def __call__(self) -> int:
        return self.value


def stand_in_library(*, abi: int | None = 1, flags: int | None = 0, seam: bool = False) -> type:
    """A class standing in for ctypes.WinDLL: attributes exist only for the exports it 'has'."""

    class Library:
        _handle = 4242

        def __init__(self, path: str) -> None:
            self.path = path
            if abi is not None:
                self.jfa_abi_version = FakeFunction(abi)
            if flags is not None:
                self.jfa_build_flags = FakeFunction(flags)
            if seam:
                setattr(self, bfa.SEAM_SYMBOL, FakeFunction(0))

    return Library


@pytest.fixture
def unloads(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    import _ctypes

    freed: list[int] = []
    monkeypatch.setattr(_ctypes, "FreeLibrary", freed.append, raising=False)
    return freed


def use_library(monkeypatch: pytest.MonkeyPatch, library: type) -> None:
    import ctypes

    monkeypatch.setattr(ctypes, "WinDLL", library, raising=False)


def test_inspect_library_reads_the_two_numbers_and_the_seam_and_unloads(
    monkeypatch: pytest.MonkeyPatch, unloads: list[int]
) -> None:
    use_library(monkeypatch, stand_in_library(abi=1, flags=0, seam=False))
    assert bfa.inspect_library(Path("x.dll")) == bfa.LibraryFacts(1, 0, False)
    use_library(monkeypatch, stand_in_library(abi=2, flags=1, seam=True))
    assert bfa.inspect_library(Path("x.dll")) == bfa.LibraryFacts(2, 1, True)
    assert unloads == [4242, 4242]


@pytest.mark.parametrize(("abi", "flags", "missing"), [(None, 0, "jfa_abi_version"), (1, None, "jfa_build_flags")])
def test_inspect_library_names_a_missing_export_and_still_unloads(
    monkeypatch: pytest.MonkeyPatch, unloads: list[int], abi: int | None, flags: int | None, missing: str
) -> None:
    use_library(monkeypatch, stand_in_library(abi=abi, flags=flags))
    with pytest.raises(bfa.FileAccessBuildError) as caught:
        bfa.inspect_library(Path("x.dll"))
    assert missing in str(caught.value) and "x.dll" not in str(caught.value)
    assert unloads == [4242]


def test_a_library_without_the_version_exports_is_refused_with_a_message(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, unloads: list[int]
) -> None:
    make_crate(tmp_path)
    use_library(monkeypatch, stand_in_library(abi=None))
    code = bfa.main([], root=tmp_path, platform="win32", runner=FakeRunner(), which=lambda name: "C:/cargo.exe",
                    env=ENV)
    assert code == 1
    assert "jfa_abi_version" in capsys.readouterr().err
    assert shipped(tmp_path) == [] and unloads == [4242]


def test_names_agree_with_the_crate_and_the_abi_file() -> None:
    abi = json.loads((ROOT / bfa.CRATE_RELATIVE / "abi.json").read_text(encoding="utf-8"))
    assert bfa.ABI_VERSION == abi["abi_version"]
    exports = {item["name"] for item in abi["exports"]}
    assert {"jfa_abi_version", "jfa_build_flags"} <= exports
    seam_only = {item["name"] for item in abi["exports"] if item.get("test_seams_only")}
    assert seam_only == {bfa.SEAM_SYMBOL}
    cargo = (ROOT / bfa.CRATE_RELATIVE / "Cargo.toml").read_text(encoding="utf-8")
    assert f'name = "{bfa.LIBRARY_NAME.removesuffix(".dll")}"' in cargo
