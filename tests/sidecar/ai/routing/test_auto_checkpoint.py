"""Tests for sidecar.ai.routing.auto_checkpoint.

Covers the pure decision function (``should_create_checkpoint``) and the
stateful entry point (``maybe_create_auto_checkpoint``): fires at most once
per run, is best-effort (never raises, never blocks the turn), and skips
silently when there is no session or no electron tool bridge wired up.
"""
from __future__ import annotations

import logging
import time
from types import SimpleNamespace

import pytest

from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.routing import auto_checkpoint as _auto_ckpt
from sidecar.ai.routing.auto_checkpoint import (
    AUTO_CHECKPOINT_FLAG,
    maybe_create_auto_checkpoint,
    should_create_checkpoint,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle


def _make_loop_run(
    *,
    flag_enabled: bool = True,
    has_writer: bool = True,
    session_id="sess1",
    cancel_handle: TurnCancellationHandle | None = None,
    wall_clock_deadline: float | None = None,
):
    runtime = LoopRuntime(
        electron_tool_writer=(lambda message: None) if has_writer else None,
        electron_tool_reader=None,
        electron_tool_reader_factory=None,
        trace_id=None,
        cancel_handle=cancel_handle,
        wall_clock_deadline=wall_clock_deadline,
    )
    kernel = SimpleNamespace(
        _config=SimpleNamespace(feature_flags={AUTO_CHECKPOINT_FLAG: flag_enabled}),
    )
    return SimpleNamespace(
        kernel=kernel,
        runtime=runtime,
        request_id="req1",
        session_id=session_id,
        checkpoint_created=False,
    )


def _mutating_remaining():
    return [(SimpleNamespace(tool_id="write_file"), 1)]


def _readonly_remaining():
    return [(SimpleNamespace(tool_id="read_file"), 1)]


# ---------------------------------------------------------------------------
# should_create_checkpoint (pure truth table)
# ---------------------------------------------------------------------------


def test_should_create_checkpoint_false_when_flag_off():
    assert should_create_checkpoint(
        feature_flags={AUTO_CHECKPOINT_FLAG: False},
        already_created=False,
        tool_ids=["write_file"],
    ) is False


def test_should_create_checkpoint_false_when_no_mutating_tool():
    assert should_create_checkpoint(
        feature_flags={AUTO_CHECKPOINT_FLAG: True},
        already_created=False,
        tool_ids=["read_file"],
    ) is False


def test_should_create_checkpoint_true_when_flag_on_and_mutating_tool_present():
    assert should_create_checkpoint(
        feature_flags={AUTO_CHECKPOINT_FLAG: True},
        already_created=False,
        tool_ids=["write_file"],
    ) is True


def test_should_create_checkpoint_true_for_move_file():
    assert should_create_checkpoint(
        feature_flags={AUTO_CHECKPOINT_FLAG: True},
        already_created=False,
        tool_ids=["move_file"],
    ) is True


def test_should_create_checkpoint_false_when_already_created():
    assert should_create_checkpoint(
        feature_flags={AUTO_CHECKPOINT_FLAG: True},
        already_created=True,
        tool_ids=["write_file"],
    ) is False


# ---------------------------------------------------------------------------
# maybe_create_auto_checkpoint -- fires at most once
# ---------------------------------------------------------------------------


def test_maybe_create_auto_checkpoint_fires_exactly_once_across_two_batches(monkeypatch):
    calls = []

    def _fake_execute(request):
        calls.append(request)
        return SimpleNamespace(success=True, metadata={"ref": "checkpoint/1"})

    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", _fake_execute)
    loop_run = _make_loop_run()

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())
    assert loop_run.checkpoint_created is True
    assert len(calls) == 1

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())
    assert len(calls) == 1


def test_maybe_create_auto_checkpoint_uses_the_turns_request_id(monkeypatch):
    calls = []
    monkeypatch.setattr(
        _auto_ckpt,
        "execute_electron_tool",
        lambda request: calls.append(request) or SimpleNamespace(success=True, metadata={}),
    )
    loop_run = _make_loop_run()
    loop_run.request_id = "turn-req-42"

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert len(calls) == 1
    assert calls[0].request_id == "turn-req-42"
    assert calls[0].tool_name == "__jenny_git_checkpoint"


# ---------------------------------------------------------------------------
# maybe_create_auto_checkpoint -- does NOT fire
# ---------------------------------------------------------------------------


