"""Red-first: the python_execute bootstrap deadline (W4).

The full bootstrap budget (lock 300s + venv 120s + install 120s) exceeds any
plausible turn watchdog — the 242-second surprise from the W0 baseline. A
deadline derived from the request bounds it: when the deadline has already
passed, ensure_runtime_venv fails fast with `limit_exceeded` in the
`bootstrap` phase instead of starting work it cannot finish.
"""

from __future__ import annotations

import inspect
import json
import os
import time
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins.python_runtime import interpreter
from sidecar.ai.tools.builtins.python_runtime.interpreter import ensure_runtime_venv
from sidecar.ai.tools.contracts import ToolExecutionFailure


def _config(tmp_path) -> SimpleNamespace:
    return SimpleNamespace(
        tools_python_runtime_enabled=True,
        # The key interpreter._venv_root actually reads; a wrong key here sends
        # the test to the user-level runtime venv, whose ready fast path is
        # deadline-exempt by design and silently defeats the raise assertion.
        tools_python_runtime_root=str(tmp_path / "runtime"),
        tools_workspace_root=str(tmp_path),
    )


def test_elapsed_deadline_fails_fast_with_limit_exceeded(tmp_path) -> None:
    started = time.perf_counter()
    with pytest.raises(ToolExecutionFailure) as exc_info:
        ensure_runtime_venv(
            _config(tmp_path),
            deadline_monotonic=time.monotonic() - 1.0,
        )
    elapsed = time.perf_counter() - started
    assert elapsed < 2.0  # fail fast, no build attempt
    details = exc_info.value.to_error_data()
    assert details.get("failure_class") == "limit_exceeded"
    assert details.get("failed_phase") == "bootstrap"
    assert (tmp_path / "runtime").exists() is False or not any(
        (tmp_path / "runtime").rglob("pyvenv.cfg")
    )


def test_no_deadline_keeps_the_existing_signature_working(tmp_path, monkeypatch) -> None:
    # Pre-W4 callers pass only config; the kwarg must be optional. Pin the
    # signature directly (a swallowed TypeError proved nothing) and stub the
    # build so this never reaches a real venv or the network.
    parameter = inspect.signature(ensure_runtime_venv).parameters["deadline_monotonic"]
    assert parameter.default is None
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY

    def fake_create(_config, target, **_kwargs):
        python = target / "Scripts" / "python.exe"
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_text("", encoding="utf-8")
        return python

    monkeypatch.setattr(interpreter, "_create_runtime_venv", fake_create)
    monkeypatch.setattr(interpreter, "_validate_runtime_imports", lambda *_a, **_k: True)
    monkeypatch.setattr(interpreter, "_interpreter_identity", lambda _path: "3.13.14")
    interpreter._READY_VENV_CACHE.clear()  # noqa: SLF001

    result = ensure_runtime_venv(_config(tmp_path))

    assert result == tmp_path / "runtime" / "venv" / "Scripts" / "python.exe"


def test_lock_wait_ends_at_the_deadline_with_limit_exceeded(tmp_path, monkeypatch) -> None:
    """Waiting for a sibling's lock must not spend a budget the caller no
    longer has: the wait stops at the deadline and reports limit_exceeded,
    not a bare lock timeout 300s later."""
    config = _config(tmp_path)
    lock_path = interpreter._lock_path(interpreter._venv_dir(config))  # noqa: SLF001
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # A live foreign owner (the test runner's parent) with a fresh lock.
    lock_path.write_text(
        json.dumps({"pid": os.getppid(), "created_at": time.time()}), encoding="utf-8"
    )
    monkeypatch.setattr(
        interpreter,
        "_create_runtime_venv",
        lambda *_a, **_k: pytest.fail("must not build while the lock is held"),
    )
    interpreter._READY_VENV_CACHE.clear()  # noqa: SLF001

    started = time.perf_counter()
    with pytest.raises(ToolExecutionFailure) as exc_info:
        ensure_runtime_venv(config, deadline_monotonic=time.monotonic() + 0.6)
    elapsed = time.perf_counter() - started

    assert elapsed < 5.0, f"the wait must stop at the deadline, took {elapsed:.1f}s"
    details = exc_info.value.to_error_data()
    assert details.get("failure_class") == "limit_exceeded"
    assert details.get("failed_phase") == "bootstrap"
    assert lock_path.exists(), "a foreign live lock must not be reclaimed"
