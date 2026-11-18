"""The Windows file access client against a fake library. Runs on every OS."""

from __future__ import annotations

import ctypes
import errno
import gc
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

import sidecar.ai.tools as tools_package
from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools import hosted_file_io
from sidecar.ai.tools import hosted_file_io_win32 as client
from sidecar.ai.tools import hosted_file_io_win32_library as win32_library
from sidecar.ai.tools.builtins.filesystem_listing import format_list_entry
from sidecar.ai.tools.contracts import ToolExecutionFailure
from tests.sidecar._hosted_file_io_win32_fake import (
    FAKE_HANDLE,
    FakeLibrary,
    record,
    regular_file_stat,
)

ROOT = Path(__file__).resolve().parents[2]
ABI = json.loads((ROOT / "native" / "jenny-file-access" / "abi.json").read_text(encoding="utf-8"))
GENERIC_PATH_MESSAGE = (
    "Hosted file access requires a regular single-link file in the approved workspace."
)
NO_EXPECTATION = object()
SELFCHECK = "file_access_selfcheck_failed"

PATH_FAILURE = "path_failure"
# One row per status in abi.json: what a write answers, and what a start answers.
STATUS_TABLE = {
    "ok": ("value", None),
    "path_refused": (PATH_FAILURE, "file_access_root_invalid"),
    "not_found": ("file_not_found", "file_access_root_invalid"),
    "io_failed": ("os_error", SELFCHECK),
    "busy": ("os_error", SELFCHECK),
    "durability_uncertain": ("durability", SELFCHECK),
    "buffer_too_small": (PATH_FAILURE, SELFCHECK),
    "invalid_argument": (PATH_FAILURE, SELFCHECK),
    "internal": (PATH_FAILURE, "file_access_component_missing"),
    "platform_unsupported": (PATH_FAILURE, "file_access_platform_unsupported"),
    "api_missing": (PATH_FAILURE, "file_access_api_missing"),
    "elevated": (PATH_FAILURE, "file_access_elevated"),
    "backup_privilege": (PATH_FAILURE, "file_access_backup_privilege"),
    "volume_unsupported": (PATH_FAILURE, "file_access_volume_unsupported"),
    "root_invalid": (PATH_FAILURE, "file_access_root_invalid"),
    "root_identity": (PATH_FAILURE, "file_access_root_identity"),
    "selfcheck_failed": (PATH_FAILURE, SELFCHECK),
}
STATUS_VALUES = {row["name"]: row["value"] for row in ABI["status"]}
# The tables plus one number abi.json does not have.
ROWS = {**STATUS_TABLE, "unknown": (PATH_FAILURE, SELFCHECK)}
ROW_VALUES = {**STATUS_VALUES, "unknown": 99}


@pytest.fixture
def fake(monkeypatch) -> FakeLibrary:
    library = FakeLibrary()
    loaded = win32_library.load_library(lstat=regular_file_stat, loader=lambda path: library)
    monkeypatch.setattr(win32_library, "shared_library", lambda: loaded)
    yield library
    assert library.open_pins == set(), "a pin was left open"
    assert library.open_files == set(), "a file token was left open"


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return tmp_path.resolve()


@pytest.fixture
def pin(fake: FakeLibrary, root: Path) -> client.Win32Pin:
    opened = client.open_root(root, "7", "9")
    yield opened
    opened.close()


def _assert_path_failure(failure: BaseException) -> None:
    assert isinstance(failure, ToolExecutionFailure)
    assert failure.code == CMP_TOOL_INVALID_PATH
    assert failure.message == GENERIC_PATH_MESSAGE
    assert failure.retryable is False


def _assert_durability_uncertain(failure: BaseException) -> None:
    assert isinstance(failure, ToolExecutionFailure)
    assert failure.code == CMP_TOOL_IO_FAILED
    assert failure.retryable is False
    assert failure.effects == "applied_durability_uncertain"
    assert failure.message == ("File replacement applied; durability could not be "
                               "confirmed. Re-read before retrying.")


def _write(pin: client.Win32Pin, root: Path, expected: object = NO_EXPECTATION) -> bool:
    return client.write_atomic(pin, root, root / "dir" / "f.txt", b"new", expected,
                               NO_EXPECTATION, 0o600)


