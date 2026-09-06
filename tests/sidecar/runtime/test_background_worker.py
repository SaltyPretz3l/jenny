from __future__ import annotations

import json
import threading
import time

import pytest

import sidecar.runtime.background_worker as background_worker
from sidecar.runtime.background_worker import (
    TASK_HANDLERS,
    _background_parent_pid,
    _log_path,
    main,
    start_parent_watchdog,
)


def test_start_parent_watchdog_exits_when_parent_process_disappears() -> None:
    exit_codes: list[int] = []
    exited = threading.Event()

    def _record_exit(code: int) -> None:
        exit_codes.append(code)
        exited.set()

    stop_event = start_parent_watchdog(
        12345,
        check_process_exists=lambda _pid: False,
        exit_fn=_record_exit,
        interval_seconds=0.01,
    )

    # Wait on the watchdog itself rather than a 200ms wall-clock budget: the
    # production watchdog clamps its first poll to 100ms, so a loaded runner
    # could reach the assertion before it had run even once. The generous
    # timeout costs nothing -- the wait returns the moment exit_fn fires.
    assert exited.wait(timeout=5), "the parent watchdog never called exit_fn"

    assert exit_codes == [0]
    assert stop_event is not None
    stop_event.set()


def test_main_rejects_wrong_argument_count() -> None:
    with pytest.raises(SystemExit, match="usage"):
        main(["only_one_arg"])


def test_main_rejects_unknown_task_name(tmp_path) -> None:
    payload_path = tmp_path / "payload.json"
    payload_path.write_text('{"config": {}}', encoding="utf-8")

    with pytest.raises(SystemExit, match="unknown background task"):
        main(["nonexistent_task", str(payload_path)])


def test_background_worker_registers_automation_run_handler() -> None:
    # The registration must bind the EXACT worker function, not merely "some callable".
    from sidecar.runtime.automation_runner import run_automation_worker

    assert TASK_HANDLERS == {"automation_run": run_automation_worker}


# ---------------------------------------------------------------------------
# start_parent_watchdog: None / <= 0 pid -> returns None
# ---------------------------------------------------------------------------

def test_start_parent_watchdog_returns_none_for_none_pid() -> None:
    result = start_parent_watchdog(None)
    assert result is None


def test_start_parent_watchdog_returns_none_for_zero_pid() -> None:
    result = start_parent_watchdog(0)
    assert result is None


def test_start_parent_watchdog_returns_none_for_negative_pid() -> None:
    result = start_parent_watchdog(-5)
    assert result is None


def test_start_parent_watchdog_does_not_call_exit_when_process_stays_alive() -> None:
    """Watchdog loop's 'continue' branch is exercised; exit_fn never fires."""
    exit_codes: list[int] = []
    tick_count = 0
    # Use a threading event so check_alive can signal when it's been called
    was_called = threading.Event()

    def check_alive(_pid: int) -> bool:
        nonlocal tick_count
        tick_count += 1
        was_called.set()
        return True  # process always exists -> continue branch

    stop_event = start_parent_watchdog(
        99999,
        check_process_exists=check_alive,
        exit_fn=lambda code: exit_codes.append(code),
        # interval_seconds clamped to max(val, 0.1) in the watchdog loop
        interval_seconds=0.1,
    )
    assert stop_event is not None

    # Wait until at least one tick has fired (up to 1.5s)
    was_called.wait(timeout=1.5)

    # Signal the watchdog to stop
    stop_event.set()

    # Give thread time to finish
    time.sleep(0.05)

    # exit_fn must NOT have been called; loop just continued each tick
    assert exit_codes == []
    # check_alive was actually invoked (the continue branch was hit)
    assert tick_count >= 1


# ---------------------------------------------------------------------------
# main HAPPY PATH
# ---------------------------------------------------------------------------

