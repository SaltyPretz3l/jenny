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

from sidecar.ai.tools.builtins.owned_process_windows import (
    WindowsJobObject,
    encode_windows_bootstrap_payload,
    release_windows_bootstrap_target,
    windows_bootstrap_command,
    windows_process_is_alive,
)
from sidecar.runtime.diagnostics import log_event

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

    def spawn(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str] | None = None,
        allow_queue: bool = True,
        queue_timeout_seconds: float = DEFAULT_QUEUE_WAIT_SECONDS,
    ) -> OwnedProcess:
        if not argv:
            raise ValueError("argv cannot be empty")
        normalized_argv = tuple(str(argument) for argument in argv)
        lease = self._acquire_capacity(
            allow_queue=allow_queue,
            timeout_seconds=max(0.0, float(queue_timeout_seconds)),
        )
        job_object: WindowsJobObject | None = None
        process: subprocess.Popen[bytes] | None = None
        process_group_id: int | None = None
        try:
            creationflags = 0
            start_new_session = False
            containment = "posix_process_group"
            if os.name == "nt":
                bootstrap_payload = encode_windows_bootstrap_payload(
                    normalized_argv,
                    cwd=cwd,
                    env=env,
                )
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
                env=None if job_object is not None else (
                    dict(env) if env is not None else None
                ),
                stdin=(
                    subprocess.PIPE if job_object is not None else subprocess.DEVNULL
                ),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=False,
                bufsize=0,
                creationflags=creationflags,
                start_new_session=start_new_session,
            )
            process_group_id = int(process.pid) if os.name != "nt" else None
            if job_object is not None:
                job_object.assign_pid(int(process.pid))
                if process.stdin is None:
                    raise OwnedProcessError("owned process bootstrap pipe is unavailable")
                release_windows_bootstrap_target(process.stdin, bootstrap_payload)
            owned = OwnedProcess(
                process=process,
                args=normalized_argv,
                containment=containment,
                process_group_id=process_group_id,
                job_object=job_object,
                _service=self,
                _lease=lease,
            )
            with self._condition:
                if self._shutting_down:
                    self._terminate_unregistered(process, job_object, process_group_id)
                    raise OwnedProcessShutdownError("owned process service is shutting down")
                self._active[id(owned)] = owned
            return owned
        except BaseException:
            try:
                if process is not None:
                    self._terminate_unregistered(process, job_object, process_group_id)
                elif job_object is not None:
                    job_object.close()
            finally:
                lease.release()
            raise

    def run(  # noqa: PLR0913 - explicit process lifecycle contract.
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        timeout_seconds: float,
        env: Mapping[str, str] | None = None,
        abort_event: threading.Event | None = None,
        on_output_chunk: Callable[[str, bytes], None] | None = None,
    ) -> OwnedProcessResult:
        owned = self.spawn(
            argv,
            cwd=cwd,
            env=env,
            allow_queue=True,
            queue_timeout_seconds=min(
                max(0.0, float(timeout_seconds)), DEFAULT_QUEUE_WAIT_SECONDS
            ),
        )
        return self.wait(
            owned,
            timeout_seconds=timeout_seconds,
            abort_event=abort_event,
            on_output_chunk=on_output_chunk,
        )

    def wait(
        self,
        owned: OwnedProcess,
        *,
        timeout_seconds: float,
        abort_event: threading.Event | None = None,
        on_output_chunk: Callable[[str, bytes], None] | None = None,
    ) -> OwnedProcessResult:
        process = owned.process
        if process.stdout is None or process.stderr is None:
            self._finalize(owned)
            raise OwnedProcessError("owned process pipes are unavailable")

        per_stream_limit = self._max_capture_bytes // 2
        stdout_capture = _StreamCapture(per_stream_limit)
        stderr_capture = _StreamCapture(self._max_capture_bytes - per_stream_limit)
        readers: list[threading.Thread] = []
        started_at = time.monotonic()
        timed_out = False
        aborted = False
        drain_incomplete = False
        try:
            readers.append(
                self._start_reader(
                    process.stdout, stdout_capture, "stdout", on_chunk=on_output_chunk
                )
            )
            readers.append(
                self._start_reader(
                    process.stderr, stderr_capture, "stderr", on_chunk=on_output_chunk
                )
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
            for reader in readers:
                reader.join(timeout=PIPE_DRAIN_GRACE_SECONDS)
            if any(reader.is_alive() for reader in readers):
                drain_incomplete = True
                self._close_pipe(process.stdout)
                self._close_pipe(process.stderr)
                for reader in readers:
                    reader.join(timeout=0.2)

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
            )
        except BaseException:
            self.terminate(owned)
            self._close_pipe(process.stdout)
            self._close_pipe(process.stderr)
            for reader in readers:
                reader.join(timeout=0.2)
            raise
        finally:
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
                self._kill_windows_process_tree(int(process.pid))
                owned.job_object.close()
                owned.job_object = None
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
    ) -> None:
        """Terminate one owned tree and release its capacity lease."""
        self.terminate(owned, timeout_seconds=timeout_seconds)
        self._finalize(owned)

    def release(self, owned: OwnedProcess) -> None:
        """Release an owned process whose root the caller already reaped.

        For callers that drive ``process.wait()`` themselves instead of
        :meth:`wait` (the monitor manager reads the pipes and reaps the root
        directly). Closes containment — the Job Object's KILL_ON_JOB_CLOSE /
        exited-group sweep still collects surviving descendants — and releases
        the capacity lease. Never signals the reaped root PID, so a recycled
        PID cannot be killed by mistake; a still-running tree belongs in
        :meth:`cancel`.
        """
        self._finalize(owned)

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

    def _finalize(self, owned: OwnedProcess) -> None:
        with owned._finalize_lock:  # noqa: SLF001
            if owned._finalized:  # noqa: SLF001
                return
            owned._finalized = True  # noqa: SLF001
        self._close_containment(owned)
        with self._condition:
            self._active.pop(id(owned), None)
        owned._lease.release()  # noqa: SLF001

    def _close_containment(self, owned: OwnedProcess) -> None:
        if owned.job_object is not None:
            owned.job_object.close()
            owned.job_object = None
        if os.name != "nt" and owned.process_group_id is not None:
            self._terminate_exited_process_group(owned.process_group_id)
            owned.process_group_id = None

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
    def _terminate_unregistered(
        process: subprocess.Popen[bytes],
        job_object: WindowsJobObject | None,
        process_group_id: int | None,
    ) -> None:
        if job_object is not None:
            job_object.close()
        if process_group_id is not None:
            try:
                OwnedProcessService._terminate_posix_group(
                    process_group_id,
                    process,
                    timeout_seconds=DEFAULT_TERMINATION_GRACE_SECONDS,
                )
            except Exception:  # noqa: BLE001
                logger.warning("unregistered process-group cleanup degraded", exc_info=True)
        poll = getattr(process, "poll", None)
        is_running = not callable(poll) or poll() is None
        if is_running:
            try:
                kill = getattr(process, "kill", None)
                if callable(kill):
                    kill()
                wait = getattr(process, "wait", None)
                if callable(wait):
                    wait(timeout=0.5)
            except Exception:  # noqa: BLE001
                logger.warning("unregistered owned process cleanup degraded", exc_info=True)

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
    "OwnedProcessError",
    "OwnedProcessResult",
    "OwnedProcessService",
    "OwnedProcessShutdownError",
    "ProcessCapacitySnapshot",
    "get_owned_process_service",
    "owned_process_pid_is_alive",
]