def _refused_open(pin: client.Win32Pin, root: Path, target: Path) -> BaseException:
    with pytest.raises(BaseException) as caught, client.open_file(pin, root, target, "rb"):
        pytest.fail("opened")
    return caught.value


def test_the_status_table_has_one_row_per_status_in_abi_json() -> None:
    assert len(STATUS_TABLE) == len(ABI["status"])
    assert set(STATUS_TABLE) == set(STATUS_VALUES)
    assert set(win32_library.STATUS) == set(STATUS_VALUES)
    assert ROW_VALUES["unknown"] not in STATUS_VALUES.values()


@pytest.mark.parametrize("name", sorted(ROWS))
def test_every_status_maps_to_its_exception_on_a_write(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin, name: str) -> None:
    expected, _ = ROWS[name]
    fake.statuses["jfa_write_atomic"] = [ROW_VALUES[name]]
    fake.details["jfa_write_atomic"] = (0, 1117)
    if expected == "value":
        assert _write(pin, root) is True
        return
    with pytest.raises(Exception) as caught:
        _write(pin, root)
    if name == "internal":
        fake.open_pins.clear()  # a latched library no longer closes; the process end does
    error = caught.value
    if expected == PATH_FAILURE:
        _assert_path_failure(error)
    elif expected == "file_not_found":
        assert type(error) is FileNotFoundError
        assert str(root) not in str(error)
    elif expected == "os_error":
        assert type(error) is OSError
        assert error.errno == errno.EIO
        assert "0x0000045D" in str(error)
        assert str(root) not in str(error)
    else:
        _assert_durability_uncertain(error)


@pytest.mark.parametrize("name", sorted(ROWS))
def test_every_status_maps_to_its_reason_at_start(fake: FakeLibrary, root: Path,
                                                  name: str) -> None:
    _, reason = ROWS[name]
    fake.statuses["jfa_root_open"] = [ROW_VALUES[name]]

    found = client.availability(root, "7", "9")
    if reason is None:
        assert found is None
        assert fake.closed_pins, "the self-check pin was not closed"
    else:  # no reason carries a detail but the latched component's
        assert found == client.Availability(reason, "internal" if name == "internal" else None)


@pytest.mark.parametrize("raised", [ctypes.ArgumentError("wrong type"),
                                    OSError(22, "exception: access violation")])
def test_a_self_check_that_raises_is_a_failed_self_check(fake: FakeLibrary, root: Path,
                                                         raised: BaseException) -> None:
    fake.root_open_raises = raised  # after the fake issued a pin

    assert client.availability(root, "7", "9") == client.Availability(SELFCHECK)
    assert client.unavailable_reason(root, "7", "9") == SELFCHECK
    assert len(fake.closed_pins) == 2  # the fixture asserts nothing stays open


@pytest.mark.parametrize("code", [5, 0xC0000022])
def test_access_denied_becomes_permission_error(fake: FakeLibrary, root: Path,
                                                pin: client.Win32Pin, code: int) -> None:
    fake.statuses["jfa_open_file"] = [STATUS_VALUES["io_failed"]]
    fake.details["jfa_open_file"] = (0, code)
    error = _refused_open(pin, root, root / "secret.txt")
    assert type(error) is PermissionError
    assert f"0x{code:08X}" in str(error)
    assert "secret" not in str(error)


@pytest.mark.parametrize(("reason", "words"), [("target_read_only", "read-only"),
                                               ("reparse_point", "placeholder")])
def test_a_refusal_with_a_known_reason_adds_plain_remediation(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin, reason: str, words: str) -> None:
    fake.statuses["jfa_write_atomic"] = [STATUS_VALUES["path_refused"]]
    fake.details["jfa_write_atomic"] = (win32_library.DETAIL_REASONS[reason], 0)
    with pytest.raises(ToolExecutionFailure) as caught:
        _write(pin, root)
    _assert_path_failure(caught.value)
    assert words in caught.value.remediation


def test_invalid_argument_logs_one_diagnostic_without_the_path(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin, caplog) -> None:
    fake.statuses["jfa_open_file"] = [STATUS_VALUES["invalid_argument"]]
    with caplog.at_level(logging.WARNING):
        _assert_path_failure(_refused_open(pin, root, root / "hidden-name.txt"))
    events = [r for r in caplog.records if r.getMessage() == "hosted_file.library_invalid_argument"]
    assert len(events) == 1
    assert "hidden-name" not in caplog.text