def test_maybe_create_auto_checkpoint_does_not_fire_when_flag_off(monkeypatch):
    calls = []
    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", calls.append)
    loop_run = _make_loop_run(flag_enabled=False)

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert calls == []
    assert loop_run.checkpoint_created is False


def test_maybe_create_auto_checkpoint_does_not_fire_when_no_mutating_tool(monkeypatch):
    calls = []
    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", calls.append)
    loop_run = _make_loop_run()

    maybe_create_auto_checkpoint(loop_run, _readonly_remaining())

    assert calls == []
    assert loop_run.checkpoint_created is False


def test_maybe_create_auto_checkpoint_skips_silently_when_no_session_id(monkeypatch):
    calls = []
    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", calls.append)
    loop_run = _make_loop_run(session_id=None)

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())  # must not raise

    assert calls == []


def test_maybe_create_auto_checkpoint_returns_without_error_when_no_electron_writer(monkeypatch):
    calls = []
    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", calls.append)
    loop_run = _make_loop_run(has_writer=False)

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())  # must not raise

    assert calls == []


# ---------------------------------------------------------------------------
# maybe_create_auto_checkpoint -- best-effort (never propagates failures)
# ---------------------------------------------------------------------------


def test_maybe_create_auto_checkpoint_logs_skipped_when_bridge_fails(monkeypatch, caplog):
    monkeypatch.setattr(
        _auto_ckpt,
        "_request_checkpoint",
        lambda loop_run: SimpleNamespace(
            success=False,
            metadata={},
            output="Auto-checkpoint git service unavailable.",
        ),
    )
    caplog.set_level(logging.INFO, logger=_auto_ckpt.__name__)

    maybe_create_auto_checkpoint(_make_loop_run(), _mutating_remaining())

    events = [getattr(record, "event", "") for record in caplog.records]
    assert "ai.router.auto_checkpoint_skipped" in events
    assert "ai.router.auto_checkpoint_created" not in events


def test_maybe_create_auto_checkpoint_logs_skipped_when_no_checkpoint_created(monkeypatch, caplog):
    monkeypatch.setattr(
        _auto_ckpt,
        "_request_checkpoint",
        lambda loop_run: SimpleNamespace(
            success=True,
            metadata={"created": False, "reason": "not_a_repo"},
            output="no checkpoint (not_a_repo)",
        ),
    )
    caplog.set_level(logging.INFO, logger=_auto_ckpt.__name__)

    maybe_create_auto_checkpoint(_make_loop_run(), _mutating_remaining())

    events = [getattr(record, "event", "") for record in caplog.records]
    assert "ai.router.auto_checkpoint_skipped" in events
    assert "ai.router.auto_checkpoint_created" not in events


def test_maybe_create_auto_checkpoint_swallows_mcp_error_and_keeps_checkpoint_created(monkeypatch):
    def _raise(request):
        raise MCPError(code="CMP-TOOL-0008", message="bridge unavailable", retryable=False)

    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", _raise)
    loop_run = _make_loop_run()

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())  # must not raise

    assert loop_run.checkpoint_created is True


def test_maybe_create_auto_checkpoint_swallows_arbitrary_exception(monkeypatch):
    monkeypatch.setattr(
        _auto_ckpt,
        "execute_electron_tool",
        lambda request: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    loop_run = _make_loop_run()

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())  # must not raise

    assert loop_run.checkpoint_created is True


def test_maybe_create_auto_checkpoint_uses_request_cancel_and_deadline(monkeypatch):
    calls = []
    handle = TurnCancellationHandle(request_id="req1")
    monkeypatch.setattr(
        _auto_ckpt,
        "execute_electron_tool",
        lambda request: calls.append(request) or SimpleNamespace(success=True, metadata={}),
    )
    loop_run = _make_loop_run(
        cancel_handle=handle,
        wall_clock_deadline=time.monotonic() + 0.5,
    )

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert calls[0].cancel_handle is handle
    assert 0 < calls[0].timeout_seconds <= 0.5


def test_maybe_create_auto_checkpoint_does_not_swallow_terminal_cancel(monkeypatch):
    handle = TurnCancellationHandle(request_id="req1")
    handle.cancel(reason="sidecar_cancel")
    loop_run = _make_loop_run(cancel_handle=handle)
    monkeypatch.setattr(
        _auto_ckpt,
        "execute_electron_tool",
        lambda _request: pytest.fail("cancelled checkpoint must not dispatch"),
    )

    with pytest.raises(TerminalChatStateError):
        maybe_create_auto_checkpoint(loop_run, _mutating_remaining())
