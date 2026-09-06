"""Budgeted, subprocess-isolated regex evaluation for the monitor salience gate.

CPython's ``re`` engine holds the GIL for the entire duration of a single match,
so a catastrophically backtracking caller-supplied pattern does not merely stall
the monitor that owns it -- it freezes every thread in the sidecar process. The
static pre-filter in ``sidecar.ai.tools.builtins.regex_safety`` rejects the
obvious shapes but cannot promise anything about the rest, so the only real
bound is to evaluate the pattern somewhere the evaluation can be abandoned: a
spawned child process whose reply is awaited with a timeout and which is killed
outright once the monitor's budget is spent.

This mirrors the ``_RegexSearchWorker`` shape in
``sidecar.ai.tools.builtins.grep_search`` and is deliberately NOT shared with it.
A ``spawn`` child re-imports the module that defines its entry point, so keeping
this module stdlib-only keeps the monitor's child cheap instead of dragging the
whole tool-builtin import graph into every monitor; and the grep builtin keeps
its own request/response protocol and its ``ToolExecutionFailure`` error
contract, neither of which the runtime monitor wants.
"""

from __future__ import annotations

import math
import multiprocessing
import re
import time
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

MONITOR_SALIENCE_BUDGET_SECONDS = 2.0
"""Per-monitor lifetime budget of regex *search* time (not wall clock)."""

_SALIENCE_WORKER_STARTUP_TIMEOUT_SECONDS = 15.0
_WORKER_JOIN_TIMEOUT_SECONDS = 0.2
# Floor for a single evaluation's poll timeout so a nearly-spent budget cannot
# spuriously time out a pattern that would have finished in microseconds.
_MIN_EVALUATE_TIMEOUT_SECONDS = 0.25
_WORKER_READY_MESSAGE = {"status": "ready"}
_WORKER_ERROR_MESSAGE = {"status": "error"}

PatternSpec = tuple[str, int]


@dataclass(frozen=True)
class SalienceVerdict:
    """One line's regex verdict plus the search time it actually cost."""

    ignored: bool
    matched: bool
    elapsed_seconds: float


def _compile_specs(specs: Iterable[Any]) -> list[re.Pattern[str]]:
    compiled: list[re.Pattern[str]] = []
    for spec in specs:
        pattern, flags = spec
        compiled.append(re.compile(str(pattern), int(flags)))
    return compiled


def _evaluate_text(
    text: str,
    *,
    ignore_patterns: Sequence[re.Pattern[str]],
    match_patterns: Sequence[re.Pattern[str]],
) -> dict[str, Any]:
    """Run the salience patterns over *text*, timing only the searches.

    Mirrors the production gate's short-circuit order: ignore wins, so a line
    that is ignored never pays for the match patterns. ``matched`` is then
    meaningless (reported ``False``) because the caller never consults it.
    """
    started = time.perf_counter()
    ignored = any(regex.search(text) for regex in ignore_patterns)
    matched = False
    if not ignored:
        matched = not match_patterns or any(regex.search(text) for regex in match_patterns)
    elapsed_seconds = max(0.0, time.perf_counter() - started)
    return {"ignored": ignored, "matched": matched, "elapsed_seconds": elapsed_seconds}


def _salience_worker_main(connection: Any) -> None:
    """Child entry point: compile once, then answer one line per round trip."""
    try:
        init = connection.recv()
    except (BrokenPipeError, EOFError, OSError):
        return
    try:
        ignore_patterns = _compile_specs((init or {}).get("ignore") or ())
        match_patterns = _compile_specs((init or {}).get("match") or ())
        connection.send(_WORKER_READY_MESSAGE)
    except (AttributeError, TypeError, ValueError, re.error):
        _send_quietly(connection, _WORKER_ERROR_MESSAGE)
        return
    except (BrokenPipeError, EOFError, OSError):
        return
    while True:
        try:
            text = connection.recv()
        except (BrokenPipeError, EOFError, OSError):
            return
        if text is None:
            return
        try:
            reply = _evaluate_text(
                str(text),
                ignore_patterns=ignore_patterns,
                match_patterns=match_patterns,
            )
        except Exception:  # noqa: BLE001 - never let the child die on one odd line
            reply = dict(_WORKER_ERROR_MESSAGE)
        if not _send_quietly(connection, reply):
            return


def _send_quietly(connection: Any, payload: dict[str, Any]) -> bool:
    try:
        connection.send(payload)
    except (BrokenPipeError, EOFError, OSError):
        return False
    return True


