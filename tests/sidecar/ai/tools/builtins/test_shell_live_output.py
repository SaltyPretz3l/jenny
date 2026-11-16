"""Live output tail for background run_command jobs (row 138)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.tools.builtins import shell_settings
from sidecar.ai.tools.builtins.shell import check_background_job_tool, run_command_tool
from sidecar.ai.tools.builtins.shell_background import TOOL_RESULTS_DIR
from sidecar.ai.tools.builtins.shell_live_output import (
    LIVE_OUTPUT_FILE,
    LIVE_OUTPUT_FILE_MAX_BYTES,
    LIVE_OUTPUT_MAX_CHARS,
    CompositeBackgroundTap,
    LiveOutputTap,
    background_tap_for,
    live_tap_for,
)
from sidecar.ai.tools.workspace import WorkspaceGuard

JOB_ID = "abc123abc123"
REPLACEMENT = chr(0xFFFD)  # what the "replace" decoder emits


class FakeStore:
    def __init__(self, fail: bool = False) -> None:
        self.writes: list[tuple[str, dict[str, Any], int]] = []
        self.fail = fail

    def child(self, ref: object, name: str) -> str:
        return f"{ref}/{name}"

    def write_json_atomic(self, ref: str, body: dict[str, Any], *, max_bytes: int) -> None:
        if self.fail:
            raise OSError("disk full")
        self.writes.append((ref, body, max_bytes))

    @property
    def last(self) -> dict[str, Any]:
        return self.writes[-1][1]


class Clock:
    def __init__(self) -> None:
        self.now = 10.0

    def __call__(self) -> float:
        return self.now


class FakeTimer:
    """Records the trailing write instead of sleeping; ``fire()`` runs it."""

    created: list[FakeTimer] = []

    def __init__(self, delay: float, callback: Any) -> None:
        self.delay, self.callback = delay, callback
        self.started = self.cancelled = False
        self.daemon = False
        FakeTimer.created.append(self)

    def start(self) -> None:
        self.started = True

    def cancel(self) -> None:
        self.cancelled = True

    def fire(self) -> None:
        self.callback()


@pytest.fixture(autouse=True)
def _reset_timers() -> None:
    FakeTimer.created = []


def _tap(store: FakeStore | None = None, clock: Clock | None = None) -> LiveOutputTap:
    tap = LiveOutputTap(clock=clock or Clock(), timer_factory=FakeTimer)
    if store is not None:
        tap.bind(JOB_ID, store, "ref")  # type: ignore[arg-type]
    return tap


@pytest.fixture
def flags():  # type: ignore[no-untyped-def]
    saved = dict(shell_settings._FEATURE_FLAGS)

    def configure(**values: bool) -> None:
        shell_settings.configure_shell_security(values)

    try:
        yield configure
    finally:
        shell_settings.configure_shell_security(saved)


# ----------------------------------------------------------------------------- the tail


def test_first_chunk_writes_the_schema_and_small_output_is_not_truncated() -> None:
    store = FakeStore()
    tap = _tap(store)
    tap.on_chunk("stdout", b"building\n")
    assert len(store.writes) == 1
    ref, body, max_bytes = store.writes[0]
    assert ref == f"ref/{LIVE_OUTPUT_FILE}"
    assert max_bytes == LIVE_OUTPUT_FILE_MAX_BYTES
    assert set(body) == {"schema_version", "job_id", "text", "truncated", "updated_at_ms"}
    assert (body["schema_version"], body["job_id"], body["text"]) == (1, JOB_ID, "building\n")
    assert body["truncated"] is False
    assert isinstance(body["updated_at_ms"], int)


def test_cap_keeps_the_last_chars_and_sets_truncated() -> None:
    store = FakeStore()
    tap = _tap(store)
    tap.on_chunk("stdout", b"HEAD-MARKER\n" + b"x" * (LIVE_OUTPUT_MAX_CHARS * 2) + b"\nTAIL")
    tap.close()
    text = store.last["text"]
    assert len(text) == LIVE_OUTPUT_MAX_CHARS
    assert text.endswith("\nTAIL")
    assert "HEAD-MARKER" not in text
    assert store.last["truncated"] is True


def test_output_just_over_the_cap_is_truncated_even_inside_the_redaction_margin() -> None:
    store = FakeStore()
    tap = _tap(store)
    tap.on_chunk("stdout", b"y" * (LIVE_OUTPUT_MAX_CHARS + 10))
    tap.close()
    assert len(store.last["text"]) == LIVE_OUTPUT_MAX_CHARS
    assert store.last["truncated"] is True


def test_carriage_return_progress_never_grows_the_buffer_past_the_cap() -> None:
    store = FakeStore()
    tap = _tap(store)
    for percent in range(20_000):
        tap.on_chunk("stdout", f"\rprogress {percent % 100:3d}%".encode())
        assert len(tap._buffer) <= LIVE_OUTPUT_MAX_CHARS + 512  # the cap holds between writes
    tap.close()
    assert len(store.last["text"]) <= LIVE_OUTPUT_MAX_CHARS
    assert store.last["truncated"] is True
    assert store.last["text"].endswith("progress  99%")


def test_streams_interleave_in_arrival_order() -> None:
    store = FakeStore()
    tap = _tap(store)
    tap.on_chunk("stdout", b"one\n")
    tap.on_chunk("stderr", b"two\n")
    tap.on_chunk("stdout", b"three\n")
    tap.on_chunk("weird-stream", b"four\n")  # unknown streams decode as stdout
    tap.close()
    assert store.last["text"] == "one\ntwo\nthree\nfour\n"


def test_a_multibyte_character_split_across_chunks_decodes_whole() -> None:
    store = FakeStore()
    tap = _tap(store)
    encoded = "naïve café ✓\n".encode()
    split = encoded.index("ï".encode()) + 1  # inside the two-byte sequence
    tap.on_chunk("stdout", encoded[:split])
    tap.on_chunk("stderr", b"")  # the other stream's decoder is independent
    tap.on_chunk("stdout", encoded[split:])
    tap.close()
    assert store.last["text"] == "naïve café ✓\n"
    assert REPLACEMENT not in store.last["text"]


def test_live_text_runs_the_status_redaction_pipeline() -> None:
    store = FakeStore()
    tap = _tap(store)
    secret = "ghp_" + "a" * 36
    tap.on_chunk("stdout", f"token {secret} end\n".encode())
    tap.close()
    assert secret not in store.last["text"]
    assert "[REDACTED]" in store.last["text"]


# ----------------------------------------------------------------------------- throttling


def test_two_chunks_inside_one_interval_write_once_and_the_trailing_timer_writes_the_second() -> None:
    store, clock = FakeStore(), Clock()
    tap = _tap(store, clock)
    tap.on_chunk("stdout", b"first\n")
    clock.now += 0.4
    tap.on_chunk("stdout", b"second\n")
    assert len(store.writes) == 1
    assert store.last["text"] == "first\n"
    assert len(FakeTimer.created) == 1
    timer = FakeTimer.created[0]
    assert timer.started and timer.daemon
    assert timer.delay == pytest.approx(0.6)
    clock.now += 0.4
    tap.on_chunk("stdout", b"third\n")
    assert len(FakeTimer.created) == 1  # at most one trailing timer
    clock.now += 0.3
    timer.fire()
    assert len(store.writes) == 2
    assert store.last["text"] == "first\nsecond\nthird\n"


def test_close_cancels_the_timer_and_forces_the_last_write() -> None:
    store, clock = FakeStore(), Clock()
    tap = _tap(store, clock)
    tap.on_chunk("stdout", b"start\n")
    clock.now += 0.1
    tap.on_chunk("stdout", b"partial line \xe2\x9c")  # throttled, ends mid-character
    assert len(store.writes) == 1
    tap.close()
    assert FakeTimer.created[0].cancelled
    assert len(store.writes) == 2
    assert store.last["text"] == "start\npartial line " + REPLACEMENT  # the decoder flushed
    FakeTimer.created[0].fire()  # a timer that raced close() writes nothing more
    assert len(store.writes) == 2


def test_nothing_is_written_before_bind_or_without_output() -> None:
    unbound = _tap()
    unbound.on_chunk("stdout", b"early\n")
    unbound.close()  # no store: nothing to write, nothing raised

    store = FakeStore()
    silent = _tap(store)
    silent.on_chunk("stdout", b"")
    silent.on_chunk("stdout", b"\xe2")  # half a character is not output yet
    assert store.writes == []
    silent_store = FakeStore()
    _tap(silent_store).close()
    assert silent_store.writes == []

    late = _tap()
    late.on_chunk("stdout", b"before bind\n")
    late_store = FakeStore()
    late.bind(JOB_ID, late_store, "ref")  # type: ignore[arg-type]
    late.close()
    assert late_store.last["text"] == "before bind\n"


def test_a_store_that_raises_never_propagates() -> None:
    store, clock = FakeStore(fail=True), Clock()
    tap = _tap(store, clock)
    tap.on_chunk("stdout", b"one\n")
    clock.now += 0.1
    tap.on_chunk("stdout", b"two\n")
    FakeTimer.created[0].fire()
    tap.close()
    assert store.writes == []


# ----------------------------------------------------------------------------- composite + flag


class RecordingTap:
    def __init__(self, fail: bool = False, progress: dict[str, object] | None = None) -> None:
        self.calls: list[tuple[object, ...]] = []
        self.fail = fail
        self._progress = progress
        self.tracker = object()

    def _record(self, *call: object) -> None:
        self.calls.append(call)
        if self.fail:
            raise RuntimeError("tap broke")

    def bind(self, job_id: str, store: object, job_ref: object) -> None:
        self._record("bind", job_id)

    def on_chunk(self, stream: str, data: bytes) -> None:
        self._record("on_chunk", stream, data)

    def close(self) -> None:
        self._record("close")

    def progress(self) -> dict[str, object] | None:
        return self._progress


def test_composite_feeds_both_taps_and_survives_one_raising() -> None:
    store = FakeStore()
    broken = RecordingTap(fail=True, progress={"runner": "pytest", "done": 3})
    live = _tap()
    composite = CompositeBackgroundTap(broken, live)
    composite.bind(JOB_ID, store, "ref")  # type: ignore[arg-type]
    composite.on_chunk("stdout", b"hello\n")
    composite.close()
    assert broken.calls == [("bind", JOB_ID), ("on_chunk", "stdout", b"hello\n"), ("close",)]
    assert store.last["text"] == "hello\n"  # the live tap kept working
    assert composite.progress() == {"runner": "pytest", "done": 3}
    assert composite.tracker is broken.tracker

    class BrokenLive(LiveOutputTap):
        def on_chunk(self, stream: str, data: bytes) -> None:
            raise RuntimeError("live broke")

    healthy = RecordingTap()
    survivor = CompositeBackgroundTap(healthy, BrokenLive())
    survivor.on_chunk("stderr", b"x")
    assert healthy.calls == [("on_chunk", "stderr", b"x")]


def test_composite_without_a_progress_tap_reports_no_progress() -> None:
    composite = CompositeBackgroundTap(None, _tap())
    assert composite.progress() is None
    assert composite.tracker is None
    composite.on_chunk("stdout", b"x")
    composite.close()


def test_flag_off_creates_no_live_tap(flags, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    flags(background_live_output=False, test_progress=False)
    assert live_tap_for() is None
    assert background_tap_for("echo hi", tmp_path, tmp_path) is None  # exactly today's tap
    flags(background_live_output=False)
    plain = background_tap_for("pytest -q", tmp_path, tmp_path)
    assert plain is not None and not isinstance(plain, CompositeBackgroundTap)
    flags()
    assert isinstance(live_tap_for(), LiveOutputTap)
    composite = background_tap_for("echo hi", tmp_path, tmp_path)
    assert isinstance(composite, CompositeBackgroundTap)
    assert composite.progress() is None


# ----------------------------------------------------------------------------- real job


def _live_path(root: Path, job_id: str) -> Path:
    return root / TOOL_RESULTS_DIR / job_id / LIVE_OUTPUT_FILE


def _run_background(root: Path, script: str) -> str:
    command = f'"{sys.executable}" -u -c "{script}"'
    guard = WorkspaceGuard(str(root))
    started = run_command_tool({"command": command, "run_in_background": True}, guard)
    job_id = str(started.metadata["background_job_id"])
    check_background_job_tool({"job_id": job_id, "wait_ms": 30_000}, guard)
    return job_id


def test_a_background_job_leaves_its_live_tail_beside_status_json(
    flags, tmp_path: Path  # type: ignore[no-untyped-def]
) -> None:
    flags()
    job_id = _run_background(tmp_path, "print('hello live'); import sys; print('oops', file=sys.stderr)")
    body = json.loads(_live_path(tmp_path, job_id).read_text(encoding="utf-8"))
    assert body["schema_version"] == 1
    assert body["job_id"] == job_id
    assert "hello live" in body["text"] and "oops" in body["text"]
    assert body["truncated"] is False


def test_a_background_job_with_the_flag_off_writes_no_live_file(
    flags, tmp_path: Path  # type: ignore[no-untyped-def]
) -> None:
    flags(background_live_output=False)
    job_id = _run_background(tmp_path, "print('quiet')")
    assert (tmp_path / TOOL_RESULTS_DIR / job_id / "status.json").exists()
    assert not _live_path(tmp_path, job_id).exists()