def test_segments_cross_as_a_list_and_are_never_judged(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin) -> None:
    names = ["dir", "..", "con.txt", "a|b", "trail. ", "é ü"]
    fake.statuses["jfa_open_file"] = [STATUS_VALUES["path_refused"]]
    _refused_open(pin, root, root.joinpath(*names))
    call, segments, units = fake.segments[0]
    assert call == "jfa_open_file"
    assert segments == names
    assert units == sum(len(name) + 1 for name in names)


def test_listing_the_root_sends_an_empty_list(fake: FakeLibrary, root: Path,
                                              pin: client.Win32Pin) -> None:
    with client.open_directory(pin, root, root) as directory:
        assert directory.scan(5) == []
    assert fake.segments == [("jfa_list", [], 0)]


@pytest.mark.parametrize("path", ["outside", "nul"])
def test_a_path_the_list_cannot_carry_never_reaches_the_library(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin, path: str) -> None:
    target = root.parent / "elsewhere.txt" if path == "outside" else root / "a\x00b"
    before = list(fake.calls)
    _assert_path_failure(_refused_open(pin, root, target))
    assert fake.calls == before


def test_a_listing_decodes_into_entries_list_dir_renders(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin) -> None:
    fake.listing = (record("src", directory=True) + record("a.txt", size=2048)
                    + record("link", reparse=True))
    with client.open_directory(pin, root, root / "sub") as directory:
        entries = directory.scan(10)
        rendered = [format_list_entry(entry).line for entry in entries]
    assert [entry.name for entry in entries] == ["src", "a.txt", "link"]
    assert rendered == ["[D] src", "[F] a.txt  2.0K", "[F] link  ?"]
    assert entries[2].is_dir(follow_symlinks=False) is False
    assert fake.list_calls[0].max_entries == 10
    assert fake.segments[0][1] == ["sub"]


def test_a_listed_name_round_trips_to_the_same_code_units(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin) -> None:
    lone = "bad\udc80name"  # a lone surrogate, as NTFS allows
    fake.listing = record(lone, size=1) + record("bad\udc81name", size=1)
    with client.open_directory(pin, root, root) as directory:
        names = [entry.name for entry in directory.scan(10)]
    assert names == [lone, "bad\udc81name"]  # two files never list under one name

    fake.statuses["jfa_open_file"] = [STATUS_VALUES["path_refused"]]
    _refused_open(pin, root, root / names[0])
    assert fake.segments[-1][1] == [lone]


def test_a_too_small_buffer_is_retried_once_with_the_size_returned(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin) -> None:
    fake.listing = b"".join(record(f"{index:0>200}", size=index) for index in range(400))
    with client.open_directory(pin, root, root) as directory:
        entries = directory.scan(1000)
    assert len(entries) == 400
    assert [call.capacity for call in fake.list_calls] == [client.FIRST_LISTING_CAPACITY,
                                                           len(fake.listing)]


@pytest.mark.parametrize("case", ["twice", "over_cap", "not_larger"])
def test_a_buffer_that_stays_too_small_refuses(fake: FakeLibrary, root: Path,
                                               pin: client.Win32Pin, case: str,
                                               monkeypatch) -> None:
    too_small = STATUS_VALUES["buffer_too_small"]
    if case == "twice":
        fake.listing = record("x" * 200) * 400
        fake.statuses["jfa_list"] = [0, too_small]  # the retry is refused again
    elif case == "over_cap":
        monkeypatch.setattr(client, "MAX_LISTING_BYTES", 1024)
        fake.listing = record("x" * 200) * 400
    else:
        fake.statuses["jfa_list"] = [too_small]  # needed (0) is not larger
    with pytest.raises(ToolExecutionFailure) as caught, client.open_directory(
            pin, root, root) as directory:
        directory.scan(1000)
    _assert_path_failure(caught.value)
    assert len(fake.list_calls) == (2 if case == "twice" else 1)


@pytest.mark.parametrize("case", ["name_past_end", "header_past_end", "used_past_capacity",
                                  "count_mismatch", "trailing_bytes", "unknown_flag",
                                  "more_than_asked"])
