"""Streaming, output-batching, and status-persistence surface for MonitorManager."""

from __future__ import annotations

import logging
import subprocess
import threading
import time
from typing import TYPE_CHECKING, Any, BinaryIO, Callable, TextIO

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import sanitize_tool_output
from sidecar.runtime.monitor_manager_shared import (
    MAX_MONITOR_EVENT_CHARS,
    MAX_MONITOR_EVENTS,
    MAX_MONITOR_OUTPUT_BATCH,
    MONITOR_OUTPUT_FLUSH_INTERVAL_SECONDS,
    MONITOR_RECORD_VERSION,
    _ActiveMonitor,
    _clip_text,
    _utc_now_iso,
)
from sidecar.runtime.monitor_salience import (
    _MIN_EVALUATE_TIMEOUT_SECONDS,
    MONITOR_SALIENCE_BUDGET_SECONDS,
    SalienceVerdict,
)
from sidecar.runtime.monitor_status import MonitorStatusError, MonitorStatusStore

logger = logging.getLogger(__name__)
_MAX_MONITOR_STREAM_LINE_UNITS = MAX_MONITOR_EVENT_CHARS * 4


def _read_monitor_line(stream: BinaryIO | TextIO) -> bytes | str:
    line = stream.readline(_MAX_MONITOR_STREAM_LINE_UNITS + 1)
    if not isinstance(line, (bytes, str)):
        raise RuntimeError("monitor stream returned an unsupported value")
    has_newline = (
        line.endswith(b"\n")
        if isinstance(line, bytes)
        else line.endswith("\n")
    )
    if len(line) > _MAX_MONITOR_STREAM_LINE_UNITS or (
        len(line) == _MAX_MONITOR_STREAM_LINE_UNITS
        and not has_newline
    ):
        raise RuntimeError("monitor stream line exceeded its configured limit")
    return line