def test_main_happy_path(tmp_path, monkeypatch) -> None:
    configure_calls: list[tuple] = []
    shutdown_calls: list[int] = []
    handler_calls: list[dict] = []

    def fake_configure_logging(path, *, log_level, capture_mode):
        configure_calls.append((str(path), log_level, capture_mode))

    def fake_shutdown_logging():
        shutdown_calls.append(1)

    def fake_handler(payload: dict) -> dict:
        handler_calls.append(dict(payload))
        return {"status": "ok"}

    monkeypatch.setattr(background_worker, "configure_sidecar_logging", fake_configure_logging)
    monkeypatch.setattr(background_worker, "shutdown_sidecar_logging", fake_shutdown_logging)
    # No real watchdog: JENNY_BACKGROUND_PARENT_PID unset -> None pid -> no thread
    monkeypatch.delenv("JENNY_BACKGROUND_PARENT_PID", raising=False)

    TASK_HANDLERS["unit_probe"] = fake_handler
    try:
        payload = {
            "config": {
                "diagnostics_log_level": "debug",
                "diagnostics_capture_mode": "full",
            },
            "data": "example-value",
        }
        payload_path = tmp_path / "payload.json"
        payload_path.write_text(json.dumps(payload), encoding="utf-8")

        result = main(["unit_probe", str(payload_path)])

        assert result == 0
        assert len(handler_calls) == 1
        assert handler_calls[0]["data"] == "example-value"
        assert len(configure_calls) == 1
        assert configure_calls[0][1] == "debug"
        assert configure_calls[0][2] == "full"
        assert len(shutdown_calls) == 1
    finally:
        TASK_HANDLERS.pop("unit_probe", None)


def test_main_happy_path_default_log_config(tmp_path, monkeypatch) -> None:
    """When payload has no 'config' key, logging defaults are used."""
    configure_calls: list[tuple] = []
    shutdown_calls: list[int] = []
    handler_calls: list[dict] = []

    def fake_configure_logging(path, *, log_level, capture_mode):
        configure_calls.append((log_level, capture_mode))

    def fake_shutdown_logging():
        shutdown_calls.append(1)

    def fake_handler(payload: dict) -> dict:
        handler_calls.append(dict(payload))
        return {"status": "ok"}

    monkeypatch.setattr(background_worker, "configure_sidecar_logging", fake_configure_logging)
    monkeypatch.setattr(background_worker, "shutdown_sidecar_logging", fake_shutdown_logging)
    monkeypatch.delenv("JENNY_BACKGROUND_PARENT_PID", raising=False)

    TASK_HANDLERS["unit_probe2"] = fake_handler
    try:
        payload_path = tmp_path / "payload2.json"
        payload_path.write_text('{"data": "example-sample"}', encoding="utf-8")

        result = main(["unit_probe2", str(payload_path)])

        assert result == 0
        assert len(configure_calls) == 1
        # Default values when no config key present
        assert configure_calls[0] == ("info", "redacted")
        assert len(shutdown_calls) == 1
    finally:
        TASK_HANDLERS.pop("unit_probe2", None)


# ---------------------------------------------------------------------------
# main payload-not-dict (line 99)
# ---------------------------------------------------------------------------

def test_main_reads_the_secret_frame_before_the_payload_file(tmp_path, monkeypatch) -> None:
    # Ordering is load-bearing: if the payload read raised first, the parent's
    # frame write would block until this process exited.
    order: list[str] = []
    handler_payloads: list[dict] = []
    original_read_payload = background_worker._read_worker_payload

    def fake_read_frame(_stream) -> dict:
        order.append("frame")
        return {"chatgpt_access_token": "sentinel-bearer-token-value"}

    def tracked_read_payload(path):
        order.append("payload")
        return original_read_payload(path)

    monkeypatch.setattr(background_worker, "read_secrets_frame", fake_read_frame)
    monkeypatch.setattr(background_worker, "_read_worker_payload", tracked_read_payload)
    monkeypatch.setattr(background_worker, "configure_sidecar_logging", lambda *_a, **_k: None)
    monkeypatch.setattr(background_worker, "shutdown_sidecar_logging", lambda: None)
    monkeypatch.delenv("JENNY_BACKGROUND_PARENT_PID", raising=False)

    payload_path = tmp_path / "payload.json"
    payload_path.write_text('{"config": {"engine_type": "chatgpt"}}', encoding="utf-8")
    TASK_HANDLERS["unit_probe_frame"] = lambda payload: (
        handler_payloads.append(payload) or {"status": "ok"}
    )
    try:
        assert main(["unit_probe_frame", str(payload_path)]) == 0
    finally:
        TASK_HANDLERS.pop("unit_probe_frame", None)

    assert order == ["frame", "payload"]
    assert handler_payloads[0]["secrets"] == {
        "chatgpt_access_token": "sentinel-bearer-token-value"
    }
    # The frame is in-memory only; the payload file on disk is unchanged.
    assert "sentinel-bearer-token-value" not in payload_path.read_text(encoding="utf-8")