def test_a_listing_that_lies_is_refused_not_read(fake: FakeLibrary, root: Path,
                                                  pin: client.Win32Pin, case: str) -> None:
    good = record("a.txt", size=1)
    fake.listing = {
        "name_past_end": good + record("b", claimed_units=500),
        "header_past_end": good + b"\x00" * 6,
        "used_past_capacity": good,
        "count_mismatch": good,
        "trailing_bytes": good + b"\x00",
        "unknown_flag": record("a", flags=8),
        "more_than_asked": good * 3,
    }[case]
    if case == "used_past_capacity":
        fake.listing_used = client.FIRST_LISTING_CAPACITY + 1
    if case == "count_mismatch":
        fake.listing_count = 2
    if case in {"trailing_bytes", "header_past_end"}:
        fake.listing_count = 1
    with pytest.raises(ToolExecutionFailure) as caught, client.open_directory(
            pin, root, root) as directory:
        directory.scan(2 if case == "more_than_asked" else 10)
    _assert_path_failure(caught.value)


def test_a_directory_scans_once(fake: FakeLibrary, root: Path, pin: client.Win32Pin) -> None:
    with pytest.raises(ToolExecutionFailure), client.open_directory(
            pin, root, root) as directory:
        directory.scan(1)
        directory.scan(1)


@pytest.fixture
def real_handle(tmp_path: Path, monkeypatch):
    """`_open_osfhandle` hands back a real descriptor for a file holding b'body'."""
    source = tmp_path / "source.bin"
    source.write_bytes(b"body")
    wrapped: list[int] = []

    def open_osfhandle(handle: int) -> int:
        assert handle == FAKE_HANDLE
        fd = os.open(source, os.O_RDONLY)
        wrapped.append(fd)
        return fd

    monkeypatch.setattr(client, "_open_osfhandle", open_osfhandle)
    return wrapped


def test_reclaim_is_set_only_when_wrapping_the_taken_handle_fails(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin, monkeypatch) -> None:
    def refuse(handle: int) -> int:
        raise OSError(errno.EMFILE, "no descriptor")

    monkeypatch.setattr(client, "_open_osfhandle", refuse)
    assert "no descriptor" in str(_refused_open(pin, root, root / "f.txt"))
    assert [reclaim for _, reclaim in fake.file_closes] == [1]


@pytest.mark.parametrize("case", ["normal", "body_raises", "take_fails", "check_fails",
                                  "fdopen_fails"])
def test_every_exit_from_a_read_closes_the_token(fake: FakeLibrary, root: Path,
                                                 pin: client.Win32Pin, case: str,
                                                 real_handle: list[int]) -> None:
    if case == "take_fails":
        fake.statuses["jfa_file_take"] = [STATUS_VALUES["invalid_argument"]]
    if case == "check_fails":
        fake.statuses["jfa_file_check"] = [STATUS_VALUES["path_refused"]]
    encoding = "no-such-codec" if case == "fdopen_fails" else "utf-8"
    if case == "normal":
        with client.open_file(pin, root, root / "f.txt", "r", encoding=encoding) as handle:
            assert handle.read() == "body"
        assert fake.calls.count("jfa_file_check") == 1
    else:
        with pytest.raises((ToolExecutionFailure, RuntimeError, LookupError)):
            with client.open_file(pin, root, root / "f.txt", "r", encoding=encoding) as handle:
                if case == "body_raises":
                    raise RuntimeError("caller failed")
                handle.read()
    assert [reclaim for _, reclaim in fake.file_closes] == [0]
    for fd in real_handle:  # the descriptor never leaks, whoever owned it
        with pytest.raises(OSError):
            os.fstat(fd)


def test_a_refused_open_issues_no_token_to_close(fake: FakeLibrary, root: Path,
                                                 pin: client.Win32Pin) -> None:
    fake.statuses["jfa_open_file"] = [STATUS_VALUES["not_found"]]
    assert type(_refused_open(pin, root, root / "f.txt")) is FileNotFoundError
    assert fake.file_closes == []