class _MonitorStreamingMixin:
    # Host state owned by ``MonitorManager.__init__`` (the hub). These bare
    # annotations have zero runtime effect; they only tell mypy the concrete
    # instance will carry these attributes, since the mixin is type-checked
    # independently of the hub that assigns them.
    _active: dict[str, _ActiveMonitor]
    _active_lock: threading.Lock
    _status_store: MonitorStatusStore
    _closed: bool
    _salience_worker_factory: Callable[[_ActiveMonitor], Any]

    if TYPE_CHECKING:
        # Methods implemented on the hub / sibling mixin. TYPE_CHECKING is False
        # at runtime, so these stubs never execute and cannot shadow the real
        # implementations resolved through the MRO.
        def _notify(self, active: _ActiveMonitor, event: dict[str, object]) -> None: ...

        def _prune_terminal_status_dirs(self) -> None: ...

    def _run_monitor(self, active: _ActiveMonitor) -> None:
        import sidecar.runtime.monitor_manager as _mm_hub

        job = active.job
        if job is None:
            return
        reader_threads = [
            threading.Thread(
                target=self._read_stream,
                args=(active, "stdout", job.process.stdout),
                name=f"{active.monitor_id}-stdout",
                daemon=True,
            ),
            threading.Thread(
                target=self._read_stream,
                args=(active, "stderr", job.process.stderr),
                name=f"{active.monitor_id}-stderr",
                daemon=True,
            ),
        ]
        started_reader_threads: list[threading.Thread] = []
        exit_code: int | None = None
        state = "completed"
        terminal_reason = "exit"
        success = True
        try:
            for thread in reader_threads:
                thread.start()
                started_reader_threads.append(thread)
            exit_code = job.process.wait(timeout=active.timeout_ms / 1000)
            if exit_code != 0:
                state = "failed"
                success = False
            # The root was reaped by the direct wait above, so release the
            # owned-process capacity lease (spawn acquired it; only the
            # timeout/error paths reach the terminate wrapper that frees it —
            # without this, every clean monitor exit leaks one of the service's
            # max_active slots for the sidecar's lifetime). Release, not
            # terminate: signalling the reaped PID could hit a recycled PID.
            _mm_hub.release_managed_background_process(job)
        except subprocess.TimeoutExpired:
            _mm_hub.terminate_managed_background_process(job, timeout_seconds=1.0)
            exit_code = job.process.returncode
            state = "timeout"
            terminal_reason = "timeout"
            success = False
        except Exception:  # noqa: BLE001
            _mm_hub.terminate_managed_background_process(job, timeout_seconds=1.0)
            exit_code = job.process.returncode
            state = "failed"
            terminal_reason = "process_error"
            success = False

        for thread in started_reader_threads:
            thread.join(timeout=1.0)
        self._finish_active(
            active,
            state=state,
            terminal_reason=terminal_reason,
            exit_code=exit_code,
            success=success,
        )

    def _read_stream(
        self,
        active: _ActiveMonitor,
        stream_name: str,
        stream: BinaryIO | TextIO | None,
    ) -> None:
        import sidecar.runtime.monitor_manager as _mm_hub

        if stream is None:
            return
        try:
            while True:
                raw_line = _read_monitor_line(stream)
                if not raw_line:
                    return
                # The owned-process service hands us binary stdout/stderr pipes.
                # Decode before recording so streamed bytes are not stringified
                # into Python reprs such as ``b'LINE\\r\\n'``.
                text_line = (
                    raw_line.decode("utf-8", errors="replace")
                    if isinstance(raw_line, bytes)
                    else raw_line
                )
                safe_line = sanitize_tool_output(
                    text_line,
                    max_chars=MAX_MONITOR_EVENT_CHARS,
                    tool_name="monitor",
                )
                self._record_output_event(active, stream=stream_name, text=safe_line)
        except Exception:  # noqa: BLE001
            job = active.job
            if job is not None:
                _mm_hub.terminate_managed_background_process(job, timeout_seconds=1.0)
            _mm_hub.log_event(
                logger,
                logging.DEBUG,
                component="runtime.monitor",
                event="monitor.stream_read_failed",
                message="Monitor stream read failed and its owned process was terminated.",
                status="failure",
                data={"monitor_id": active.monitor_id, "stream": stream_name},
                request_id=active.request_id,
                session_id=active.session_id,
            )

    @staticmethod
    def _is_suppressed_locked(
        active: _ActiveMonitor,
        stream: str,
        event_text: str,
        *,
        regex_suppressed: bool = False,
    ) -> bool:
        """Deterministic salience gate (call under ``active.lock``).

        Applied in order: dedupe (consecutive identical emitted lines per stream),
        then the regex verdict (ignore_patterns exclude, match_patterns allow-list;
        empty allow-list = all). Dedupe stays authoritative here because it reads
        mutable in-lock state; the regex half is precomputed by
        ``_evaluate_salience`` outside this lock, in a budgeted subprocess, because
        ``re`` holds the GIL for a whole match.
        """
        if active.dedupe and active.last_emitted_text.get(stream) == event_text:
            return True
        return regex_suppressed

    def _evaluate_salience(self, active: _ActiveMonitor, stream: str, event_text: str) -> bool:
        """Return the regex half of the salience verdict, computed off ``active.lock``.

        The caller/model-supplied patterns run in a spawned child process under a
        per-monitor lifetime budget of search time. When that budget is spent (or
        the worker fails) the gate latches OFF and events pass through unfiltered:
        losing salience filtering is strictly better than losing the output, and a
        wedged pattern must never be able to freeze the sidecar's other threads.
        """
        if not active.match_patterns and not active.ignore_patterns:
            return False
        # Consecutive duplicates are already suppressed by the in-lock dedupe check,
        # so evaluating them would burn budget for nothing. Reading
        # ``last_emitted_text[stream]`` unlocked is safe: that key has exactly one
        # writer -- this same per-stream reader thread.
        if active.dedupe and active.last_emitted_text.get(stream) == event_text:
            return False
        with active.salience_lock:
            return self._evaluate_salience_locked(active, event_text)

    def _evaluate_salience_locked(self, active: _ActiveMonitor, event_text: str) -> bool:
        """Evaluate one line under ``active.salience_lock``.

        The lock serializes the stdout and stderr reader threads, which share one
        worker and one budget; it is deliberately not ``active.lock``.
        """
        worker = self._salience_worker_locked(active)
        if worker is None:
            return False
        verdict = self._salience_verdict_locked(active, worker, event_text)
        if verdict is None:
            return False
        # Only the worker-reported search time is charged. Spawn startup and IPC
        # round-trip overhead are the runtime's cost, not the pattern's.
        active.salience_budget_spent_seconds += max(0.0, verdict.elapsed_seconds)
        if active.salience_budget_spent_seconds >= MONITOR_SALIENCE_BUDGET_SECONDS:
            # This verdict still applies; pass-through starts with the next line.
            self._disable_salience_gate_locked(active, reason="budget_exhausted")
        if verdict.ignored:
            return True
        return bool(active.match_patterns) and not verdict.matched

    def _salience_worker_locked(self, active: _ActiveMonitor) -> Any | None:
        """Return this monitor's live worker, or None if the gate is now latched off."""
        # A reader thread can still be draining buffered pipe lines after the
        # monitor went terminal (``_run_monitor`` joins readers with a 1s timeout).
        # Such a line is dropped by the in-lock terminal check in
        # ``_record_output_event`` anyway, and ``_finish_active`` has already reaped
        # (or is about to reap, behind this same salience_lock) the worker -- so
        # evaluating it would only leak a freshly spawned child nothing will reap.
        # ``_finish_active`` sets ``terminal_event`` under ``active.lock`` BEFORE it
        # acquires ``salience_lock`` to reap, so any evaluation that slips past this
        # check while termination is in flight holds ``salience_lock``, and the reap
        # that follows it collects whatever worker it created.
        if active.terminal_status is not None or active.terminal_event.is_set():
            return None
        if active.salience_gate_disabled:
            return None
        if active.salience_worker is None:
            try:
                active.salience_worker = self._salience_worker_factory(active)
            except Exception:  # noqa: BLE001 - any spawn failure fails the gate open
                self._disable_salience_gate_locked(active, reason="worker_failed")
                return None
        if MONITOR_SALIENCE_BUDGET_SECONDS - active.salience_budget_spent_seconds <= 0:
            self._disable_salience_gate_locked(active, reason="budget_exhausted")
            return None
        return active.salience_worker

    def _salience_verdict_locked(
        self,
        active: _ActiveMonitor,
        worker: Any,
        event_text: str,
    ) -> SalienceVerdict | None:
        """Ask *worker* for one verdict, latching the gate off on timeout/failure."""
        remaining = MONITOR_SALIENCE_BUDGET_SECONDS - active.salience_budget_spent_seconds
        try:
            verdict: SalienceVerdict = worker.evaluate(
                event_text,
                timeout_seconds=max(remaining, _MIN_EVALUATE_TIMEOUT_SECONDS),
            )
        except TimeoutError:
            active.salience_budget_spent_seconds = MONITOR_SALIENCE_BUDGET_SECONDS
            self._disable_salience_gate_locked(active, reason="budget_exhausted")
            return None
        except Exception:  # noqa: BLE001 - transport/protocol failures fail open too
            self._disable_salience_gate_locked(active, reason="worker_failed")
            return None
        return verdict

    def _disable_salience_gate_locked(self, active: _ActiveMonitor, *, reason: str) -> None:
        """Latch the salience gate off (call under ``active.salience_lock``)."""
        import sidecar.runtime.monitor_manager as _mm_hub

        if active.salience_gate_disabled:
            return
        active.salience_gate_disabled = True
        active.salience_gate_disabled_reason = reason
        self._close_salience_worker_locked(active)
        _mm_hub.log_event(
            logger,
            logging.WARNING,
            component="runtime.monitor",
            event="monitor.salience_gate_disabled",
            message="Monitor salience gate disabled; events now pass through unfiltered.",
            status="failure",
            data={
                "monitor_id": active.monitor_id,
                "reason": reason,
                "budget_seconds": MONITOR_SALIENCE_BUDGET_SECONDS,
                "spent_seconds": round(active.salience_budget_spent_seconds, 3),
            },
            request_id=active.request_id,
            session_id=active.session_id,
        )

    @staticmethod
    def _close_salience_worker_locked(active: _ActiveMonitor) -> None:
        worker = active.salience_worker
        active.salience_worker = None
        if worker is None:
            return
        try:
            worker.close()
        except Exception:  # noqa: BLE001 - teardown must never raise into a reader
            return

    def _close_salience_worker(self, active: _ActiveMonitor) -> None:
        with active.salience_lock:
            self._close_salience_worker_locked(active)

    def _record_output_event(self, active: _ActiveMonitor, *, stream: str, text: str) -> None:
        event_text = _clip_text(text)
        if not event_text:
            return
        # Evaluated OUTSIDE active.lock: a blocked worker call would otherwise stall
        # every status writer and poll reader waiting on that lock.
        regex_suppressed = self._evaluate_salience(active, stream, event_text)
        batch: dict[str, object] | None = None
        with active.lock:
            if active.terminal_status is not None or active.terminal_event.is_set():
                return
            active.event_count += 1
            if self._is_suppressed_locked(
                active,
                stream,
                event_text,
                regex_suppressed=regex_suppressed,
            ):
                active.suppressed_event_count += 1
                return
            active.last_emitted_text[stream] = event_text
            active.sequence += 1
            event = {
                "sequence": active.sequence,
                "kind": "output",
                "stream": stream,
                "text": event_text,
                "timestamp": _utc_now_iso(),
                "elapsed_ms": self._elapsed_ms(active),
            }
            active.events.append(event)
            if len(active.events) > MAX_MONITOR_EVENTS:
                dropped = len(active.events) - MAX_MONITOR_EVENTS
                active.events = active.events[dropped:]
                active.dropped_event_count += dropped
            active.pending_output_events.append(event)
            if len(active.pending_output_events) >= MAX_MONITOR_OUTPUT_BATCH:
                batch = self._take_pending_output_batch_locked(active)
            elif active.output_flush_timer is None:
                timer = threading.Timer(
                    MONITOR_OUTPUT_FLUSH_INTERVAL_SECONDS,
                    self._flush_output_events,
                    args=(active,),
                )
                timer.daemon = True
                active.output_flush_timer = timer
                timer.start()
        if batch is not None:
            self._safe_write_status(active)
            self._notify(active, batch)

    def _take_pending_output_batch_locked(
        self,
        active: _ActiveMonitor,
    ) -> dict[str, object] | None:
        if active.output_flush_timer is not None:
            active.output_flush_timer.cancel()
            active.output_flush_timer = None
        if not active.pending_output_events:
            return None
        events = [dict(event) for event in active.pending_output_events]
        active.pending_output_events.clear()
        return {
            "sequence": events[-1]["sequence"],
            "kind": "output_batch",
            "events": events,
            "timestamp": _utc_now_iso(),
            "elapsed_ms": self._elapsed_ms(active),
            "event_count": active.event_count,
            "dropped_event_count": active.dropped_event_count,
            "suppressed_event_count": active.suppressed_event_count,
            "salience_gate_disabled": active.salience_gate_disabled,
            "salience_gate_disabled_reason": active.salience_gate_disabled_reason,
        }

    def _flush_output_events(self, active: _ActiveMonitor) -> None:
        with active.lock:
            batch = self._take_pending_output_batch_locked(active)
        if batch is not None:
            self._safe_write_status(active)
            self._notify(active, batch)

    def _terminate_active(self, active: _ActiveMonitor, *, reason: str) -> None:
        import sidecar.runtime.monitor_manager as _mm_hub

        job = active.job
        if job is not None:
            _mm_hub.terminate_managed_background_process(job, timeout_seconds=1.0)
        self._finish_active(
            active,
            state="cancelled" if reason == "cancelled" else "failed",
            terminal_reason=reason,
            exit_code=job.process.returncode if job is not None else None,
            success=False,
        )

    def _finish_active(
        self,
        active: _ActiveMonitor,
        *,
        state: str,
        terminal_reason: str,
        exit_code: int | None,
        success: bool,
    ) -> None:
        batch: dict[str, object] | None = None
        # Reap #1, BEFORE the snapshot: this blocks on salience_lock until any
        # in-flight evaluation finishes, so (a) the terminal snapshot below sees a
        # latch that evaluation set, and (b) the line it judged reaches active.lock
        # in a fair race instead of being guaranteed-dropped. Costs nothing extra:
        # reap #2 already blocked on the same lock for the same bounded time.
        self._close_salience_worker(active)
        with active.lock:
            if active.terminal_status is not None or active.terminal_event.is_set():
                return
            batch = self._take_pending_output_batch_locked(active)
            active.sequence += 1
            active.state = state
            active.terminal_reason = terminal_reason
            active.exit_code = exit_code
            active.success = success
            terminal = self._terminal_status(active)
            active.terminal_status = terminal
            active.terminal_event.set()
            self._safe_write_status(active)
        # Reap #2: collects a worker respawned in the window between reap #1 and
        # terminal_event.set(), since the respawn guard in _salience_worker_locked
        # only engages once terminal is set. Usually a no-op. Every termination path
        # (exit, timeout, cancel, close, shutdown) funnels through here, so this
        # pair is the only place the spawned worker is reaped.
        self._close_salience_worker(active)
        with self._active_lock:
            if self._active.get(active.monitor_id) is active:
                self._active.pop(active.monitor_id, None)
        self._prune_terminal_status_dirs()
        if batch is not None:
            self._notify(active, batch)
        self._notify(active, terminal)

    def _metadata(self, active: _ActiveMonitor) -> dict[str, object]:
        with active.lock:
            return {
                "version": MONITOR_RECORD_VERSION,
                "monitor_id": active.monitor_id,
                "description": active.description,
                "state": active.state,
                "persistent": active.persistent,
                "timeout_ms": active.timeout_ms,
                "event_count": active.event_count,
                "dropped_event_count": active.dropped_event_count,
                "suppressed_event_count": active.suppressed_event_count,
                "salience_gate_disabled": active.salience_gate_disabled,
                "salience_gate_disabled_reason": active.salience_gate_disabled_reason,
                "events": [dict(event) for event in active.events],
                "terminal_reason": active.terminal_reason,
                "exit_code": active.exit_code,
                "success": active.success,
                "started_at": active.started_at_iso,
            }

    def _status_payload(self, active: _ActiveMonitor) -> dict[str, object]:
        payload = self._metadata(active)
        payload.update(
            {
                "updated_at": _utc_now_iso(),
                "terminal": active.terminal_event.is_set() or active.terminal_status is not None,
            }
        )
        return payload

    def _terminal_status(self, active: _ActiveMonitor) -> dict[str, object]:
        return {
            "monitor_id": active.monitor_id,
            "sequence": active.sequence,
            "kind": "terminal",
            "state": active.state,
            "terminal": True,
            "terminal_reason": active.terminal_reason,
            "success": bool(active.success),
            "exit_code": active.exit_code,
            "suppressed_event_count": active.suppressed_event_count,
            "salience_gate_disabled": active.salience_gate_disabled,
            "salience_gate_disabled_reason": active.salience_gate_disabled_reason,
            "timestamp": _utc_now_iso(),
            "elapsed_ms": self._elapsed_ms(active),
        }

    def _elapsed_ms(self, active: _ActiveMonitor) -> int:
        return max(0, int((time.monotonic() - active.started_at) * 1000))

    def _write_status(self, active: _ActiveMonitor) -> None:
        self._write_status_payload(active.monitor_id, self._status_payload(active))

    def _safe_write_status(self, active: _ActiveMonitor) -> None:
        import sidecar.runtime.monitor_manager as _mm_hub

        try:
            self._write_status(active)
        except (MonitorStatusError, OSError):
            _mm_hub.log_event(
                logger,
                logging.WARNING,
                component="runtime.monitor",
                event="monitor.status_persist_failed",
                message="Failed to persist monitor status.",
                status="failure",
                data={"monitor_id": active.monitor_id},
                request_id=active.request_id,
                session_id=active.session_id,
            )
            return
        self._prune_terminal_status_dirs()

    def _raise_if_closed(self) -> None:
        with self._active_lock:
            closed = self._closed
        if closed:
            raise ToolExecutionFailure(
                code=CMP_TOOL_EXECUTION_FAILED,
                message="monitor manager is closed",
                retryable=False,
            )

    def _write_status_payload(
        self,
        monitor_id: str,
        payload: dict[str, object],
    ) -> None:
        self._status_store.write(monitor_id, payload)

    def _read_status(self, monitor_id: str) -> dict[str, object] | None:
        try:
            return self._status_store.read(monitor_id)
        except (MonitorStatusError, ValueError) as error:
            raise ToolExecutionFailure(
                code=CMP_TOOL_EXECUTION_FAILED,
                message="monitor status record is invalid or unsafe",
                retryable=False,
            ) from error