def test_main_leaves_payload_untouched_when_no_secret_frame_arrives(tmp_path, monkeypatch) -> None:
    handler_payloads: list[dict] = []
    monkeypatch.setattr(background_worker, "read_secrets_frame", lambda _stream: {})
    monkeypatch.setattr(background_worker, "configure_sidecar_logging", lambda *_a, **_k: None)
    monkeypatch.setattr(background_worker, "shutdown_sidecar_logging", lambda: None)
    monkeypatch.delenv("JENNY_BACKGROUND_PARENT_PID", raising=False)

    payload_path = tmp_path / "payload.json"
    payload_path.write_text('{"config": {}}', encoding="utf-8")
    TASK_HANDLERS["unit_probe_noframe"] = lambda payload: (
        handler_payloads.append(payload) or {"status": "ok"}
    )
    try:
        assert main(["unit_probe_noframe", str(payload_path)]) == 0
    finally:
        TASK_HANDLERS.pop("unit_probe_noframe", None)

    assert "secrets" not in handler_payloads[0]


def test_main_rejects_non_dict_payload(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("JENNY_BACKGROUND_PARENT_PID", raising=False)
    TASK_HANDLERS["unit_probe3"] = lambda p: {"status": "ok"}
    try:
        payload_path = tmp_path / "list_payload.json"
        payload_path.write_text("[]", encoding="utf-8")

        with pytest.raises(SystemExit, match="background payload must be a JSON object"):
            main(["unit_probe3", str(payload_path)])
    finally:
        TASK_HANDLERS.pop("unit_probe3", None)


def test_main_rejects_oversized_payload_before_json_decode(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(background_worker, "MAX_BACKGROUND_PAYLOAD_BYTES", 32)
    payload_path = tmp_path / "oversized.json"
    payload_path.write_bytes(b"{" + (b"x" * 32))
    TASK_HANDLERS["unit_probe_oversized"] = lambda _payload: {"status": "ok"}
    try:
        with pytest.raises(SystemExit, match="byte limit"):
            main(["unit_probe_oversized", str(payload_path)])
    finally:
        TASK_HANDLERS.pop("unit_probe_oversized", None)


def test_worker_completion_log_does_not_include_raw_result_values(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "sk-" + ("a" * 40)
    payload_path = tmp_path / "payload.json"
    payload_path.write_text("{}", encoding="utf-8")
    TASK_HANDLERS["unit_probe_redaction"] = lambda _payload: {"token": secret}
    monkeypatch.setattr(background_worker, "configure_sidecar_logging", lambda *_a, **_k: None)
    monkeypatch.setattr(background_worker, "shutdown_sidecar_logging", lambda: None)
    monkeypatch.delenv("JENNY_BACKGROUND_PARENT_PID", raising=False)
    try:
        with caplog.at_level("INFO"):
            assert main(["unit_probe_redaction", str(payload_path)]) == 0
    finally:
        TASK_HANDLERS.pop("unit_probe_redaction", None)

    assert secret not in caplog.text


# ---------------------------------------------------------------------------
# _background_parent_pid (lines 120-127)
# ---------------------------------------------------------------------------

def test_background_parent_pid_valid(monkeypatch) -> None:
    monkeypatch.setenv("JENNY_BACKGROUND_PARENT_PID", "123")
    assert _background_parent_pid() == 123


def test_background_parent_pid_negative_returns_none(monkeypatch) -> None:
    monkeypatch.setenv("JENNY_BACKGROUND_PARENT_PID", "-1")
    assert _background_parent_pid() is None


def test_background_parent_pid_zero_returns_none(monkeypatch) -> None:
    monkeypatch.setenv("JENNY_BACKGROUND_PARENT_PID", "0")
    assert _background_parent_pid() is None


def test_background_parent_pid_non_numeric_returns_none(monkeypatch) -> None:
    monkeypatch.setenv("JENNY_BACKGROUND_PARENT_PID", "abc")
    assert _background_parent_pid() is None


def test_background_parent_pid_missing_env_returns_none(monkeypatch) -> None:
    monkeypatch.delenv("JENNY_BACKGROUND_PARENT_PID", raising=False)
    assert _background_parent_pid() is None


def test_background_parent_pid_empty_string_returns_none(monkeypatch) -> None:
    monkeypatch.setenv("JENNY_BACKGROUND_PARENT_PID", "")
    assert _background_parent_pid() is None


# ---------------------------------------------------------------------------
# _log_path (line 131)
# ---------------------------------------------------------------------------

def test_log_path_ends_with_companion_logs_sidecar_log() -> None:
    path = _log_path()
    # Must end with .companion/logs/sidecar.log
    assert path.parts[-1] == "sidecar.log"
    assert path.parts[-2] == "logs"
    assert path.parts[-3] == ".companion"


def test_log_path_returns_path_object() -> None:
    from pathlib import Path
    path = _log_path()
    assert isinstance(path, Path)