def test_a_panic_latches_the_backend_off_for_the_process(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin, real_handle: list[int]) -> None:
    fake.statuses["jfa_write_atomic"] = [STATUS_VALUES["internal"]]
    with pytest.raises(ToolExecutionFailure):
        _write(pin, root)
    reached = list(fake.calls)

    _refused_open(pin, root, root / "f")
    with pytest.raises(ToolExecutionFailure), client.open_directory(pin, root, root) as directory:
        directory.scan(1)
    with pytest.raises(ToolExecutionFailure):
        client.open_root(root, "7", "9")
    pin.close()

    assert fake.calls == reached
    assert client.availability(root, "7", "9") == client.Availability(
        "file_access_component_missing", "internal")
    assert client.unavailable_reason() == "file_access_component_missing"
    fake.open_pins.clear()  # the latched library no longer closes; the process end does


def test_open_root_passes_the_identity_and_closes_once(fake: FakeLibrary, root: Path) -> None:
    opened = client.open_root(root, "18446744073709551615", "9")
    opened.close()
    opened.close()
    assert fake.root_opens == [(str(root), 2**64 - 1, 9)]
    assert fake.closed_pins == [opened.token]


def test_a_root_without_an_identity_sends_zero_for_the_library_to_refuse(
        fake: FakeLibrary, root: Path) -> None:
    fake.statuses["jfa_root_open"] = [STATUS_VALUES["root_identity"]]
    with pytest.raises(ToolExecutionFailure) as caught:
        client.open_root(root, None, None)
    _assert_path_failure(caught.value)
    assert fake.root_opens == [(str(root), 0, 0)]


@pytest.mark.parametrize("identity", [("abc", "9"), ("7", "-1"), ("7", str(2**64)), ("7", None)])
def test_an_identity_that_is_not_a_u64_never_reaches_the_library(
        fake: FakeLibrary, root: Path, identity: tuple) -> None:
    with pytest.raises(ToolExecutionFailure):
        client.open_root(root, *identity)
    assert client.unavailable_reason(root, *identity) == "file_access_root_identity"
    assert fake.root_opens == []


def test_a_scope_closes_the_client_pin_when_the_body_raises(
        fake: FakeLibrary, root: Path, monkeypatch) -> None:
    monkeypatch.setattr(hosted_file_io, "select_backend", lambda platform: client)
    with pytest.raises(RuntimeError), hosted_file_io.scoped_hosted_file_io(
            str(root), enabled=True, expected_device_id="7", expected_inode="9"):
        raise RuntimeError("tool failed")
    assert len(fake.closed_pins) == 1


def test_a_failed_pin_close_at_start_refuses(fake: FakeLibrary, root: Path) -> None:
    fake.statuses["jfa_pin_close"] = [STATUS_VALUES["invalid_argument"]]
    assert client.unavailable_reason(root, "7", "9") == SELFCHECK


@pytest.mark.parametrize(("expected", "sent"), [
    (None, (0, b"")), (NO_EXPECTATION, (1, b"")), (b"old", (2, b"old"))])
def test_write_sends_the_expectation_kind(fake: FakeLibrary, root: Path, pin: client.Win32Pin,
                                          expected: object, sent: tuple) -> None:
    assert _write(pin, root, expected) is True
    assert (fake.writes[0].content, fake.writes[0].kind, fake.writes[0].expected) == (
        b"new", *sent)
    assert fake.segments[0][1] == ["dir", "f.txt"]


def test_write_answers_false_when_not_matched(fake: FakeLibrary, root: Path,
                                              pin: client.Win32Pin) -> None:
    fake.write_outcome = 0
    assert _write(pin, root, b"old") is False
    with pytest.raises(ToolExecutionFailure):
        _write(pin, root, "not bytes")
    assert len(fake.writes) == 1


def test_an_unknown_outcome_beside_ok_may_have_replaced_the_file(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin) -> None:
    fake.write_outcome = 5
    with pytest.raises(ToolExecutionFailure) as caught:
        _write(pin, root, b"old")
    _assert_durability_uncertain(caught.value)


def test_the_library_is_checked_without_a_root(fake: FakeLibrary) -> None:
    assert client.availability() is None
    assert client.unavailable_reason() is None
    assert fake.root_opens == []


