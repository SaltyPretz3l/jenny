"""Backend selection for hosted file IO. Runs on every OS: no real descriptor IO."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from types import ModuleType

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools import hosted_file_io
from sidecar.ai.tools.contracts import ToolExecutionFailure

POSIX_BACKEND = "sidecar.ai.tools.hosted_file_io_posix"
WIN32_BACKEND = "sidecar.ai.tools.hosted_file_io_win32"
GENERIC_PATH_MESSAGE = (
    "Hosted file access requires a regular single-link file in the approved workspace."
)


@pytest.fixture(autouse=True)
def reset_host_io():
    hosted_file_io.configure_hosted_file_io(None, enabled=False)
    hosted_file_io.set_hosted_win32_files(False)
    yield
    hosted_file_io.configure_hosted_file_io(None, enabled=False)
    hosted_file_io.set_hosted_win32_files(False)


class FakePin:
    def __init__(self) -> None:
        self.closed = 0

    def close(self) -> None:
        self.closed += 1


class FakeBackend:
    """Records every call the facade makes through the backend contract."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.pins: list[FakePin] = []
        self.write_error: BaseException | None = None

    def open_root(self, root, expected_device, expected_inode):
        self.calls.append(("open_root", root, expected_device, expected_inode))
        pin = FakePin()
        self.pins.append(pin)
        return pin

    @contextmanager
    def open_file(self, pin, root, path, mode="rb", **kwargs):
        self.calls.append(("open_file", pin, root, path, mode, kwargs))
        yield "file-object"

    @contextmanager
    def open_directory(self, pin, root, path):
        self.calls.append(("open_directory", pin, root, path))
        yield "directory-object"

    def write_atomic(self, pin, root, path, content, expected, no_expectation, mode):  # noqa: PLR0913
        self.calls.append(("write_atomic", pin, root, path, content, expected, no_expectation, mode))
        if self.write_error is not None:
            raise self.write_error
        return True


@pytest.fixture
def fake_backend(monkeypatch) -> FakeBackend:
    """A backend on a POSIX host: the process-level configure pins the root there."""
    backend = FakeBackend()
    monkeypatch.setattr(hosted_file_io, "select_backend", lambda platform: backend)
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "linux")
    return backend


def _assert_generic_path_failure(failure: ToolExecutionFailure) -> None:
    assert failure.code == CMP_TOOL_INVALID_PATH
    assert failure.message == GENERIC_PATH_MESSAGE
    assert failure.retryable is False


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_posix_platforms_pick_the_posix_backend(platform: str) -> None:
    backend = hosted_file_io.select_backend(platform)

    assert isinstance(backend, ModuleType)
    assert backend.__name__ == POSIX_BACKEND
    for call in ("open_root", "open_file", "open_directory", "write_atomic"):
        assert callable(getattr(backend, call))


def test_win32_asks_for_the_windows_module_when_the_switch_is_on(monkeypatch) -> None:
    asked: list[str] = []
    stand_in = ModuleType(WIN32_BACKEND)

    def import_backend(name: str):
        asked.append(name)
        return stand_in

    monkeypatch.setattr(hosted_file_io, "hosted_win32_files_enabled", lambda: True)
    monkeypatch.setattr(hosted_file_io, "_import_backend", import_backend)

    assert hosted_file_io.select_backend("win32") is stand_in
    assert asked == [WIN32_BACKEND]


def test_win32_without_the_windows_module_fails_closed(monkeypatch) -> None:
    monkeypatch.setattr(hosted_file_io, "hosted_win32_files_enabled", lambda: True)
    monkeypatch.setattr(hosted_file_io, "_import_backend", lambda name: None)

    assert hosted_file_io.select_backend("win32") is None


def test_win32_with_the_switch_off_never_looks_for_the_windows_module(monkeypatch) -> None:
    asked: list[str] = []
    monkeypatch.setattr(hosted_file_io, "_import_backend", asked.append)

    assert hosted_file_io.hosted_win32_files_enabled() is False
    assert hosted_file_io.select_backend("win32") is None
    assert asked == []


