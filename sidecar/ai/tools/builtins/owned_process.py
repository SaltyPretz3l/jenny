"""Bounded, contained ownership for sidecar tool subprocesses.

Every process started here owns a concurrency lease, a POSIX process group or
Windows Job Object, and concurrent bounded drains for stdout and stderr.  The
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
from typing import IO, Callable, Mapping, Sequence

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

DEFAULT_MAX_ACTIVE_PROCESSES = 4
DEFAULT_MAX_QUEUED_PROCESSES = 8
DEFAULT_QUEUE_WAIT_SECONDS = 5.0
DEFAULT_MAX_CAPTURE_BYTES = 4 * 1024 * 1024
DEFAULT_TERMINATION_GRACE_SECONDS = 0.5
MIN_CAPTURE_BYTES = 2
PIPE_READ_CHUNK_BYTES = 64 * 1024
PIPE_DRAIN_GRACE_SECONDS = 1.0

logger = logging.getLogger(__name__)


class OwnedProcessError(RuntimeError):
    """Base class for process-owner failures."""


class OwnedProcessCapacityError(OwnedProcessError):
    """Raised when both active and queued process budgets are exhausted."""


class OwnedProcessShutdownError(OwnedProcessError):
    """Raised when a process start races service shutdown."""


@dataclass(frozen=True)
class ProcessCapacitySnapshot:
    active: int
    queued: int
    max_active: int
    max_queued: int
    shutting_down: bool


@dataclass(frozen=True)
class CapturedProcessOutput:
    stdout: str
    stderr: str
    stdout_bytes: int
    stderr_bytes: int
    stdout_captured_bytes: int
    stderr_captured_bytes: int

    @property
    def captured_bytes(self) -> int:
        return self.stdout_captured_bytes + self.stderr_captured_bytes

    @property
    def total_bytes(self) -> int:
        return self.stdout_bytes + self.stderr_bytes

    @property
    def discarded_bytes(self) -> int:
        return max(0, self.total_bytes - self.captured_bytes)

    @property
    def truncated(self) -> bool:
        return self.discarded_bytes > 0

    def counters(self) -> dict[str, int]:
        return {
            "stdout_bytes": self.stdout_bytes,
            "stderr_bytes": self.stderr_bytes,
            "captured_bytes": self.captured_bytes,
            "discarded_bytes": self.discarded_bytes,
        }


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


@dataclass
class _StreamCapture:
    limit_bytes: int
    data: bytearray = field(default_factory=bytearray)
    total_bytes: int = 0
    read_error: str = ""

    def append(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        remaining = max(0, self.limit_bytes - len(self.data))
        if remaining:
            self.data.extend(chunk[:remaining])


def _captured_output_with_diagnostics(
    *,
    already_incomplete: bool,
    stdout_capture: _StreamCapture,
    stderr_capture: _StreamCapture,
) -> tuple[CapturedProcessOutput, bool, dict[str, str]]:
    read_error_types = {
        stream_name: capture.read_error
        for stream_name, capture in (
            ("stdout", stdout_capture),
            ("stderr", stderr_capture),
        )
        if capture.read_error
    }
    output = CapturedProcessOutput(
        stdout=bytes(stdout_capture.data).decode("utf-8", errors="replace"),
        stderr=bytes(stderr_capture.data).decode("utf-8", errors="replace"),
        stdout_bytes=stdout_capture.total_bytes,
        stderr_bytes=stderr_capture.total_bytes,
        stdout_captured_bytes=len(stdout_capture.data),
        stderr_captured_bytes=len(stderr_capture.data),
    )
    return output, already_incomplete or bool(read_error_types), read_error_types


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
        self._service._release_capacity()  # noqa: SLF001


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
    _input_data: bytes | None = None
    _input_writer: threading.Thread | None = None
    _output_readers: tuple[threading.Thread, ...] = ()
    _finalized: bool = False
    _finalize_lock: threading.Lock = field(default_factory=threading.Lock)


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
    ) -> OwnedProcess:
        if not argv:
            raise ValueError("argv cannot be empty")
        if input_data is not None and not isinstance(input_data, bytes):
            raise TypeError("owned process input_data must be bytes or None")
        normalized_argv = tuple(str(argument) for argument in argv)
        bootstrap_payload = None
        if os.name == "nt" or input_data is not None:
            # The bootstrap encoder owns the single 1 MiB launch-envelope bound.
            # Reuse it on POSIX when input is present so the public input contract
            # has the same explicit limit on every platform.
            bootstrap_payload = encode_windows_bootstrap_payload(
                normalized_argv,
                cwd=cwd,
                env=env,
                input_data=input_data,
            )
        lease = self._acquire_capacity(
            allow_queue=allow_queue,
            timeout_seconds=max(0.0, float(queue_timeout_seconds)),
        )
        cleanup_observation = CleanupObservation(
            create_process_cleanup_observer(on_cleanup)
        )
        job_object: WindowsJobObject | None = None
        process_group_id: int | None = None
        owned: OwnedProcess | None = None
        try:
            creationflags = 0
            start_new_session = False
            containment = "posix_process_group"
            if os.name == "nt":
                job_object = WindowsJobObject()
                creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                containment = "windows_job_object_bootstrap"
            else:
                start_new_session = True

            process = subprocess.Popen(
                (
                    windows_bootstrap_command()
                    if job_object is not None
                    else list(normalized_argv)
                ),
                cwd=None if job_object is not None else str(cwd),
                env=(
                    None if job_object is not None else external_child_environment(env)
                ),
                stdin=(
                    subprocess.PIPE
                    if job_object is not None or input_data is not None
                    else subprocess.DEVNULL
                ),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=False,
                bufsize=0,
                creationflags=creationflags,
                start_new_session=start_new_session,
            )
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
                _input_data=input_data if job_object is None else None,
            )
            with self._condition:
                self._active[id(owned)] = owned
                if self._shutting_down:
                    raise OwnedProcessShutdownError(
                        "owned process service is shutting down"
                    )
            if job_object is not None:
                self._release_bootstrap(job_object, process, bootstrap_payload)
            return owned
        except BaseException:
            if owned is not None:
                self.cancel(owned)
            else:
                if job_object is not None:
                    try:
                        job_object.close()
                    except Exception:  # noqa: BLE001 - no child exists to quarantine.
                        logger.warning("empty owned Job handle cleanup degraded", exc_info=True)
                cleanup_observation.publish(
                    OwnedProcessCleanupVerdict(
                        cleanup="confirmed",
                        process_tree_terminated=True,
                        output_readers_terminated=True,
                        reason="no_child_started",
                    )
                )
                lease.release()
            raise

    @staticmethod
    def _release_bootstrap(
        job_object: WindowsJobObject, process: subprocess.Popen, payload: bytes | None,
    ) -> None:
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
        if (
            process.stdout is None
            or process.stderr is None
            or (owned._input_data is not None and process.stdin is None)  # noqa: SLF001
        ):
            self.cancel(owned)
            raise OwnedProcessError("owned process pipes are unavailable")

        per_stream_limit = self._max_capture_bytes // 2
        stdout_capture = _StreamCapture(per_stream_limit)
        stderr_capture = _StreamCapture(self._max_capture_bytes - per_stream_limit)
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
            owned._output_readers = tuple(readers)  # noqa: SLF001
            readers.append(
                self._start_reader(
                    process.stderr, stderr_capture, "stderr", on_chunk=on_output_chunk
                )
            )
            owned._output_readers = tuple(readers)  # noqa: SLF001
            if owned._input_data is not None:  # noqa: SLF001
                if process.stdin is None:
                    raise RuntimeError("Owned process input pipe is unavailable")
                owned._input_writer = self._start_input_writer(  # noqa: SLF001
                    process.stdin,
                    owned._input_data,  # noqa: SLF001
                )
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
                if process.stdin is not None:
                    self._close_pipe(process.stdin)
                self._close_pipe(process.stdout)
                self._close_pipe(process.stderr)
                for io_thread in io_threads:
                    io_thread.join(timeout=0.2)

            output, drain_incomplete, read_error_types = _captured_output_with_diagnostics(
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
            if process.stdin is not None:
                self._close_pipe(process.stdin)
            self._close_pipe(process.stdout)
            self._close_pipe(process.stderr)
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
            elif os.name != "nt" and owned.process_group_id is not None:
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
        return self.retry_cleanup(owned, timeout_seconds=timeout_seconds)

    def release(self, owned: OwnedProcess) -> OwnedProcessCleanupVerdict:
        """Release an owned process whose root the caller already reaped.

        For callers that drive ``process.wait()`` themselves instead of
        :meth:`wait` (the monitor manager reads the pipes and reaps the root
        directly). Closes containment — the Job Object's KILL_ON_JOB_CLOSE /
        exited-group sweep still collects surviving descendants — and releases
        the capacity lease. Never signals the reaped root PID, so a recycled
        PID cannot be killed by mistake; a still-running tree belongs in
        :meth:`cancel`.
        """
        return self._finalize(owned)

    def retry_cleanup(
        self,
        owned: OwnedProcess,
        *,
        timeout_seconds: float = DEFAULT_TERMINATION_GRACE_SECONDS,
    ) -> OwnedProcessCleanupVerdict:
        """Retry owner cleanup and release a quarantined slot only on proof."""

        self.terminate(owned, timeout_seconds=timeout_seconds)
        for pipe in (
            getattr(owned.process, "stdin", None),
            owned.process.stdout,
            owned.process.stderr,
        ):
            if pipe is not None:
                self._close_pipe(pipe)
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
                    (latest := owned._cleanup_observation.latest) is not None  # noqa: SLF001
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
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self._log_capacity_refusal()
                        raise OwnedProcessCapacityError(
                            "owned process queue wait timed out"
                        )
                    self._condition.wait(timeout=remaining)
                self._active_count += 1
                return _CapacityLease(self)
            finally:
                self._queued_count -= 1

    def _release_capacity(self) -> None:
        with self._condition:
            self._active_count = max(0, self._active_count - 1)
            self._condition.notify()

    def _finalize(self, owned: OwnedProcess) -> OwnedProcessCleanupVerdict:
        with owned._finalize_lock:  # noqa: SLF001
            if owned._finalized:  # noqa: SLF001
                latest = owned._cleanup_observation.latest  # noqa: SLF001
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
            verdict = OwnedProcessCleanupVerdict(
                cleanup="confirmed" if confirmed else "uncertain",
                process_tree_terminated=process_tree_terminated,
                output_readers_terminated=output_readers_terminated,
                reason=";".join(reason_parts) or None,
            )
            if confirmed:
                owned._finalized = True  # noqa: SLF001
        if confirmed:
            with self._condition:
                self._active.pop(id(owned), None)
            owned._lease.release()  # noqa: SLF001
        owned._cleanup_observation.publish(verdict)  # noqa: SLF001
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
            # boundary: a child can call setsid() and outlive the group. An
            # empty original group therefore cannot prove full-tree cleanup.
            return False
        return process.poll() is not None

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
            process.wait(timeout=max(0.1, timeout_seconds))
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
        if not hasattr(os, "killpg"):
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
        input_writer = owned._input_writer  # noqa: SLF001
        return owned._output_readers + ((input_writer,) if input_writer else ())  # noqa: SLF001

    @staticmethod
    def _start_input_writer(pipe: IO[bytes], input_data: bytes) -> threading.Thread:
        def _write() -> None:
            try:
                pipe.write(input_data)
                pipe.flush()
            except (BrokenPipeError, OSError, ValueError):
                pass
            finally:
                OwnedProcessService._close_pipe(pipe)

        thread = threading.Thread(
            target=_write,
            daemon=True,
            name="owned-process-stdin",
        )
        thread.start()
        return thread

    @staticmethod
    def _start_reader(
        pipe: IO[bytes],
        capture: _StreamCapture,
        stream_name: str,
        *,
        on_chunk: Callable[[str, bytes], None] | None = None,
    ) -> threading.Thread:
        def _read() -> None:
            try:
                while True:
                    chunk = pipe.read(PIPE_READ_CHUNK_BYTES)
                    if not chunk:
                        return
                    capture.append(chunk)
                    if on_chunk is not None:
                        # Live-output tap (W2-1). The callback owns batching,
                        # throttling, and drops — it must never block or raise;
                        # a broken tap must not stall or kill the drain.
                        try:
                            on_chunk(stream_name, chunk)
                        except Exception:  # noqa: BLE001
                            logger.debug(
                                "owned process output tap failed",
                                extra={"stream": stream_name},
                            )
            except (OSError, ValueError) as error:
                capture.read_error = type(error).__name__
                logger.debug(
                    "owned process pipe drain ended after pipe closure",
                    extra={"stream": stream_name, "error_type": type(error).__name__},
                )

        thread = threading.Thread(
            target=_read,
            daemon=True,
            name=f"owned-process-{stream_name}",
        )
        thread.start()
        return thread

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