def test_a_missing_library_is_unavailable_with_its_detail(monkeypatch, root: Path) -> None:
    def missing() -> win32_library.FileAccessLibrary:
        raise win32_library.ComponentMissing("load_failed")

    monkeypatch.setattr(win32_library, "shared_library", missing)
    assert client.availability(root, "7", "9") == client.Availability(
        "file_access_component_missing", "load_failed")
    with pytest.raises(ToolExecutionFailure):
        client.open_root(root, "7", "9")


def test_the_facade_selects_the_client_only_when_its_library_is_usable(
        fake: FakeLibrary, monkeypatch) -> None:
    assert hosted_file_io._import_backend(hosted_file_io._WIN32_BACKEND) is client
    monkeypatch.setattr(client, "unavailable_reason", lambda *args: "file_access_switch_off")
    assert hosted_file_io._import_backend(hosted_file_io._WIN32_BACKEND) is None
    assert hosted_file_io._import_backend("sidecar.ai.tools.other") is None


def test_a_client_that_fails_to_import_is_no_backend(monkeypatch, caplog) -> None:
    monkeypatch.delattr(tools_package, "hosted_file_io_win32")
    monkeypatch.setitem(sys.modules, hosted_file_io._WIN32_BACKEND, None)  # import fails
    monkeypatch.setattr(hosted_file_io, "hosted_win32_files_enabled", lambda: True)

    with caplog.at_level(logging.WARNING):
        assert hosted_file_io.select_backend("win32") is None
    assert [r.getMessage() for r in caplog.records] == [
        "hosted_file.windows_backend_import_failed"]


def test_posix_hosts_never_import_the_client() -> None:
    script = (
        "import sys\n"
        "from sidecar.ai.tools import hosted_file_io as facade\n"
        "assert facade.__file__.startswith(sys.argv[1]), facade.__file__\n"
        "for platform in ('linux', 'darwin'):\n"
        "    facade.select_backend(platform)\n"
        "loaded = [m for m in sys.modules if m.startswith('sidecar.ai.tools.hosted_file_io_win32')]\n"
        "assert loaded == [], loaded\n"
    )
    completed = subprocess.run([sys.executable, "-c", script, str(ROOT)], cwd=ROOT,
                               capture_output=True, text=True, timeout=60, check=False)
    assert completed.returncode == 0, completed.stderr


# W14 review, findings 2 to 4: an asynchronous exception (KeyboardInterrupt here)
# at any point after the library hands out a pin or a file token. The fixtures
# assert that no pin and no token stays open.

def test_an_interrupt_out_of_the_wrap_never_asks_the_library_to_close_the_handle(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin, monkeypatch) -> None:
    def interrupted(handle: int) -> int:
        raise KeyboardInterrupt  # the descriptor may already own the handle

    monkeypatch.setattr(client, "_open_osfhandle", interrupted)
    with pytest.raises(KeyboardInterrupt), client.open_file(pin, root, root / "f.txt", "rb"):
        pytest.fail("opened")
    assert [reclaim for _, reclaim in fake.file_closes] == [0]


def test_an_interrupt_right_after_the_open_still_closes_the_token(
        fake: FakeLibrary, root: Path, pin: client.Win32Pin) -> None:
    fake.open_file_raises = KeyboardInterrupt()  # after the fake issued the token
    with pytest.raises(KeyboardInterrupt), client.open_file(pin, root, root / "f.txt", "rb"):
        pytest.fail("opened")
    assert [reclaim for _, reclaim in fake.file_closes] == [0]


def test_an_interrupt_right_after_the_root_open_still_closes_the_pin(
        fake: FakeLibrary, root: Path) -> None:
    fake.root_open_raises = KeyboardInterrupt()  # after the fake issued the pin
    with pytest.raises(KeyboardInterrupt):
        client.open_root(root, "7", "9")
    assert len(fake.closed_pins) == 1


def test_a_pin_dropped_unclosed_is_closed_once(fake: FakeLibrary, root: Path) -> None:
    dropped = client.open_root(root, "7", "9")
    token = dropped.token
    del dropped
    gc.collect()
    assert fake.closed_pins == [token]
    closed = client.open_root(root, "7", "9")
    closed.close()
    del closed
    gc.collect()
    assert len(fake.closed_pins) == 2, "a closed pin is not closed again when dropped"
