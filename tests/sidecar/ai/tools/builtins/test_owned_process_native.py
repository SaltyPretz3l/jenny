"""Behaviour of the native launcher resolver and its wiring into the Windows bootstrap command."""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from sidecar._owned_process_bootstrap import BOOTSTRAP_FLAG
from sidecar._owned_process_bootstrap import windows_bootstrap_command as python_bootstrap_command
from sidecar.ai.tools.builtins import owned_process_native as native
from sidecar.ai.tools.builtins import owned_process_windows as windows

VERSION_LINE = "jenny-launch protocol 1"


class FakeProbe:
    """Stand-in for `subprocess.run` that records every probe and plays one scripted outcome."""

    def __init__(
        self,
        *,
        stdout: str = VERSION_LINE + "\r\n",
        returncode: int = 0,
        raises: BaseException | None = None,
    ) -> None:
        self.stdout = stdout
        self.returncode = returncode
        self.raises = raises
        self.calls: list[tuple[list[str], dict[str, Any]]] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append((argv, kwargs))
        if self.raises is not None:
            raise self.raises
        return subprocess.CompletedProcess(argv, self.returncode, self.stdout, "")


@pytest.fixture
def launcher(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A fake launcher file on a pretend Windows host with the flag unset and a passing probe."""
    path = tmp_path / native.NATIVE_LAUNCHER_FILE_NAME
    path.write_bytes(b"MZ-fake-launcher")
    native.reset_native_launcher_state()
    monkeypatch.setattr(native.sys, "platform", "win32")
    monkeypatch.delenv(native.NATIVE_LAUNCHER_FLAG, raising=False)
    monkeypatch.setattr(native, "native_launcher_path", lambda: path)
    monkeypatch.setattr(native.subprocess, "run", FakeProbe())
    yield path
    native.reset_native_launcher_state()


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    recorded: list[dict[str, Any]] = []

    def record(_logger: object, _level: int, **fields: Any) -> None:
        recorded.append(fields)

    monkeypatch.setattr(native, "log_event", record)
    return recorded


def _probe(monkeypatch: pytest.MonkeyPatch, **kwargs: Any) -> FakeProbe:
    fake = FakeProbe(**kwargs)
    monkeypatch.setattr(native.subprocess, "run", fake)
    return fake


def test_not_windows_gives_none(launcher: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _probe(monkeypatch)
    monkeypatch.setattr(native.sys, "platform", "linux")
    assert native.native_launcher_command() is None
    assert fake.calls == []


def test_flag_zero_gives_none_and_unset_or_one_proceeds(
    launcher: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(native.NATIVE_LAUNCHER_FLAG, "0")
    assert native.native_launcher_command() is None
    monkeypatch.delenv(native.NATIVE_LAUNCHER_FLAG)
    assert native.native_launcher_command() == [str(launcher), BOOTSTRAP_FLAG]
    monkeypatch.setenv(native.NATIVE_LAUNCHER_FLAG, "1")
    assert native.native_launcher_command() == [str(launcher), BOOTSTRAP_FLAG]


def test_flag_is_read_on_every_call(launcher: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert native.native_launcher_command() is not None
    monkeypatch.setenv(native.NATIVE_LAUNCHER_FLAG, "0")
    assert native.native_launcher_command() is None
    monkeypatch.setenv(native.NATIVE_LAUNCHER_FLAG, "1")
    assert native.native_launcher_command() is not None


def test_missing_file_gives_none(
    launcher: Path, monkeypatch: pytest.MonkeyPatch, events: list[dict[str, Any]]
) -> None:
    fake = _probe(monkeypatch)
    launcher.unlink()
    assert native.native_launcher_command() is None
    assert fake.calls == []
    assert [e["data"]["reason"] for e in events] == ["missing"]


def test_file_removed_after_acceptance_is_rejected(
    launcher: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert native.native_launcher_command() is not None
    launcher.unlink()
    assert native.native_launcher_command() is None


def test_passing_probe_gives_the_bootstrap_command(
    launcher: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = _probe(monkeypatch)
    assert native.native_launcher_command() == [str(launcher), "--owned-process-bootstrap"]
    argv, kwargs = fake.calls[0]
    assert argv == [str(launcher), "--version"]
    assert kwargs["stdin"] == subprocess.DEVNULL
    assert kwargs["timeout"] == 5
    assert kwargs["capture_output"] is True
    assert kwargs["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0)


def test_three_calls_probe_once(launcher: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _probe(monkeypatch)
    for _ in range(3):
        assert native.native_launcher_command() is not None
    assert len(fake.calls) == 1


def test_changed_size_or_mtime_probes_again(
    launcher: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = _probe(monkeypatch)
    assert native.native_launcher_command() is not None
    stat = launcher.stat()
    launcher.write_bytes(b"MZ-fake-launcher-rebuilt")
    assert native.native_launcher_command() is not None
    assert len(fake.calls) == 2
    after_size = launcher.stat()
    import os

    os.utime(launcher, ns=(after_size.st_atime_ns, stat.st_mtime_ns + 10_000_000_000))
    assert native.native_launcher_command() is not None
    assert len(fake.calls) == 3


@pytest.mark.parametrize(
    "outcome",
    [
        {"raises": OSError("cannot start")},
        {"raises": subprocess.TimeoutExpired(cmd="jenny-launch", timeout=5)},
        {"returncode": 1},
        {"stdout": "jenny-launch protocol 2\n"},
    ],
    ids=["oserror", "timeout", "exit-1", "wrong-line"],
)
def test_each_probe_failure_mode_gives_none(
    launcher: Path, monkeypatch: pytest.MonkeyPatch, outcome: dict[str, Any]
) -> None:
    _probe(monkeypatch, **outcome)
    assert native.native_launcher_command() is None


def test_probe_failure_is_cached_until_the_file_changes(
    launcher: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = _probe(monkeypatch, returncode=1)
    assert native.native_launcher_command() is None
    assert native.native_launcher_command() is None
    assert len(fake.calls) == 1
    launcher.write_bytes(b"MZ-fixed-and-longer-than-before")
    good = _probe(monkeypatch)
    assert native.native_launcher_command() == [str(launcher), BOOTSTRAP_FLAG]
    assert len(good.calls) == 1


def test_failed_probe_is_retried_once_after_a_wait_then_stands(
    launcher: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(native.time, "monotonic", lambda: clock[0])
    slow = _probe(monkeypatch, raises=subprocess.TimeoutExpired(cmd="jenny-launch", timeout=5))
    assert native.native_launcher_command() is None
    clock[0] += 29.0
    assert native.native_launcher_command() is None
    assert len(slow.calls) == 1
    clock[0] += 2.0
    assert native.native_launcher_command() is None
    assert len(slow.calls) == 2
    clock[0] += 3600.0
    assert native.native_launcher_command() is None
    assert len(slow.calls) == 2


def test_retry_after_one_failed_probe_can_accept_the_launcher(
    launcher: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(native.time, "monotonic", lambda: clock[0])
    _probe(monkeypatch, raises=subprocess.TimeoutExpired(cmd="jenny-launch", timeout=5))
    assert native.native_launcher_command() is None
    good = _probe(monkeypatch)
    clock[0] += 31.0
    assert native.native_launcher_command() == [str(launcher), BOOTSTRAP_FLAG]
    assert native.native_launcher_command() == [str(launcher), BOOTSTRAP_FLAG]
    assert len(good.calls) == 1


def test_a_link_at_the_launcher_path_is_refused_without_a_probe(
    launcher: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = tmp_path / "elsewhere.exe"
    launcher.rename(real)
    try:
        launcher.symlink_to(real)
    except OSError:
        pytest.skip("this account cannot create symbolic links")
    fake = _probe(monkeypatch)
    assert native.native_launcher_command() is None
    assert fake.calls == []


def test_rejected_launcher_logs_one_diagnostic_across_three_calls(
    launcher: Path, monkeypatch: pytest.MonkeyPatch, events: list[dict[str, Any]]
) -> None:
    _probe(monkeypatch, returncode=1)
    for _ in range(3):
        assert native.native_launcher_command() is None
    assert len(events) == 1
    event = events[0]
    assert event["event"] == "ai.tools.owned_process.native_launcher_unavailable"
    assert event["status"] == "fallback"
    assert event["data"]["reason"] == "probe_failed"
    assert native.NATIVE_LAUNCHER_FILE_NAME in event["data"].values()
    assert str(launcher.parent) not in repr(event)


def test_disabled_logs_once_and_accepted_logs_ready_once(
    launcher: Path, monkeypatch: pytest.MonkeyPatch, events: list[dict[str, Any]]
) -> None:
    monkeypatch.setenv(native.NATIVE_LAUNCHER_FLAG, "0")
    for _ in range(3):
        assert native.native_launcher_command() is None
    monkeypatch.delenv(native.NATIVE_LAUNCHER_FLAG)
    for _ in range(3):
        assert native.native_launcher_command() is not None
    assert [e["event"] for e in events] == [
        "ai.tools.owned_process.native_launcher_unavailable",
        "ai.tools.owned_process.native_launcher_ready",
    ]
    assert events[0]["data"]["reason"] == "disabled"
    assert str(launcher.parent) not in repr(events)


def test_exception_inside_resolution_gives_none(
    launcher: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom() -> Path:
        raise RuntimeError("resolution exploded")

    monkeypatch.setattr(native, "native_launcher_path", boom)
    assert native.native_launcher_command() is None


def test_wrapper_returns_the_native_command_when_available(
    launcher: Path,
) -> None:
    assert windows.windows_bootstrap_command() == [str(launcher), BOOTSTRAP_FLAG]


def test_wrapper_returns_the_exact_python_command_otherwise(
    launcher: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(native.NATIVE_LAUNCHER_FLAG, "0")
    assert windows.windows_bootstrap_command() == python_bootstrap_command()
    monkeypatch.delenv(native.NATIVE_LAUNCHER_FLAG)
    _probe(monkeypatch, returncode=3)
    assert windows.windows_bootstrap_command() == python_bootstrap_command()


def test_wrapper_keeps_the_public_names() -> None:
    assert "windows_bootstrap_command" in windows.__all__
    assert windows.windows_bootstrap_command is not python_bootstrap_command


def test_packaged_path_sits_beside_the_executable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    exe = tmp_path / "resources" / "sidecar" / "sidecar.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))
    assert native.native_launcher_path() == exe.resolve().parent / "jenny-launch.exe"


def test_source_path_is_under_the_repository_build_directory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    path = native.native_launcher_path()
    assert path.name == "jenny-launch.exe"
    assert path.parent.parts[-2:] == ("build", "sidecar")
    assert (path.parents[2] / "sidecar" / "_owned_process_bootstrap.py").is_file()