def _coerce_elapsed(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    elapsed = float(value)
    if not math.isfinite(elapsed):
        return 0.0
    return max(0.0, elapsed)


class MonitorSalienceWorker:
    """Spawned child that evaluates one monitor's salience patterns on demand."""

    def __init__(
        self,
        *,
        ignore_specs: Iterable[PatternSpec],
        match_specs: Iterable[PatternSpec],
        ctx: Any | None = None,
    ) -> None:
        self._ignore_specs: list[PatternSpec] = [
            (str(pattern), int(flags)) for pattern, flags in ignore_specs
        ]
        self._match_specs: list[PatternSpec] = [
            (str(pattern), int(flags)) for pattern, flags in match_specs
        ]
        self._ctx = ctx or multiprocessing.get_context("spawn")
        self._parent_conn: Any | None = None
        self._process: Any | None = None

    def evaluate(self, text: str, *, timeout_seconds: float) -> SalienceVerdict:
        """Return the verdict for *text*, or raise if it outran *timeout_seconds*.

        Raises ``TimeoutError`` when the child did not answer in time (the child is
        killed first, so a wedged evaluation cannot leak) and ``RuntimeError`` for
        any transport or protocol failure.
        """
        self._ensure_started()
        parent_conn = self._parent_conn
        process = self._process
        if parent_conn is None or process is None:  # pragma: no cover - defensive
            raise RuntimeError("monitor salience worker failed to start")
        try:
            parent_conn.send(str(text))
            if not parent_conn.poll(max(0.0, float(timeout_seconds))):
                alive = self._is_alive(process)
                self._reset(force=True)
                if not alive:
                    raise RuntimeError("monitor salience worker exited unexpectedly")
                raise TimeoutError("monitor salience evaluation exceeded its budget")
            response = parent_conn.recv()
        except (TimeoutError, RuntimeError):
            raise
        except (BrokenPipeError, EOFError, OSError) as error:
            self._reset(force=True)
            raise RuntimeError(
                f"monitor salience worker communication failed: {error}"
            ) from error
        # A partial reply is protocol drift, not a verdict: defaulting the missing
        # fields would suppress the line under an allow-list, so fail open instead.
        if not isinstance(response, dict) or not all(
            key in response for key in ("ignored", "matched", "elapsed_seconds")
        ):
            self._reset(force=True)
            raise RuntimeError("monitor salience worker returned an invalid response")
        return SalienceVerdict(
            ignored=bool(response.get("ignored")),
            matched=bool(response.get("matched")),
            elapsed_seconds=_coerce_elapsed(response.get("elapsed_seconds")),
        )

    def close(self) -> None:
        self._reset(force=False)

    def _ensure_started(self) -> None:
        if (
            self._process is not None
            and self._parent_conn is not None
            and self._is_alive(self._process)
        ):
            return
        self._reset(force=True)
        parent_conn: Any | None = None
        child_conn: Any | None = None
        process: Any | None = None
        process_started = False
        try:
            parent_conn, child_conn = self._ctx.Pipe()
            process = self._ctx.Process(target=_salience_worker_main, args=(child_conn,))
            process.daemon = True
            process.start()
            process_started = True
            if hasattr(child_conn, "close"):
                child_conn.close()
        except Exception:
            self._cleanup_failed_start(
                parent_conn,
                child_conn,
                process,
                process_started=process_started,
            )
            raise
        assert parent_conn is not None
        assert process is not None
        self._parent_conn = parent_conn
        self._process = process
        try:
            parent_conn.send({"ignore": self._ignore_specs, "match": self._match_specs})
            # Startup is runtime overhead, never charged to the pattern budget.
            if not parent_conn.poll(_SALIENCE_WORKER_STARTUP_TIMEOUT_SECONDS):
                message = (
                    "monitor salience worker exited during startup"
                    if not self._is_alive(process)
                    else "monitor salience worker startup timed out"
                )
                self._reset(force=True)
                raise RuntimeError(message)
            ready_message = parent_conn.recv()
        except RuntimeError:
            raise
        except (BrokenPipeError, EOFError, OSError) as error:
            self._reset(force=True)
            raise RuntimeError(f"monitor salience worker startup failed: {error}") from error
        if ready_message != _WORKER_READY_MESSAGE:
            self._reset(force=True)
            raise RuntimeError("monitor salience worker returned an invalid readiness response")

    def _cleanup_failed_start(
        self,
        parent_conn: Any | None,
        child_conn: Any | None,
        process: Any | None,
        *,
        process_started: bool,
    ) -> None:
        for connection in (parent_conn, child_conn):
            if connection is not None and hasattr(connection, "close"):
                connection.close()
        if process is None:
            return
        was_alive = self._is_alive(process)
        if was_alive:
            process.terminate()
        if process_started or was_alive:
            process.join(_WORKER_JOIN_TIMEOUT_SECONDS)
        if hasattr(process, "close"):
            try:
                process.close()
            except ValueError:
                pass

    def _reset(self, *, force: bool) -> None:
        parent_conn = self._parent_conn
        process = self._process
        self._parent_conn = None
        self._process = None
        if parent_conn is not None:
            if not force:
                try:
                    parent_conn.send(None)
                except (BrokenPipeError, EOFError, OSError):
                    pass
            if hasattr(parent_conn, "close"):
                parent_conn.close()
        if process is not None:
            if force and self._is_alive(process):
                process.terminate()
                process.join(_WORKER_JOIN_TIMEOUT_SECONDS)
                if self._is_alive(process) and hasattr(process, "kill"):
                    process.kill()
            process.join(_WORKER_JOIN_TIMEOUT_SECONDS)
            if hasattr(process, "close"):
                try:
                    process.close()
                except ValueError:
                    pass

    @staticmethod
    def _is_alive(process: Any) -> bool:
        try:
            return bool(process.is_alive())
        except AssertionError:
            return False


__all__ = [
    "MONITOR_SALIENCE_BUDGET_SECONDS",
    "MonitorSalienceWorker",
    "PatternSpec",
    "SalienceVerdict",
]
