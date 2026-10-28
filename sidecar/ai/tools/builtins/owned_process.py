"""Bounded, contained ownership for sidecar tool subprocesses.

Every process started here owns a concurrency lease, a supervised POSIX process
group or Windows Job Object, and concurrent bounded drains for stdout and stderr.  The
service never calls ``communicate()`` and never retains more than the configured
aggregate capture budget, while still counting all drained bytes.
"""

from __future__ import annotations

import atexit
import logging
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any, Callable, Mapping, Sequence

from sidecar._owned_process_supervisor import (
    LINEAGE_CONTAINMENT,
    READY_FD_ENVIRONMENT_VARIABLE,
    SUPERVISOR_TEARDOWN_MARGIN_SECONDS,
    supervisor_command,
    supervisor_containment,
)
from sidecar.ai.tools.builtins.owned_process_capture import (
    CapturedProcessOutput,
    StreamCapture,
    captured_output_with_diagnostics,
    start_output_reader,
)
from sidecar.ai.tools.builtins.owned_process_drain import close_process_pipes
from sidecar.ai.tools.builtins.owned_process_observation import (
    create_process_cleanup_observer,
)
from sidecar.ai.tools.builtins.owned_process_settlement import (
    CleanupObservation,
    CleanupObserver,
    OwnedProcessCleanupVerdict,
)
from sidecar.ai.tools.builtins.owned_process_windows import (
    WindowsJobObject,
    encode_windows_bootstrap_payload,
    release_windows_bootstrap_target,
    windows_bootstrap_command,
    windows_process_is_alive,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.external_child_env import external_child_environment

# The POSIX supervisor helpers load on first use so the module stays off the
# sidecar startup import path (the import budget counts modules, and Windows
# never calls them).


def preflight_posix_target(argv: Any, cwd: Any, env: Any) -> None:
    from sidecar.ai.tools.builtins import owned_process_posix as _posix

    _posix.preflight_posix_target(argv, cwd, env)


def await_supervisor_ready(owned: Any, timeout_seconds: float) -> None:
    from sidecar.ai.tools.builtins import owned_process_posix as _posix

    _posix.await_supervisor_ready(owned, timeout_seconds)


def supervisor_proved_cleanup(owned: Any) -> bool:
    from sidecar.ai.tools.builtins import owned_process_posix as _posix

    return _posix.supervisor_proved_cleanup(owned)

DEFAULT_MAX_ACTIVE_PROCESSES = 4
DEFAULT_MAX_QUEUED_PROCESSES = 8
DEFAULT_QUEUE_WAIT_SECONDS = 5.0
DEFAULT_MAX_CAPTURE_BYTES = 4 * 1024 * 1024
DEFAULT_TERMINATION_GRACE_SECONDS = 0.5
SUPERVISOR_READY_WAIT_SECONDS = 5.0
# Carried on a confirmed verdict whose sweep was sampled, not kernel-proven.
SAMPLED_LINEAGE_REASON = "sampled_lineage_best_effort"
MIN_CAPTURE_BYTES = 2
PIPE_DRAIN_GRACE_SECONDS = 1.0

logger = logging.getLogger(__name__)


class OwnedProcessError(RuntimeError):
    """Base class for process-owner failures."""


class OwnedProcessCapacityError(OwnedProcessError):
    """Raised when both active and queued process budgets are exhausted."""


class OwnedProcessShutdownError(OwnedProcessError):
    """Raised when a process start races service shutdown."""


class OwnedProcessAbortedBeforeStart(OwnedProcessError):
    """Raised when the caller's abort event fires before any child exists."""


@dataclass(frozen=True)
class ProcessCapacitySnapshot:
    active: int
    queued: int
    max_active: int
    max_queued: int
    shutting_down: bool


@dataclass(frozen=True)
class OwnedProcessResult:
    args: tuple[str, ...]
    returncode: int
    output: CapturedProcessOutput
    pid: int
    containment: str
    duration_seconds: float
    timed_out: bool = False
    aborted: bool = False
    drain_incomplete: bool = False
    cleanup_verdict: OwnedProcessCleanupVerdict = field(
        default_factory=lambda: OwnedProcessCleanupVerdict(
            cleanup="uncertain",
            process_tree_terminated=False,
            output_readers_terminated=False,
            reason="cleanup_evidence_unavailable",
        )
    )

    @property
    def stdout(self) -> str:
        return self.output.stdout

    @property
    def stderr(self) -> str:
        return self.output.stderr


class _CapacityLease:
    def __init__(self, service: OwnedProcessService) -> None:
        self._service = service
        self._released = False
        self._lock = threading.Lock()

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._service._release_capacity()


@dataclass
class OwnedProcess:
    process: subprocess.Popen[bytes]
    args: tuple[str, ...]
    containment: str
    process_group_id: int | None
    job_object: WindowsJobObject | None
    _service: OwnedProcessService
    _lease: _CapacityLease
    _cleanup_observation: CleanupObservation = field(default_factory=CleanupObservation)
    _output_readers: tuple[threading.Thread, ...] = ()
    _finalized: bool = False
    _finalize_lock: threading.Lock = field(default_factory=threading.Lock)
    _supervisor_ready_fd: int | None = None
    _supervisor_report: bytes = b""
    _ledger_ticket: Any = None
    _supervisor_ready_lock: threading.Lock = field(default_factory=threading.Lock)


class OwnedProcessService:
    """Own child lifecycle, containment, capacity, and bounded output drains."""

    def __init__(
        self,
        *,
        max_active: int = DEFAULT_MAX_ACTIVE_PROCESSES,
        max_queued: int = DEFAULT_MAX_QUEUED_PROCESSES,
        max_capture_bytes: int = DEFAULT_MAX_CAPTURE_BYTES,
    ) -> None:
        if max_active < 1 or max_queued < 0 or max_capture_bytes < MIN_CAPTURE_BYTES:
            raise ValueError("owned process limits must be positive and bounded")
        self._max_active = int(max_active)
        self._max_queued = int(max_queued)
        self._max_capture_bytes = int(max_capture_bytes)
        self._condition = threading.Condition()
        self._active_count = 0
        self._queued_count = 0
        self._shutting_down = False
        self._active: dict[int, OwnedProcess] = {}

    def snapshot(self) -> ProcessCapacitySnapshot:
        with self._condition:
            return ProcessCapacitySnapshot(
                active=self._active_count,
                queued=self._queued_count,
                max_active=self._max_active,
                max_queued=self._max_queued,
                shutting_down=self._shutting_down,
            )

    def spawn(  # noqa: PLR0913 -- explicit process ownership contract.
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str] | None = None,
        allow_queue: bool = True,
        queue_timeout_seconds: float = DEFAULT_QUEUE_WAIT_SECONDS,
        on_cleanup: CleanupObserver | None = None,
        input_data: bytes | None = None,
        process_kind: str = "owned_process",
        abort_event: threading.Event | None = None,
    ) -> OwnedProcess:
        if not argv:
            raise ValueError("argv cannot be empty")
        if input_data is not None and not isinstance(input_data, bytes):
            raise TypeError("owned process input_data must be bytes or None")
        normalized_argv = tuple(str(argument) for argument in argv)
        # The bootstrap encoder owns the single 1 MiB launch-envelope bound on
        # every platform. On POSIX the supervisor inherits the sidecar's own
        # environment to start, so the target's environment travels in the
        # payload instead.
        bootstrap_payload = encode_windows_bootstrap_payload(
            normalized_argv,
            cwd=cwd,
            env=env if os.name == "nt" else external_child_environment(env),
            input_data=input_data,
        )
        if os.name != "nt":
            self._preflight_posix_target(normalized_argv, cwd, env)
        lease = self._acquire_capacity(
            allow_queue=allow_queue,
            timeout_seconds=max(0.0, float(queue_timeout_seconds)),
            abort_event=abort_event,
        )
        cleanup_observation = CleanupObservation(
            create_process_cleanup_observer(on_cleanup)
        )
        job_object: WindowsJobObject | None = None
        process_group_id: int | None = None
        owned: OwnedProcess | None = None
        process: subprocess.Popen[bytes] | None = None
        ready_fd: int | None = None
        try:
            containment = supervisor_containment()
            if os.name == "nt":
                job_object = WindowsJobObject()
                containment = "windows_job_object_bootstrap"
            process, ready_fd = self._start_transport(job_object)
            from sidecar.runtime import owned_process_tracking

            process_group_id = int(process.pid) if os.name != "nt" else None
            owned = OwnedProcess(
                process=process,
                args=normalized_argv,
                containment=containment,
                process_group_id=process_group_id,
                job_object=job_object,
                _service=self,
                _lease=lease,
                _cleanup_observation=cleanup_observation,
                _supervisor_ready_fd=ready_fd,
            )
            ready_fd = None
            # Recorded only once ``owned`` exists: a ledger failure must reach
            # the cancel path below, never orphan the live bootstrap child.
            owned._ledger_ticket = owned_process_tracking.record(process.pid, process_kind)
            with self._condition:
                self._active[id(owned)] = owned
                if self._shutting_down:
                    raise OwnedProcessShutdownError(
                        "owned process service is shutting down"
                    )
            self._release_bootstrap(job_object, process, bootstrap_payload)
            return owned
        except BaseException:
            if owned is not None:
                self.cancel(owned)
            else:
                if ready_fd is not None:
                    os.close(ready_fd)
                # A transport that started but never became ``owned`` has not
                # received its target payload yet, so it has no descendants:
                # reaping the root is the whole tree.
                reason: str | None = "no_child_started"
                transport_reaped = True
                if process is not None:
                    transport_reaped = self._kill_unowned_transport(process)
                    reason = None if transport_reaped else "process_tree_termination_unconfirmed"
                if job_object is not None:
                    try:
                        job_object.close()
                    except Exception:  # noqa: BLE001 - no child exists to quarantine.
                        logger.warning("empty owned Job handle cleanup degraded", exc_info=True)
                cleanup_observation.publish(
                    OwnedProcessCleanupVerdict(
                        cleanup="confirmed" if transport_reaped else "uncertain",
                        process_tree_terminated=transport_reaped,
                        output_readers_terminated=True,
                        reason=reason,
                    )
                )
                lease.release()
            raise

    @staticmethod
    def _kill_unowned_transport(process: subprocess.Popen[bytes]) -> bool:
        """Kill and reap a bootstrap transport that never became owned."""
        try:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=DEFAULT_TERMINATION_GRACE_SECONDS)
        except (OSError, subprocess.SubprocessError):
            logger.warning("unowned bootstrap transport cleanup degraded", exc_info=True)
            return False
        finally:
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe is not None:
                    try:
                        pipe.close()
                    except OSError:
                        pass
        return True

    @staticmethod
    def _start_transport(
        job_object: WindowsJobObject | None,
    ) -> tuple[subprocess.Popen[bytes], int | None]:
        """Start the trusted child that will receive the target over stdin.

        Both transports run it in the sidecar's own environment. The POSIX
        supervisor also gets the write end of a pipe on which it reports that
        its termination handlers are installed; the read end is returned.
        """
        if job_object is not None:
            return (
                subprocess.Popen(
                    windows_bootstrap_command(),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=False,
                    bufsize=0,
                    creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
                ),
                None,
            )
        ready_fd, ready_write_fd = os.pipe()
        try:
            process = subprocess.Popen(
                supervisor_command(),
                env={**os.environ, READY_FD_ENVIRONMENT_VARIABLE: str(ready_write_fd)},
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=False,
                bufsize=0,
                start_new_session=True,
                pass_fds=(ready_write_fd,),
            )
        except BaseException:
            os.close(ready_fd)
            raise
        finally:
            os.close(ready_write_fd)
        return process, ready_fd

    @staticmethod
    def _release_bootstrap(
        job_object: WindowsJobObject | None, process: subprocess.Popen, payload: bytes | None,
    ) -> None:
        if job_object is not None:
            job_object.assign_pid(int(process.pid))
        if process.stdin is None:
            raise OwnedProcessError("owned process bootstrap pipe is unavailable")
        if payload is None:
            raise OwnedProcessError("owned process bootstrap payload is unavailable")
        release_windows_bootstrap_target(process.stdin, payload)

    def run(  # noqa: PLR0913 - explicit process lifecycle contract.
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        timeout_seconds: float,
        env: Mapping[str, str] | None = None,
        abort_event: threading.Event | None = None,
        on_output_chunk: Callable[[str, bytes], None] | None = None,
        on_cleanup: CleanupObserver | None = None,
        input_data: bytes | None = None,
    ) -> OwnedProcessResult:
        try:
            # A call cancelled before or while it queues for capacity must not
            # spawn a child only to kill it.
            if abort_event is not None and abort_event.is_set():
                raise OwnedProcessAbortedBeforeStart("owned process start was aborted")
            owned = self.spawn(
                argv,
                cwd=cwd,
                env=env,
                allow_queue=True,
                queue_timeout_seconds=min(
                    max(0.0, float(timeout_seconds)), DEFAULT_QUEUE_WAIT_SECONDS
                ),
                on_cleanup=on_cleanup,
                input_data=input_data,
                abort_event=abort_event,
            )
        except OwnedProcessAbortedBeforeStart:
            return OwnedProcessResult(
                args=tuple(str(argument) for argument in argv),
                returncode=-1,
                output=CapturedProcessOutput("", "", 0, 0, 0, 0),
                pid=0,
                containment="not_started",
                duration_seconds=0.0,
                aborted=True,
                cleanup_verdict=OwnedProcessCleanupVerdict(
                    cleanup="confirmed",
                    process_tree_terminated=True,
                    output_readers_terminated=True,
                    reason="no_child_started",
                ),
            )
        return self.wait(
            owned,
            timeout_seconds=timeout_seconds,
            abort_event=abort_event,
            on_output_chunk=on_output_chunk,
        )

    def wait(  # noqa: C901, PLR0912, PLR0915 -- one owned lifecycle.
        self,
        owned: OwnedProcess,
        *,
        timeout_seconds: float,
        abort_event: threading.Event | None = None,
        on_output_chunk: Callable[[str, bytes], None] | None = None,
    ) -> OwnedProcessResult:
        process = owned.process
        if process.stdout is None or process.stderr is None:
            self.cancel(owned)
            raise OwnedProcessError("owned process pipes are unavailable")

        per_stream_limit = self._max_capture_bytes // 2
        stdout_capture = StreamCapture(per_stream_limit)
        stderr_capture = StreamCapture(self._max_capture_bytes - per_stream_limit)
        readers: list[threading.Thread] = []
        started_at = time.monotonic()
        timed_out = False
        aborted = False
        drain_incomplete = False
        cleanup_verdict: OwnedProcessCleanupVerdict | None = None
        try:
            readers.append(
                self._start_reader(
                    process.stdout, stdout_capture, "stdout", on_chunk=on_output_chunk
                )
            )
            owned._output_readers = tuple(readers)
            readers.append(
                self._start_reader(
                    process.stderr, stderr_capture, "stderr", on_chunk=on_output_chunk
                )
            )
            owned._output_readers = tuple(readers)
            deadline = started_at + max(0.0, float(timeout_seconds))
            while True:
                if abort_event is not None and abort_event.is_set():
                    aborted = True
                    self.terminate(owned)
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    self.terminate(owned)
                    break
                try:
                    process.wait(timeout=min(0.1, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue

            self._close_containment(owned)
            io_threads = self._io_threads(owned)
            for io_thread in io_threads:
                io_thread.join(timeout=PIPE_DRAIN_GRACE_SECONDS)
            if any(io_thread.is_alive() for io_thread in io_threads):
                drain_incomplete = True
                self._close_pipes(owned)
                for io_thread in io_threads:
                    io_thread.join(timeout=0.2)

            output, drain_incomplete, read_error_types = captured_output_with_diagnostics(
                already_incomplete=drain_incomplete,
                stdout_capture=stdout_capture,
                stderr_capture=stderr_capture,
            )
            if output.truncated or drain_incomplete:
                log_event(
                    logger,
                    logging.WARNING,
                    component="ai.tools.owned_process",
                    event="ai.tools.owned_process.output_bounded",
                    message="Owned process output exceeded a bounded capture contract.",
                    data={
                        **output.counters(),
                        "drain_incomplete": drain_incomplete,
                        "read_error_types": read_error_types,
                    },
                )
            cleanup_verdict = self._finalize(owned)
            return OwnedProcessResult(
                args=owned.args,
                returncode=int(process.returncode if process.returncode is not None else -1),
                output=output,
                pid=int(process.pid),
                containment=owned.containment,
                duration_seconds=max(0.0, time.monotonic() - started_at),
                timed_out=timed_out,
                aborted=aborted,
                drain_incomplete=drain_incomplete,
                cleanup_verdict=cleanup_verdict,
            )
        except BaseException:
            self.terminate(owned)
            self._close_pipes(owned)
            for io_thread in self._io_threads(owned):
                io_thread.join(timeout=0.2)
            raise
        finally:
            if cleanup_verdict is None:
                self._finalize(owned)

    def terminate(
        self,
        owned: OwnedProcess,
        *,
        timeout_seconds: float = DEFAULT_TERMINATION_GRACE_SECONDS,
    ) -> None:
        process = owned.process
        try:
            if os.name == "nt" and owned.job_object is not None:
                # Backstop the Job Object with a PID-lineage tree kill. A
                # descendant is not guaranteed to inherit the job when its
                # parent is already inside an ambient tracking job. Run this
                # first while the bootstrap/target lineage is still intact.
                terminate_tree = getattr(owned.job_object, "terminate_tree", None)
                if not callable(terminate_tree) or not terminate_tree():
                    self._kill_windows_process_tree(int(process.pid))
            elif (
                os.name != "nt"
                and owned.process_group_id is not None
                # A reaped root leaves only the exited-group sweep, which
                # checks the group is still populated before it signals.
                and process.poll() is None
            ):
                await_supervisor_ready(owned, SUPERVISOR_READY_WAIT_SECONDS)
                self._terminate_posix_group(
                    owned.process_group_id,
                    process,
                    timeout_seconds=timeout_seconds,
                )

            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=max(0.1, timeout_seconds))
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=max(0.1, timeout_seconds))
        except Exception:  # noqa: BLE001 - shutdown must remain best-effort.
            logger.warning("owned process tree termination degraded", exc_info=True)

    @staticmethod
    def _kill_windows_process_tree(pid: int) -> None:
        """Best-effort descendant-tree kill independent of Job membership."""
        try:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            pass

    def cancel(
        self,
        owned: OwnedProcess,
        *,
        timeout_seconds: float = DEFAULT_TERMINATION_GRACE_SECONDS,
    ) -> OwnedProcessCleanupVerdict:
        """Terminate one owned tree and release capacity only after proof."""
        self.terminate(owned, timeout_seconds=timeout_seconds)
        # A second terminate repeats the tree kill (on Windows another taskkill
        # of up to 5 s) for nothing once the root is observed gone.
        return self._settle_cleanup(
            owned,
            timeout_seconds=timeout_seconds,
            terminate=not self._root_exited(owned),
        )

    def release(self, owned: OwnedProcess) -> OwnedProcessCleanupVerdict:
        """Release an owned process whose root the caller already reaped.

        For callers that drive ``process.wait()`` themselves instead of
        :meth:`wait` (the monitor manager reads the pipes and reaps the root
        directly). Closes containment — the Job Object's KILL_ON_JOB_CLOSE /
        exited-group sweep still collects surviving descendants — and releases
        the capacity lease. Never signals the reaped root PID itself. On POSIX
        the exited-group sweep signals the root's process group only while the
        kernel still reports a member in it (a live member keeps the PGID from
        being reused); a still-running tree belongs in :meth:`cancel`.
        """
        return self._finalize(owned)

    def retry_cleanup(
        self,
        owned: OwnedProcess,
        *,
        timeout_seconds: float = DEFAULT_TERMINATION_GRACE_SECONDS,
    ) -> OwnedProcessCleanupVerdict:
        """Retry owner cleanup and release a quarantined slot only on proof."""

        return self._settle_cleanup(owned, timeout_seconds=timeout_seconds, terminate=True)

    @staticmethod
    def _root_exited(owned: OwnedProcess) -> bool:
        try:
            return owned.process.poll() is not None
        except Exception:  # noqa: BLE001 - unknown state means terminate again.
            return False

    def _settle_cleanup(
        self,
        owned: OwnedProcess,
        *,
        timeout_seconds: float,
        terminate: bool,
    ) -> OwnedProcessCleanupVerdict:
        if terminate:
            self.terminate(owned, timeout_seconds=timeout_seconds)
        self._close_pipes(owned)
        deadline = time.monotonic() + max(0.1, float(timeout_seconds))
        for io_thread in self._io_threads(owned):
            io_thread.join(timeout=max(0.0, deadline - time.monotonic()))
        return self._finalize(owned)

    def retry_quarantined_cleanup(
        self,
        *,
        timeout_seconds: float = DEFAULT_TERMINATION_GRACE_SECONDS,
    ) -> tuple[OwnedProcessCleanupVerdict, ...]:
        """Retry every cleanup attempt that previously lacked termination proof."""

        with self._condition:
            quarantined = [
                owned
                for owned in self._active.values()
                if (
                    (latest := owned._cleanup_observation.latest) is not None
                    and latest.cleanup == "uncertain"
                )
            ]
        return tuple(
            self.retry_cleanup(owned, timeout_seconds=timeout_seconds)
            for owned in quarantined
        )

    def shutdown(self) -> None:
        with self._condition:
            self._shutting_down = True
            active = list(self._active.values())
            self._condition.notify_all()
        for owned in active:
            self.cancel(owned)

    def _acquire_capacity(
        self,
        *,
        allow_queue: bool,
        timeout_seconds: float,
        abort_event: threading.Event | None = None,
    ) -> _CapacityLease:
        with self._condition:
            if self._shutting_down:
                raise OwnedProcessShutdownError("owned process service is shutting down")
            if self._active_count < self._max_active:
                self._active_count += 1
                return _CapacityLease(self)
            if not allow_queue or self._queued_count >= self._max_queued:
                self._log_capacity_refusal()
                raise OwnedProcessCapacityError("owned process capacity is exhausted")

            deadline = time.monotonic() + timeout_seconds
            self._queued_count += 1
            try:
                while self._active_count >= self._max_active:
                    if self._shutting_down:
                        raise OwnedProcessShutdownError(
                            "owned process service is shutting down"
                        )
                    if abort_event is not None and abort_event.is_set():
                        raise OwnedProcessAbortedBeforeStart(
                            "owned process start was aborted while queued"
                        )
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self._log_capacity_refusal()
                        raise OwnedProcessCapacityError(
                            "owned process queue wait timed out"
                        )
                    # Nothing notifies the condition on abort, so wake often
                    # enough to notice a cancelled call while it queues.
                    wait_slice = remaining if abort_event is None else min(remaining, 0.05)
                    self._condition.wait(timeout=wait_slice)
                self._active_count += 1
                return _CapacityLease(self)
            finally:
                self._queued_count -= 1

    def _release_capacity(self) -> None:
        with self._condition:
            self._active_count = max(0, self._active_count - 1)
            self._condition.notify()

    def _finalize(self, owned: OwnedProcess) -> OwnedProcessCleanupVerdict:
        with owned._finalize_lock:
            if owned._finalized:
                latest = owned._cleanup_observation.latest
                return latest or OwnedProcessCleanupVerdict(
                    cleanup="confirmed",
                    process_tree_terminated=True,
                    output_readers_terminated=True,
                )
            process_tree_terminated = self._close_containment(owned)
            output_readers_terminated = not any(
                io_thread.is_alive() for io_thread in self._io_threads(owned)
            )
            confirmed = process_tree_terminated and output_readers_terminated
            reason_parts = []
            if not process_tree_terminated:
                reason_parts.append("process_tree_termination_unconfirmed")
            if not output_readers_terminated:
                reason_parts.append("output_reader_termination_unconfirmed")
            if confirmed and owned.containment == LINEAGE_CONTAINMENT:
                reason_parts.append(SAMPLED_LINEAGE_REASON)
            verdict = OwnedProcessCleanupVerdict(
                cleanup="confirmed" if confirmed else "uncertain",
                process_tree_terminated=process_tree_terminated,
                output_readers_terminated=output_readers_terminated,
                reason=";".join(reason_parts) or None,
            )
            if confirmed:
                owned._finalized = True
        if confirmed:
            with self._condition:
                self._active.pop(id(owned), None)
            owned._lease.release()
        from sidecar.runtime import owned_process_tracking

        owned_process_tracking.settle(owned._ledger_ticket, confirmed=confirmed)
        owned._cleanup_observation.publish(verdict)
        return verdict

    def _close_containment(self, owned: OwnedProcess) -> bool:
        process = owned.process
        if os.name == "nt" and owned.job_object is not None:
            job = owned.job_object
            try:
                assigned = tuple(job.assigned_process_ids())
                if assigned:
                    terminate_tree = getattr(job, "terminate_tree", None)
                    if callable(terminate_tree):
                        terminate_tree()
                    deadline = time.monotonic() + DEFAULT_TERMINATION_GRACE_SECONDS
                    while assigned and time.monotonic() < deadline:
                        time.sleep(0.01)
                        assigned = tuple(job.assigned_process_ids())
                if assigned:
                    return False
                job.close()
                owned.job_object = None
            except Exception:  # noqa: BLE001 - missing proof quarantines capacity.
                logger.warning("owned Windows process-tree proof unavailable", exc_info=True)
                return False
        elif os.name != "nt" and owned.process_group_id is not None:
            process_group_id = owned.process_group_id
            self._terminate_exited_process_group(process_group_id)
            deadline = time.monotonic() + DEFAULT_TERMINATION_GRACE_SECONDS
            while (
                self._posix_process_group_is_alive(process_group_id)
                and time.monotonic() < deadline
            ):
                time.sleep(0.01)
            if self._posix_process_group_is_alive(process_group_id):
                return False
            # A process group is observable, not a descendant-containment
            # boundary: a child can call setsid() and outlive the group. The
            # proof is the byte the supervisor writes only after it has seen
            # no descendant alive; its exit status alone proves nothing.
            return process.poll() is not None and supervisor_proved_cleanup(owned)
        return process.poll() is not None

    _preflight_posix_target = staticmethod(preflight_posix_target)

    @staticmethod
    def _posix_process_group_is_alive(process_group_id: int) -> bool:
        if not hasattr(os, "killpg"):
            return True
        try:
            os.killpg(process_group_id, 0)
            return True
        except ProcessLookupError:
            return False
        except (OSError, ValueError):
            return True

    @staticmethod
    def _terminate_posix_group(
        process_group_id: int,
        process: subprocess.Popen[bytes],
        *,
        timeout_seconds: float,
    ) -> None:
        if not hasattr(os, "killpg"):
            return
        try:
            os.killpg(process_group_id, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            # The supervisor gives the tree the same grace and then sweeps it;
            # killing it early would discard the cleanup proof.
            process.wait(
                timeout=max(0.1, timeout_seconds) + SUPERVISOR_TEARDOWN_MARGIN_SECONDS
            )
            return
        except subprocess.TimeoutExpired:
            pass
        sigkill = getattr(signal, "SIGKILL", None)
        if sigkill is not None:
            try:
                os.killpg(process_group_id, sigkill)
            except ProcessLookupError:
                return

    @staticmethod
    def _terminate_exited_process_group(process_group_id: int) -> None:
        """Sweep survivors of an exited root, only while its group is populated.

        A live member keeps the PGID reserved, so the signal reaches the
        root's own leftovers. An empty group means the PGID may be reused, and
        EPERM means it already belongs to another user: signal neither.
        """
        if not hasattr(os, "killpg"):
            return
        try:
            os.killpg(process_group_id, 0)
        except (OSError, ValueError):
            return
        try:
            os.killpg(process_group_id, signal.SIGTERM)
        except ProcessLookupError:
            return
        time.sleep(0.05)
        sigkill = getattr(signal, "SIGKILL", None)
        if sigkill is None:
            return
        try:
            os.killpg(process_group_id, sigkill)
        except ProcessLookupError:
            return

    @staticmethod
    def _io_threads(owned: OwnedProcess) -> tuple[threading.Thread, ...]:
        return owned._output_readers

    _start_reader = staticmethod(start_output_reader)

    def _close_pipes(self, owned: OwnedProcess) -> None:
        process = owned.process
        pipes = (getattr(process, "stdin", None), process.stdout, process.stderr)
        close_process_pipes(pipes, self._io_threads(owned), close_pipe=self._close_pipe)

    @staticmethod
    def _close_pipe(pipe: IO[bytes]) -> None:
        try:
            pipe.close()
        except OSError:
            pass

    def _log_capacity_refusal(self) -> None:
        log_event(
            logger,
            logging.WARNING,
            component="ai.tools.owned_process",
            event="ai.tools.owned_process.capacity_refused",
            message="Owned process capacity was exhausted.",
            data={
                "active": self._active_count,
                "queued": self._queued_count,
                "max_active": self._max_active,
                "max_queued": self._max_queued,
            },
        )


_DEFAULT_OWNED_PROCESS_SERVICE = OwnedProcessService()
atexit.register(_DEFAULT_OWNED_PROCESS_SERVICE.shutdown)


def get_owned_process_service() -> OwnedProcessService:
    return _DEFAULT_OWNED_PROCESS_SERVICE


def owned_process_pid_is_alive(pid: int) -> bool:
    if os.name == "nt":
        return windows_process_is_alive(pid)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False


__all__ = [
    "CapturedProcessOutput",
    "DEFAULT_MAX_ACTIVE_PROCESSES",
    "DEFAULT_MAX_CAPTURE_BYTES",
    "DEFAULT_MAX_QUEUED_PROCESSES",
    "OwnedProcess",
    "OwnedProcessAbortedBeforeStart",
    "OwnedProcessCapacityError",
    "OwnedProcessCleanupVerdict",
    "OwnedProcessError",
    "OwnedProcessResult",
    "OwnedProcessService",
    "OwnedProcessShutdownError",
    "ProcessCapacitySnapshot",
    "get_owned_process_service",
    "owned_process_pid_is_alive",
]