@pytest.mark.parametrize("platform", ["cygwin", "freebsd14", "aix", "emscripten", "", "win32"])
def test_platforms_without_a_backend_fail_closed_at_both_entry_points(
    monkeypatch, tmp_path: Path, platform: str
) -> None:
    """Configure refuses; a scope enters hosted with no root, so a tool that
    touches no file runs and every file operation is the path failure (3b-4b)."""
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: platform)
    root = tmp_path.resolve()
    (root / "file.txt").write_bytes(b"x")

    with pytest.raises(ToolExecutionFailure) as configured:
        hosted_file_io.configure_hosted_file_io(str(root), enabled=True)
    _assert_generic_path_failure(configured.value)

    with hosted_file_io.scoped_hosted_file_io(
        str(root), enabled=True, expected_device_id="7", expected_inode="9"
    ):
        assert hosted_file_io.hosted_file_io_enabled() is True
        assert hosted_file_io.hosted_file_io_root() is None
        with pytest.raises(ToolExecutionFailure) as opened, hosted_file_io.open_regular_file(
            root / "file.txt"
        ):
            pytest.fail("a platform without a backend opened a file")
        with pytest.raises(ToolExecutionFailure) as written:
            hosted_file_io.write_hosted_bytes_atomic(
                root / "file.txt", b"y", expected=None, no_expectation=object(), mode=None)
    for failure in (opened.value, written.value):
        _assert_generic_path_failure(failure)
    assert (root / "file.txt").read_bytes() == b"x"


def test_a_present_backend_that_refuses_the_root_still_raises_at_scope_entry(
    fake_backend: FakeBackend, tmp_path: Path
) -> None:
    def refuse(root, device, inode):
        raise hosted_file_io.path_failure()

    fake_backend.open_root = refuse  # type: ignore[method-assign]
    with pytest.raises(ToolExecutionFailure), hosted_file_io.scoped_hosted_file_io(
        str(tmp_path.resolve()), enabled=True, expected_device_id="7", expected_inode="9"
    ):
        pytest.fail("a refused root was admitted")


def test_a_failed_configure_leaves_hosted_mode_on_with_no_root(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "plan9")
    with pytest.raises(ToolExecutionFailure):
        hosted_file_io.configure_hosted_file_io(str(tmp_path.resolve()), enabled=True)

    assert hosted_file_io.hosted_file_io_enabled() is True
    assert hosted_file_io.hosted_file_io_root() is None


def test_no_backend_is_needed_when_no_root_is_pinned(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "plan9")
    root = str(tmp_path.resolve())

    hosted_file_io.configure_hosted_file_io(None, enabled=True)
    hosted_file_io.configure_hosted_file_io(root, enabled=False)
    for workspace_root, enabled in ((None, True), (root, False), (None, False)):
        with hosted_file_io.scoped_hosted_file_io(workspace_root, enabled=enabled):
            assert hosted_file_io.hosted_file_io_enabled() is enabled
            assert hosted_file_io.hosted_file_io_root() is None


def test_configure_pins_the_root_without_an_identity_and_reconfigure_closes_it(
    fake_backend: FakeBackend, tmp_path: Path
) -> None:
    root = tmp_path.resolve()

    hosted_file_io.configure_hosted_file_io(str(root), enabled=True)

    assert fake_backend.calls == [("open_root", root, None, None)]
    assert hosted_file_io.hosted_file_io_root() == str(root)
    first = fake_backend.pins[0]
    hosted_file_io.configure_hosted_file_io(None, enabled=False)
    assert first.closed == 1
    assert hosted_file_io.hosted_file_io_root() is None


