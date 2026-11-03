"""run_command <-> live test-run progress wiring (row 96 slice S2)."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import output_chunk_slot, shell_settings
from sidecar.ai.tools.builtins.shell import check_background_job_tool, run_command_tool
from sidecar.ai.tools.builtins.shell_background import TOOL_RESULTS_DIR
from sidecar.ai.tools.builtins.shell_test_progress import (
    BackgroundProgressTap,
    summary_for,
    tracker_for,
)
from sidecar.ai.tools.builtins.test_progress import TestProgressTracker
from sidecar.ai.tools.workspace import WorkspaceGuard

SAMPLE_TESTS = """\
import time


def test_ok_one():
    assert True


def test_fail():
    assert 1 == 2


def test_ok_two():
    time.sleep({sleep})
"""


@pytest.fixture
def flags():  # type: ignore[no-untyped-def]
    saved = dict(shell_settings._FEATURE_FLAGS)

    def configure(**values: bool) -> None:
        shell_settings.configure_shell_security(values)

    try:
        yield configure
    finally:
        shell_settings.configure_shell_security(saved)


def _guard(root: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(root))


def _write_sample(root: Path, sleep: float = 0) -> None:
    (root / "test_sample.py").write_text(SAMPLE_TESTS.format(sleep=sleep), encoding="utf-8")


def _pytest_command() -> str:
    return f'"{sys.executable}" -u -m pytest -p no:cacheprovider -v test_sample.py'


def _wait_for(predicate, timeout_seconds: float = 20.0) -> bool:  # type: ignore[no-untyped-def]
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


# ----------------------------------------------------------------------------- foreground


@pytest.mark.parametrize("with_writer", [True, False])
def test_foreground_pytest_run_reports_summary_and_live_progress(
    tmp_path: Path, with_writer: bool
) -> None:
    _write_sample(tmp_path)
    batches: list[dict[str, object]] = []
    if with_writer:
        output_chunk_slot.begin_tool_call(batches.append)
    try:
        result = run_command_tool({"command": _pytest_command()}, _guard(tmp_path))
    finally:
        if with_writer:
            output_chunk_slot.end_tool_call()

    assert result.success is False  # one test fails: the command's own exit status
    summary = result.metadata["test_summary"]
    assert isinstance(summary, dict)
    assert summary["runner"] == "pytest"
    assert (summary["total"], summary["tests"]) == (3, 3)
    assert (summary["passed"], summary["failed"], summary["skipped"]) == (2, 1, 0)
    assert summary["unit"] == "order"
    grid = summary["grid"]
    assert isinstance(grid, dict)
    assert grid["states"] == "pfp"
    failures = summary["failures"]
    assert isinstance(failures, list)
    assert [(f["file"], f["name"]) for f in failures] == [("test_sample.py", "test_fail")]
    # The model-facing output text keeps its shape (no progress leaks into it).
    assert "test_progress" not in result.output
    assert "test_summary" not in result.output

    progress_batches = [b for b in batches if "test_progress" in b]
    if with_writer:
        assert progress_batches
        last = progress_batches[-1]["test_progress"]
        assert isinstance(last, dict)
        assert last["final"] is True
        assert (last["passed"], last["failed"]) == (2, 1)
    else:
        assert batches == []


def test_flag_off_means_no_summary_and_no_progress_batches(tmp_path: Path, flags) -> None:  # type: ignore[no-untyped-def]
    flags(test_progress=False)
    _write_sample(tmp_path)
    batches: list[dict[str, object]] = []
    output_chunk_slot.begin_tool_call(batches.append)
    try:
        result = run_command_tool({"command": _pytest_command()}, _guard(tmp_path))
    finally:
        output_chunk_slot.end_tool_call()
    assert "test_summary" not in result.metadata
    assert batches
    assert all("test_progress" not in batch for batch in batches)
    assert tracker_for("pytest", tmp_path, tmp_path) is None


def test_non_test_command_gets_no_summary(tmp_path: Path) -> None:
    command = f'"{sys.executable}" -c "print(\'hello\')"'
    result = run_command_tool({"command": command}, _guard(tmp_path))
    assert result.success
    assert "test_summary" not in result.metadata


def test_summary_for_handles_missing_tracker_and_undetected_runner() -> None:
    assert summary_for(None) is None
    tracker = TestProgressTracker(
        command="echo", cwd=Path.cwd(), workspace_root=Path.cwd(), start_manifest_thread=False
    )
    assert summary_for(tracker) is None


# ----------------------------------------------------------------------------- background


def _progress_path(root: Path, job_id: str) -> Path:
    return root / TOOL_RESULTS_DIR / job_id / "progress.json"


def test_background_pytest_job_writes_progress_json_and_reports_progress(
    tmp_path: Path,
) -> None:
    _write_sample(tmp_path, sleep=4)
    started = run_command_tool(
        {"command": _pytest_command(), "run_in_background": True}, _guard(tmp_path)
    )
    job_id = str(started.metadata["background_job_id"])
    path = _progress_path(tmp_path, job_id)
    try:
        assert _wait_for(path.exists), "progress.json never appeared"
        # The last test sleeps, so the job keeps running while the first two report.
        assert _wait_for(lambda: json.loads(path.read_text(encoding="utf-8")).get("done", 0) >= 2)
        body = json.loads(path.read_text(encoding="utf-8"))
        assert body["schema_version"] == 1
        assert body["job_id"] == job_id
        assert body["runner"] == "pytest"
        assert body["total"] == 3
        assert body["failed"] == 1
        assert body["failures"] == ["test_fail"]
        assert body["failure_marks"] and all(isinstance(m, float) for m in body["failure_marks"])
        assert isinstance(body["updated_at_ms"], int)

        checked = check_background_job_tool({"job_id": job_id}, _guard(tmp_path))
        status = json.loads(checked.output)
        assert status["state"] == "running"
        assert status["progress"]["runner"] == "pytest"
        assert status["progress"]["failed"] == 1
        assert status["progress"]["failures"] == ["test_fail"]
        assert set(status["progress"]) == {
            "runner",
            "percent",
            "done",
            "total",
            "total_unit",
            "failed",
            "skipped",
            "failures",
        }
    finally:
        check_background_job_tool({"job_id": job_id, "wait_ms": 30_000}, _guard(tmp_path))
    done = json.loads(check_background_job_tool({"job_id": job_id}, _guard(tmp_path)).output)
    assert done["state"] == "failed"  # exit 1: one failing test
    assert "progress" not in done  # only running jobs report progress


def test_background_job_with_flag_off_writes_nothing(tmp_path: Path, flags) -> None:  # type: ignore[no-untyped-def]
    flags(test_progress=False)
    _write_sample(tmp_path, sleep=1)
    started = run_command_tool(
        {"command": _pytest_command(), "run_in_background": True}, _guard(tmp_path)
    )
    job_id = str(started.metadata["background_job_id"])
    mid = json.loads(check_background_job_tool({"job_id": job_id}, _guard(tmp_path)).output)
    assert "progress" not in mid
    check_background_job_tool({"job_id": job_id, "wait_ms": 30_000}, _guard(tmp_path))
    assert not _progress_path(tmp_path, job_id).exists()


# ----------------------------------------------------------------------------- the tap


class FakeStore:
    def __init__(self, fail: bool = False) -> None:
        self.writes: list[tuple[str, dict[str, object], int]] = []
        self.fail = fail

    def child(self, ref: object, name: str) -> str:
        return f"{ref}/{name}"

    def write_json_atomic(self, ref: str, body: dict[str, object], *, max_bytes: int) -> None:
        if self.fail:
            raise OSError("disk full")
        self.writes.append((ref, body, max_bytes))


class Clock:
    def __init__(self) -> None:
        self.now = 10.0

    def __call__(self) -> float:
        return self.now


def _tap(store: FakeStore | None, clock: Clock) -> BackgroundProgressTap:
    tracker = TestProgressTracker(
        command="pytest", cwd=Path.cwd(), workspace_root=Path.cwd(), start_manifest_thread=False
    )
    tap = BackgroundProgressTap(tracker, clock=clock)
    if store is not None:
        tap.bind("abc123abc123", store, "ref")  # type: ignore[arg-type]
    return tap


def test_tap_splits_bytes_into_lines_and_throttles_progress_writes() -> None:
    store, clock = FakeStore(), Clock()
    tap = _tap(store, clock)
    tap.on_chunk("stdout", b"plain output before any runner\n")
    assert store.writes == []  # nothing until a runner is detected
    header = "collected 100 items\r\n".encode()
    tap.on_chunk("stdout", header)
    assert len(store.writes) == 1
    ref, body, max_bytes = store.writes[0]
    assert ref == "ref/progress.json"
    assert max_bytes == 16 * 1024
    assert body["schema_version"] == 1
    assert body["job_id"] == "abc123abc123"
    assert body["runner"] == "pytest"
    # A multibyte character split across reads, a CRLF line, and a split result line.
    line = "tests/a.py::tést PASSED  [  1%]\n".encode()
    tap.on_chunk("stdout", line[:20])
    tap.on_chunk("stdout", line[20:])
    clock.now += 0.5
    tap.on_chunk("stdout", b"tests/a.py::t2 FAILED  [  2%]\r\n")
    assert len(store.writes) == 1  # throttled: <1 s since the last write
    clock.now += 1.0
    tap.on_chunk("stderr", b"tests/a.py::t3 PASSED  [  3%]\n")
    assert len(store.writes) == 2
    latest = store.writes[-1][1]
    assert latest["done"] == 3
    assert latest["failed"] == 1
    assert latest["failures"] == ["t2"]
    assert latest["total"] == 100
    progress = tap.progress()
    assert progress is not None
    assert set(progress) == {
        "runner",
        "percent",
        "done",
        "total",
        "total_unit",
        "failed",
        "skipped",
        "failures",
    }


def test_tap_never_raises_into_the_drain() -> None:
    clock = Clock()
    broken_store = FakeStore(fail=True)
    tap = _tap(broken_store, clock)
    tap.on_chunk("stdout", b"collected 5 items\n")  # the write fails; the tap carries on
    tap.on_chunk("stdout", b"\xff\xfe garbage \x00\n")
    tap.on_chunk("weird-stream", b"tests/a.py::t PASSED [ 20%]\n")
    unbound = _tap(None, clock)
    unbound.on_chunk("stdout", b"collected 5 items\n")  # no store bound: nothing to write
    assert unbound.progress() is not None
    assert _tap(None, clock).progress() is None


# ----------------------------------------------------------------------------- S3 review fixes


def test_tap_trailing_spaces_do_not_double_count_failures() -> None:
    tap = _tap(FakeStore(), Clock())
    tap.on_chunk("stdout", b"4 workers [10 items]\n")
    tap.on_chunk("stdout", b"[gw1] [ 38%] FAILED test_f05.py::test_fail \n")
    tap.on_chunk("stdout", b"=== short test summary info ===\n")
    tap.on_chunk("stdout", b"FAILED test_f05.py::test_fail - assert 1 == 2\n")
    progress = tap.progress()
    assert progress is not None
    assert progress["failed"] == 1
    assert progress["failures"] == ["test_fail"]


def test_throttled_write_gets_a_trailing_timer_write() -> None:
    store = FakeStore()
    tracker = TestProgressTracker(
        command="pytest", cwd=Path.cwd(), workspace_root=Path.cwd(), start_manifest_thread=False
    )
    tap = BackgroundProgressTap(tracker, min_interval_seconds=0.2)
    tap.bind("abc123abc123", store, "ref")  # type: ignore[arg-type]
    try:
        tap.on_chunk("stdout", b"collected 5 items\n")
        assert len(store.writes) == 1
        tap.on_chunk("stdout", b"tests/a.py::t PASSED  [ 20%]\n")  # throttled
        assert len(store.writes) == 1
        assert _wait_for(lambda: len(store.writes) == 2, timeout_seconds=3.0)
        assert store.writes[-1][1]["done"] == 1
    finally:
        tap.close()


def test_close_flushes_the_unterminated_line_and_stops_the_timer() -> None:
    store = FakeStore()
    tracker = TestProgressTracker(
        command="pytest", cwd=Path.cwd(), workspace_root=Path.cwd(), start_manifest_thread=False
    )
    tap = BackgroundProgressTap(tracker, min_interval_seconds=30.0)
    tap.bind("abc123abc123", store, "ref")  # type: ignore[arg-type]
    tap.on_chunk("stdout", b"collected 5 items\n")
    tap.on_chunk("stdout", b"tests/a.py::t PASSED  [ 20%]")  # no newline yet
    tap.close()
    progress = tap.progress()
    assert progress is not None
    assert progress["done"] == 1
    writes = len(store.writes)
    time.sleep(0.3)
    assert len(store.writes) == writes  # the pending trailing timer was cancelled