def test_scope_passes_the_expected_identity_and_closes_its_pin_on_exit(
    fake_backend: FakeBackend, tmp_path: Path
) -> None:
    root = tmp_path.resolve()

    with hosted_file_io.scoped_hosted_file_io(
        str(root), enabled=True, expected_device_id="7", expected_inode="9"
    ):
        assert fake_backend.calls == [("open_root", root, "7", "9")]
        assert hosted_file_io.hosted_file_io_root() == str(root)
        assert fake_backend.pins[0].closed == 0
    assert fake_backend.pins[0].closed == 1
    assert hosted_file_io.hosted_file_io_root() is None


def test_scope_closes_its_pin_when_the_body_raises(fake_backend: FakeBackend, tmp_path: Path) -> None:
    with pytest.raises(RuntimeError), hosted_file_io.scoped_hosted_file_io(
        str(tmp_path.resolve()), enabled=True
    ):
        raise RuntimeError("tool failed")

    assert fake_backend.pins[0].closed == 1


def test_operations_delegate_to_the_backend_with_the_active_pin(
    fake_backend: FakeBackend, tmp_path: Path
) -> None:
    root = tmp_path.resolve()
    target = root / "dir" / "file.txt"
    sentinel = object()
    hosted_file_io.configure_hosted_file_io(str(root), enabled=True)
    pin = fake_backend.pins[0]

    with hosted_file_io.open_regular_file(target, "r", encoding="utf-8") as handle:
        assert handle == "file-object"
    with hosted_file_io.open_hosted_directory(root / "dir") as directory:
        assert directory == "directory-object"
    wrote = hosted_file_io.write_hosted_bytes_atomic(
        target, b"new", expected=b"old", no_expectation=sentinel, mode=0o600
    )

    assert wrote is True
    assert fake_backend.calls[1:] == [
        ("open_file", pin, root, target, "r", {"encoding": "utf-8"}),
        ("open_directory", pin, root, root / "dir"),
        ("write_atomic", pin, root, target, b"new", b"old", sentinel, 0o600),
    ]


def test_hosted_open_refuses_write_modes_before_the_backend(
    fake_backend: FakeBackend, tmp_path: Path
) -> None:
    hosted_file_io.configure_hosted_file_io(str(tmp_path.resolve()), enabled=True)
    fake_backend.calls.clear()

    with pytest.raises(ToolExecutionFailure) as caught, hosted_file_io.open_regular_file(
        tmp_path / "file.txt", "w"
    ):
        pytest.fail("a write mode was admitted")
    _assert_generic_path_failure(caught.value)
    assert fake_backend.calls == []


def test_unpinned_hosted_operations_fail_closed_without_the_backend(
    fake_backend: FakeBackend, tmp_path: Path
) -> None:
    hosted_file_io.configure_hosted_file_io(None, enabled=True)
    target = tmp_path / "file.txt"

    with pytest.raises(ToolExecutionFailure) as opened, hosted_file_io.open_regular_file(target):
        pytest.fail("opened without a pinned root")
    with pytest.raises(ToolExecutionFailure) as listed, hosted_file_io.open_hosted_directory(tmp_path):
        pytest.fail("listed without a pinned root")
    with pytest.raises(ToolExecutionFailure) as written:
        hosted_file_io.write_hosted_bytes_atomic(
            target, b"x", expected=None, no_expectation=object(), mode=None
        )

    for failure in (opened.value, listed.value, written.value):
        _assert_generic_path_failure(failure)
    assert fake_backend.calls == []


def test_a_backend_os_error_on_write_becomes_a_retryable_io_failure(
    fake_backend: FakeBackend, tmp_path: Path
) -> None:
    hosted_file_io.configure_hosted_file_io(str(tmp_path.resolve()), enabled=True)
    fake_backend.write_error = OSError(5, "injected")

    with pytest.raises(ToolExecutionFailure) as caught:
        hosted_file_io.write_hosted_bytes_atomic(
            tmp_path / "file.txt", b"x", expected=None, no_expectation=object(), mode=None
        )

    assert caught.value.code == CMP_TOOL_IO_FAILED
    assert caught.value.message == "Hosted file IO failed before replacement."
    assert caught.value.retryable is True
    assert caught.value.effects == "none"


def test_a_backend_tool_failure_on_write_passes_through_unchanged(
    fake_backend: FakeBackend, tmp_path: Path
) -> None:
    hosted_file_io.configure_hosted_file_io(str(tmp_path.resolve()), enabled=True)
    uncertain = ToolExecutionFailure(
        code=CMP_TOOL_IO_FAILED,
        message="durability uncertain",
        retryable=False,
        error_details={"effects": "applied_durability_uncertain"},
    )
    fake_backend.write_error = uncertain

    with pytest.raises(ToolExecutionFailure) as caught:
        hosted_file_io.write_hosted_bytes_atomic(
            tmp_path / "file.txt", b"x", expected=None, no_expectation=object(), mode=None
        )

    assert caught.value is uncertain


def test_the_backend_is_chosen_once_where_the_pin_is_made(monkeypatch, tmp_path: Path) -> None:
    backend = FakeBackend()
    selections: list[str] = []

    def select(platform: str):
        selections.append(platform)
        return backend

    monkeypatch.setattr(hosted_file_io, "select_backend", select)
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "linux")
    root = tmp_path.resolve()
    target = root / "file.txt"

    hosted_file_io.configure_hosted_file_io(str(root), enabled=True)
    for _ in range(3):
        with hosted_file_io.open_regular_file(target):
            pass
        with hosted_file_io.open_hosted_directory(root):
            pass
        hosted_file_io.write_hosted_bytes_atomic(
            target, b"x", expected=None, no_expectation=object(), mode=None
        )
    assert len(selections) == 1

    with hosted_file_io.scoped_hosted_file_io(str(root), enabled=True):
        for _ in range(3):
            with hosted_file_io.open_regular_file(target):
                pass
    assert len(selections) == 2


def test_win32_configure_checks_the_backend_and_pins_nothing(
    fake_backend: FakeBackend, monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "win32")
    root = tmp_path.resolve()

    hosted_file_io.configure_hosted_file_io(str(root), enabled=True)

    assert fake_backend.calls == [], "no identity reaches the process level, so no pin"
    assert hosted_file_io.hosted_file_io_root() == str(root)
    with pytest.raises(ToolExecutionFailure) as outside, hosted_file_io.open_regular_file(root / "a"):
        pytest.fail("an operation outside a request scope was admitted")
    _assert_generic_path_failure(outside.value)
    assert hosted_file_io.hosted_file_io_identity() == (None, None)
    with hosted_file_io.scoped_hosted_file_io(
        str(root), enabled=True, expected_device_id="7", expected_inode="9"
    ):
        assert hosted_file_io.hosted_file_io_identity() == ("7", "9")
        with hosted_file_io.open_regular_file(root / "a"):
            pass
    assert fake_backend.calls[0] == ("open_root", root, "7", "9")


def test_win32_configure_without_a_backend_fails_closed(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "win32")
    with pytest.raises(ToolExecutionFailure) as configured:
        hosted_file_io.configure_hosted_file_io(str(tmp_path.resolve()), enabled=True)
    _assert_generic_path_failure(configured.value)


def test_the_switch_is_a_process_setting_off_by_default(monkeypatch) -> None:
    asked: list[str] = []
    monkeypatch.setattr(hosted_file_io, "_import_backend", asked.append)

    assert hosted_file_io.hosted_win32_files_enabled() is False
    hosted_file_io.set_hosted_win32_files(True)
    try:
        assert hosted_file_io.hosted_win32_files_enabled() is True
        assert hosted_file_io.select_backend("win32") is None
        assert asked == [WIN32_BACKEND]
    finally:
        hosted_file_io.set_hosted_win32_files(False)
    assert hosted_file_io.hosted_win32_files_enabled() is False
