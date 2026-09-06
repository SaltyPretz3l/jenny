"""Background job management for the shell tool.

Handles fire-and-forget execution via ``subprocess.Popen`` + daemon
threads, with status and output persisted to
``<workspace>/.jenny/tool-results/<job_id>/``.
"""

from __future__ import annotations

import atexit
import logging
import os
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple, Protocol

from sidecar.ai.error_codes import (
    CMP_TOOL_BACKGROUND_NOT_FOUND,
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_IO_FAILED,
)
from sidecar.ai.tools.builtins.owned_process import (
    DEFAULT_MAX_ACTIVE_PROCESSES,
    OwnedProcess,
    OwnedProcessCapacityError,
    OwnedProcessResult,
    OwnedProcessShutdownError,
    get_owned_process_service,
    owned_process_pid_is_alive,
)
from sidecar.ai.tools.builtins.shell_background_status import (
    MAX_INLINE_OUTPUT_CHARS,
    MAX_STATUS_ERROR_CHARS,
    MAX_STATUS_FILE_BYTES,
    is_valid_job_id,
    validate_job_status_for_write,
)
from sidecar.ai.tools.builtins.shell_background_status import (
    job_status_error as _job_status_error,
)
from sidecar.ai.tools.builtins.shell_background_status import (
    parse_job_status as _parse_job_status,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate
from sidecar.ai.tools.workspace_store import (
    GuardedWorkspaceStore,
    StoreRef,
    WorkspaceStoreKind,
)
from sidecar.runtime.diagnostics import log_event

TOOL_RESULTS_DIR = ".jenny/tool-results"
MAX_BACKGROUND_OUTPUT_BYTES = 50 * 1024 * 1024
MAX_BACKGROUND_JOBS = DEFAULT_MAX_ACTIVE_PROCESSES
MAX_TERMINAL_STATUS_FALLBACKS = 64
RUNNING_RECONCILIATION_GRACE_SECONDS = 5.0
RUNNING_PID_REUSE_MAX_SECONDS = 15 * 60.0
BACKGROUND_STOP_WAIT_SECONDS = 3.0
JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60
FULL_OUTPUT_FILE = "output.txt"

# Canonical job-ID format: 12 lowercase hex chars, matching the IDs minted by
# start_background_job() (uuid.uuid4().hex[:12]). Any job_id supplied by the
# model that doesn't match this is refused before it ever reaches a path
# join — this is what closes traversal (`..`), absolute drive/UNC paths, and
# separator-bearing IDs (WIDE-011).

# status.json read cap (WIDE-011): bounds the read before json.loads() runs,
# so a hostile/oversized status file can't be used to force an unbounded
# in-memory parse.
_OUTPUT_SIZE_MARKER = "\n...[truncated due to background output size cap]"
logger = logging.getLogger(__name__)


class _Closable(Protocol):
    def close(self) -> None: ...


@dataclass
class _ManagedBackgroundProcess:
    process: subprocess.Popen[str]
    job_object: _Closable | None = None
    process_group_id: int | None = None
    owned_process: OwnedProcess | None = None
    owned_result: OwnedProcessResult | None = None
    stop_requested: threading.Event = field(default_factory=threading.Event)
    settled: threading.Event = field(default_factory=threading.Event)


# In-process tracking of running background jobs for cleanup.
_active_jobs: dict[str, _ManagedBackgroundProcess] = {}
_active_job_store_keys: dict[str, str] = {}
_terminal_status_fallbacks: dict[tuple[str, str], dict[str, object]] = {}


@dataclass
class _BackgroundCapacity:
    pending_starts: int = 0


_background_capacity = _BackgroundCapacity()
_lock = threading.Lock()


def active_job_ids() -> list[str]:
    with _lock:
        return sorted(_active_jobs)


def _cleanup_active_jobs() -> None:
    """Best-effort cleanup of lingering background processes."""
    with _lock:
        jobs = list(_active_jobs.values())
        _active_jobs.clear()
        _active_job_store_keys.clear()
    for job in jobs:
        _terminate_background_process(job, timeout_seconds=0.5)


atexit.register(_cleanup_active_jobs)


def _job_ref(store: GuardedWorkspaceStore, job_id: str) -> StoreRef:
    return store.resolve(WorkspaceStoreKind.TOOL_RESULTS, job_id)


def _sanitize_status_for_persistence(status: dict[str, object]) -> dict[str, object]:
    safe_status = dict(status)
    for key in ("stdout", "stderr", "error"):
        value = safe_status.get(key)
        if isinstance(value, str):
            safe_status[key] = sanitize_tool_output_no_truncate(
                value, tool_name="run_command_background"
            )
    return safe_status


def _write_status(
    store: GuardedWorkspaceStore,
    job_ref: StoreRef,
    status: dict[str, object],
) -> bool:
    persisted = validate_job_status_for_write(_sanitize_status_for_persistence(status))
    if persisted is None:
        logger.warning("background job status producer emitted an invalid v1 payload")
        return False
    try:
        store.write_json_atomic(
            store.child(job_ref, "status.json"),
            persisted,
            max_bytes=MAX_STATUS_FILE_BYTES,
        )
    except ToolExecutionFailure:
        logger.warning(
            "background job status persistence refused by guarded store",
            exc_info=True,
        )
        return False
    return True


def _remember_terminal_status(
    store: GuardedWorkspaceStore,
    status: dict[str, object],
) -> None:
    persisted = validate_job_status_for_write(_sanitize_status_for_persistence(status))
    if persisted is None or persisted.get("state") == "running":
        return
    job_id = str(persisted["job_id"])
    key = (store.cache_key, job_id)
    with _lock:
        _terminal_status_fallbacks[key] = persisted
        while len(_terminal_status_fallbacks) > MAX_TERMINAL_STATUS_FALLBACKS:
            oldest = next(iter(_terminal_status_fallbacks))
            _terminal_status_fallbacks.pop(oldest, None)
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.shell_background",
        event="ai.tools.shell_background.terminal_status_degraded",
        message="Background job terminal status is available only in bounded memory.",
        data={"state": persisted.get("state")},
    )


def _publish_terminal_status(
    store: GuardedWorkspaceStore,
    job_ref: StoreRef,
    status: dict[str, object],
) -> None:
    try:
        published = _write_status(store, job_ref, status)
    except Exception:  # noqa: BLE001 - the process must still be reconciled.
        logger.warning("background terminal status publication failed", exc_info=True)
        published = False
    if not published:
        _remember_terminal_status(store, status)
    else:
        job_id = status.get("job_id")
        if isinstance(job_id, str):
            with _lock:
                _terminal_status_fallbacks.pop((store.cache_key, job_id), None)


def _reserve_background_slot() -> None:
    with _lock:
        if (
            len(_active_jobs) + _background_capacity.pending_starts
            >= MAX_BACKGROUND_JOBS
        ):
            raise ToolExecutionFailure(
                code=CMP_TOOL_CAP_EXCEEDED,
                message=f"background process capacity is limited to {MAX_BACKGROUND_JOBS}",
                retryable=True,
            )
        _background_capacity.pending_starts += 1


def _release_background_start_reservation() -> None:
    with _lock:
        _background_capacity.pending_starts = max(
            0,
            _background_capacity.pending_starts - 1,
        )


def _process_is_alive(pid: int) -> bool:
    return owned_process_pid_is_alive(pid)


def _unowned_running_status_age(
    store: GuardedWorkspaceStore,
    job_ref: StoreRef,
    job_id: str,
) -> float | None:
    with _lock:
        owned_here = (
            job_id in _active_jobs
            and _active_job_store_keys.get(job_id) == store.cache_key
        )
    if owned_here:
        return None
    try:
        entry = store.stat(store.child(job_ref, "status.json"))
    except ToolExecutionFailure:
        return None
    if entry is None:
        return None
    return max(0.0, time.time() - (entry.mtime_ns / 1_000_000_000))


def _reconcile_orphaned_running_status(
    store: GuardedWorkspaceStore,
    job_ref: StoreRef,
    status: dict[str, object],
) -> dict[str, object]:
    if status.get("state") != "running":
        return status
    job_id = str(status.get("job_id") or "")
    age_seconds = _unowned_running_status_age(store, job_ref, job_id)
    if age_seconds is None:
        return status
    if age_seconds < RUNNING_RECONCILIATION_GRACE_SECONDS:
        return status
    pid = status.get("pid")
    if (
        isinstance(pid, int)
        and not isinstance(pid, bool)
        and age_seconds < RUNNING_PID_REUSE_MAX_SECONDS
        and _process_is_alive(pid)
    ):
        return status

    reconciled: dict[str, object] = {
        "job_id": job_id,
        "state": "failed",
        "exit_code": -1,
        "stdout": "",
        "stderr": "",
        "error": "background job ownership was lost before terminal status persisted",
    }
    _publish_terminal_status(store, job_ref, reconciled)
    persisted = validate_job_status_for_write(reconciled)
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.shell_background",
        event="ai.tools.shell_background.running_status_reconciled",
        message="A stale running background job status was reconciled.",
        data={"age_seconds": min(int(age_seconds), int(RUNNING_PID_REUSE_MAX_SECONDS))},
    )
    return persisted if persisted is not None else reconciled


def _promote_background_start(
    job_id: str,
    job: _ManagedBackgroundProcess,
    *,
    store_key: str,
) -> None:
    with _lock:
        _background_capacity.pending_starts = max(
            0,
            _background_capacity.pending_starts - 1,
        )
        _active_jobs[job_id] = job
        _active_job_store_keys[job_id] = store_key


def _sweep_stale_job_dirs(
    store: GuardedWorkspaceStore,
    *,
    now: float | None = None,
) -> None:
    cutoff = (time.time() if now is None else now) - max(0, JOB_RETENTION_SECONDS)
    try:
        children = store.list_entries(store.resolve(WorkspaceStoreKind.TOOL_RESULTS))
    except ToolExecutionFailure:
        return
    for child in children:
        if not child.is_directory:
            continue
        try:
            status = store.stat(store.child(child.ref, "status.json"))
            mtime_ns = status.mtime_ns if status is not None else child.mtime_ns
        except ToolExecutionFailure:
            continue
        if (mtime_ns / 1_000_000_000) >= cutoff:
            continue
        try:
            outcome = store.delete(child.ref, recursive=True)
            if not outcome.removed:
                logger.debug("stale background job output remained quarantined")
        except ToolExecutionFailure:
            logger.debug("failed to sweep stale background shell job output", exc_info=True)


def _truncate_output(value: str) -> tuple[str, bool]:
    if len(value) <= MAX_INLINE_OUTPUT_CHARS:
        return value, False
    return f"{value[:MAX_INLINE_OUTPUT_CHARS]}\n...[truncated]", True


def _limit_output_bytes(value: str) -> tuple[str, bool]:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_BACKGROUND_OUTPUT_BYTES:
        return value, False
    trimmed = encoded[:MAX_BACKGROUND_OUTPUT_BYTES].decode("utf-8", errors="ignore")
    return f"{trimmed}{_OUTPUT_SIZE_MARKER}", True


def _persist_full_output(
    store: GuardedWorkspaceStore,
    job_ref: StoreRef,
    stdout: str,
    stderr: str,
) -> tuple[str | None, bool]:
    combined_parts: list[str] = []
    if stdout:
        combined_parts.append(f"STDOUT:\n{stdout}")
    if stderr:
        combined_parts.append(f"STDERR:\n{stderr}")
    combined = "\n\n".join(combined_parts)
    combined_size = len(combined.encode("utf-8", errors="replace"))
    if combined_size <= MAX_INLINE_OUTPUT_CHARS and combined_size <= MAX_BACKGROUND_OUTPUT_BYTES:
        return None, False
    limited, output_file_truncated = _limit_output_bytes(combined)
    try:
        output = store.write_text_atomic(
            store.child(job_ref, FULL_OUTPUT_FILE),
            limited,
            max_bytes=MAX_BACKGROUND_OUTPUT_BYTES + len(_OUTPUT_SIZE_MARKER.encode("utf-8")),
        )
    except ToolExecutionFailure:
        return None, output_file_truncated
    return output.absolute_path, output_file_truncated


def _build_terminal_status(
    *,
    job_id: str,
    state: str,
    exit_code: int,
    stdout: str,
    stderr: str,
    error: str | None = None,
    store: GuardedWorkspaceStore,
    job_ref: StoreRef,
    source_output_truncated: bool = False,
    output_counters: dict[str, int] | None = None,
) -> dict[str, object]:
    safe_stdout = sanitize_tool_output_no_truncate(
        stdout or "", tool_name="run_command_background"
    )
    safe_stderr = sanitize_tool_output_no_truncate(
        stderr or "", tool_name="run_command_background"
    )
    truncated_stdout, stdout_truncated = _truncate_output(safe_stdout)
    truncated_stderr, stderr_truncated = _truncate_output(safe_stderr)
    payload: dict[str, object] = {
        "job_id": job_id,
        "state": state,
        "exit_code": exit_code,
        "stdout": truncated_stdout,
        "stderr": truncated_stderr,
    }
    if error:
        payload["error"] = sanitize_tool_output_no_truncate(
            error, tool_name="run_command_background"
        )[:MAX_STATUS_ERROR_CHARS]
    full_output_path, output_file_truncated = _persist_full_output(
        store,
        job_ref,
        safe_stdout,
        safe_stderr,
    )
    if full_output_path is not None:
        payload["full_output_path"] = full_output_path
        payload["full_output_complete"] = not (
            output_file_truncated or source_output_truncated
        )
    if output_file_truncated:
        payload["output_file_truncated"] = True
    if output_file_truncated or source_output_truncated:
        payload["output_size_exceeded"] = True
    if stdout_truncated or stderr_truncated or source_output_truncated:
        payload["output_truncated"] = True
    if output_counters is not None:
        payload["output_counters"] = output_counters
    return payload


def _spawn_background_process(argv: list[str], *, cwd: Path) -> _ManagedBackgroundProcess:
    owned = get_owned_process_service().spawn(
        argv,
        cwd=cwd,
        allow_queue=False,
    )
    return _ManagedBackgroundProcess(
        process=owned.process,  # type: ignore[arg-type]
        owned_process=owned,
    )


def _wait_for_background_exit(
    job: _ManagedBackgroundProcess, timeout_seconds: float
) -> tuple[str, str]:
    if job.owned_process is not None:
        result = get_owned_process_service().wait(
            job.owned_process,
            timeout_seconds=timeout_seconds,
            abort_event=job.stop_requested,
        )
        job.owned_result = result
        return result.stdout, result.stderr
    process = job.process
    try:
        return process.communicate(timeout=timeout_seconds)
    except ValueError:
        return process.communicate()


def _terminate_posix_process_group(job: _ManagedBackgroundProcess, timeout_seconds: float) -> None:
    process = job.process
    process_group_id = job.process_group_id
    if process_group_id is None or not hasattr(os, "killpg"):
        return
    try:
        os.killpg(process_group_id, signal.SIGTERM)
        process.wait(timeout=max(0.1, timeout_seconds))
        return
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        sigkill = getattr(signal, "SIGKILL", None)
        if sigkill is None:
            process.kill()
            process.wait(timeout=max(0.1, timeout_seconds))
            return
        try:
            os.killpg(process_group_id, sigkill)
        except ProcessLookupError:
            return
        process.wait(timeout=max(0.1, timeout_seconds))


def _terminate_background_process(
    job: _ManagedBackgroundProcess,
    *,
    timeout_seconds: float,
) -> None:
    if job.owned_process is not None:
        get_owned_process_service().cancel(
            job.owned_process,
            timeout_seconds=timeout_seconds,
        )
        return
    process = job.process
    try:
        if process.poll() is not None:
            return
        if os.name == "nt" and job.job_object is not None:
            job.job_object.close()
            job.job_object = None
            try:
                process.wait(timeout=max(0.1, timeout_seconds))
                return
            except subprocess.TimeoutExpired:
                pass
        elif os.name != "nt" and job.process_group_id is not None:
            _terminate_posix_process_group(job, timeout_seconds)
            if process.poll() is not None:
                return

        process.terminate()
        try:
            process.wait(timeout=max(0.1, timeout_seconds))
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=max(0.1, timeout_seconds))
    except Exception:  # noqa: BLE001
        logger.debug("failed to terminate background shell job", exc_info=True)
    finally:
        if job.job_object is not None:
            job.job_object.close()
            job.job_object = None


ManagedBackgroundProcess = _ManagedBackgroundProcess


def spawn_managed_background_process(
    argv: list[str],
    *,
    cwd: Path,
) -> ManagedBackgroundProcess:
    return _spawn_background_process(argv, cwd=cwd)


def terminate_managed_background_process(
    job: ManagedBackgroundProcess,
    *,
    timeout_seconds: float,
) -> None:
    _terminate_background_process(job, timeout_seconds=timeout_seconds)


def release_managed_background_process(job: ManagedBackgroundProcess) -> None:
    """Release a job whose root process the caller already reaped.

    Frees the owned-process capacity lease and closes containment without
    signalling the reaped root PID (a recycled PID must never be killed).
    """
    if job.owned_process is not None:
        get_owned_process_service().release(job.owned_process)
        return
    if job.job_object is not None:
        job.job_object.close()
        job.job_object = None


@dataclass(frozen=True)
class _BackgroundTerminalOutcome:
    state: str
    exit_code: int
    stdout: str
    stderr: str
    error: str | None = None
    output_truncated: bool = False
    output_counters: dict[str, int] | None = None


def _remove_active_job(job_id: str) -> None:
    with _lock:
        _active_jobs.pop(job_id, None)
        _active_job_store_keys.pop(job_id, None)


def _spawn_background_or_publish_failure(
    argv: list[str],
    *,
    cwd: Path,
    store: GuardedWorkspaceStore,
    job_ref: StoreRef,
    job_id: str,
) -> _ManagedBackgroundProcess:
    try:
        return _spawn_background_process(argv, cwd=cwd)
    except (OwnedProcessCapacityError, OwnedProcessShutdownError) as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_CAP_EXCEEDED,
            message=f"background process capacity unavailable: {error}",
            retryable=True,
        ) from error
    except (FileNotFoundError, OSError) as error:
        message = (
            f"command not found: {argv[0]}"
            if isinstance(error, FileNotFoundError)
            else str(error)
        )
        _publish_terminal_status(
            store,
            job_ref,
            {
                "job_id": job_id,
                "state": "failed",
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "error": message[:MAX_STATUS_ERROR_CHARS],
            },
        )
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=message[:MAX_STATUS_ERROR_CHARS],
            retryable=not isinstance(error, FileNotFoundError),
        ) from error


def _publish_initial_status_or_refuse(
    *,
    store: GuardedWorkspaceStore,
    job_ref: StoreRef,
    job_id: str,
    job: _ManagedBackgroundProcess,
) -> None:
    try:
        published = _write_status(
            store,
            job_ref,
            {"job_id": job_id, "state": "running", "pid": job.process.pid},
        )
    except Exception:  # noqa: BLE001 - cleanup must win over persistence.
        logger.warning("background initial status publication failed", exc_info=True)
        published = False
    if published:
        return
    _remove_active_job(job_id)
    _terminate_background_process(job, timeout_seconds=1.0)
    raise ToolExecutionFailure(
        code=CMP_TOOL_IO_FAILED,
        message="background job could not publish its initial status",
        retryable=True,
    )


def _capture_background_terminal(
    job: _ManagedBackgroundProcess,
    *,
    timeout_seconds: float,
) -> _BackgroundTerminalOutcome:
    try:
        stdout, stderr = _wait_for_background_exit(job, timeout_seconds)
        result = job.owned_result
        if result is not None and result.timed_out:
            return _BackgroundTerminalOutcome(
                "failed",
                -1,
                stdout,
                stderr,
                error=f"timed out after {timeout_seconds:.0f}s",
                output_truncated=result.output.truncated or result.drain_incomplete,
                output_counters=result.output.counters(),
            )
        if result is not None and result.aborted:
            return _BackgroundTerminalOutcome(
                "failed",
                -1,
                stdout,
                stderr,
                error="background job was cancelled",
                output_truncated=result.output.truncated or result.drain_incomplete,
                output_counters=result.output.counters(),
            )
        exit_code = int(job.process.returncode or 0)
        return _BackgroundTerminalOutcome(
            "completed" if exit_code == 0 else "failed",
            exit_code,
            stdout,
            stderr,
            output_truncated=bool(
                result is not None
                and (result.output.truncated or result.drain_incomplete)
            ),
            output_counters=(result.output.counters() if result is not None else None),
        )
    except subprocess.TimeoutExpired:
        _terminate_background_process(job, timeout_seconds=1.0)
        try:
            stdout, stderr = _wait_for_background_exit(job, 1.0)
        except (subprocess.TimeoutExpired, ValueError):
            stdout, stderr = "", ""
        return _BackgroundTerminalOutcome(
            "failed",
            -1,
            stdout,
            stderr,
            error=f"timed out after {timeout_seconds:.0f}s",
        )
    except Exception as error:  # noqa: BLE001 - terminalize every owned job.
        _terminate_background_process(job, timeout_seconds=1.0)
        return _BackgroundTerminalOutcome(
            "failed",
            -1,
            "",
            "",
            error=f"background job wait failed: {type(error).__name__}",
        )


def _settle_background_job(
    *,
    job_id: str,
    job: _ManagedBackgroundProcess,
    store: GuardedWorkspaceStore,
    job_ref: StoreRef,
    timeout_seconds: float,
) -> None:
    outcome = _capture_background_terminal(job, timeout_seconds=timeout_seconds)
    try:
        status = _build_terminal_status(
            job_id=job_id,
            state=outcome.state,
            exit_code=outcome.exit_code,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            error=outcome.error,
            store=store,
            job_ref=job_ref,
            source_output_truncated=outcome.output_truncated,
            output_counters=outcome.output_counters,
        )
        _publish_terminal_status(store, job_ref, status)
    finally:
        _remove_active_job(job_id)
        if job.job_object is not None:
            job.job_object.close()
            job.job_object = None
        job.settled.set()


def _start_background_waiter(
    *,
    job_id: str,
    job: _ManagedBackgroundProcess,
    store: GuardedWorkspaceStore,
    job_ref: StoreRef,
    timeout_seconds: float,
) -> None:
    thread = threading.Thread(
        target=_settle_background_job,
        kwargs={
            "job_id": job_id,
            "job": job,
            "store": store,
            "job_ref": job_ref,
            "timeout_seconds": timeout_seconds,
        },
        daemon=True,
        name=f"bg-job-{job_id}",
    )
    try:
        thread.start()
    except RuntimeError as error:
        _remove_active_job(job_id)
        _terminate_background_process(job, timeout_seconds=1.0)
        _publish_terminal_status(
            store,
            job_ref,
            _build_terminal_status(
                job_id=job_id,
                state="failed",
                exit_code=-1,
                stdout="",
                stderr="",
                error="background waiter could not start",
                store=store,
                job_ref=job_ref,
            ),
        )
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="background job waiter could not start",
            retryable=True,
        ) from error


class BackgroundJobStart(NamedTuple):
    """Trusted start receipt: the id plus the PID this process actually spawned.

    The PID travels to Electron inside the tool result (the framed stdio
    channel), NOT via the workspace-writable ``status.json`` — kill authority
    must never be derived from a file the background command itself (or any
    workspace writer) can rewrite.
    """

    job_id: str
    pid: int


def start_background_job(
    argv: list[str],
    *,
    cwd: Path,
    workspace_root: Path,
    timeout_seconds: float,
) -> BackgroundJobStart:
    """Launch *argv* in the background; return the id + trusted spawned PID."""
    store = GuardedWorkspaceStore(workspace_root)
    _sweep_stale_job_dirs(store)
    job_id = uuid.uuid4().hex[:12]
    job_ref = _job_ref(store, job_id)
    reservation_held = True
    _reserve_background_slot()
    try:
        job = _spawn_background_or_publish_failure(
            argv,
            cwd=cwd,
            store=store,
            job_ref=job_ref,
            job_id=job_id,
        )
        _promote_background_start(job_id, job, store_key=store.cache_key)
        reservation_held = False
        _publish_initial_status_or_refuse(
            store=store,
            job_ref=job_ref,
            job_id=job_id,
            job=job,
        )
        _start_background_waiter(
            job_id=job_id,
            job=job,
            store=store,
            job_ref=job_ref,
            timeout_seconds=timeout_seconds,
        )
        return BackgroundJobStart(job_id=job_id, pid=int(job.process.pid))
    finally:
        if reservation_held:
            _release_background_start_reservation()


def stop_background_job(workspace_root: Path, job_id: str) -> dict[str, object]:
    """Stop one active workspace-owned job and return its terminal status."""
    store = GuardedWorkspaceStore(workspace_root)
    with _lock:
        job = _active_jobs.get(job_id)
        if _active_job_store_keys.get(job_id) != store.cache_key:
            job = None

    if job is None:
        status = read_background_job(workspace_root, job_id)
        if status.get("state") == "running":
            raise ToolExecutionFailure(
                code=CMP_TOOL_BACKGROUND_NOT_FOUND,
                message="background job is not owned by this sidecar runtime",
                retryable=False,
            )
        return {**status, "stop_requested": False}

    job.stop_requested.set()
    if not job.settled.wait(timeout=BACKGROUND_STOP_WAIT_SECONDS):
        _terminate_background_process(job, timeout_seconds=1.0)
        if not job.settled.wait(timeout=BACKGROUND_STOP_WAIT_SECONDS):
            log_event(
                logger,
                logging.WARNING,
                component="ai.tools.shell_background",
                event="ai.tools.shell_background.stop_settlement_failed",
                message="Background job termination did not reach terminal settlement.",
                data={"job_id": job_id},
            )
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message="background job termination did not settle",
                retryable=True,
            )
    return {**read_background_job(workspace_root, job_id), "stop_requested": True}


def _read_background_status_bytes(
    store: GuardedWorkspaceStore,
    status_ref: StoreRef,
    *,
    job_id: str,
) -> bytes | dict[str, object]:
    try:
        raw_bytes = store.read_bytes(
            status_ref,
            max_bytes=MAX_STATUS_FILE_BYTES,
            missing_ok=True,
        )
    except ToolExecutionFailure as error:
        if error.code == CMP_TOOL_CAP_EXCEEDED:
            return _job_status_error(
                job_id,
                f"job status file exceeds {MAX_STATUS_FILE_BYTES} byte limit",
                "status_too_large",
            )
        return _job_status_error(job_id, "failed to read status", "read_failed")
    if raw_bytes is None:
        return {"job_id": job_id, "state": "not_found"}
    return raw_bytes


def read_background_job(workspace_root: Path, job_id: str) -> dict[str, object]:
    """Read status of a background job.  Returns a dict suitable for JSON.

    Fail-closed against a hostile ``job_id`` (path traversal, absolute
    drive/UNC paths, separators) or a hostile/corrupt ``status.json``
    (oversized, non-dict top level, malformed) — every branch below returns
    a typed dict; none of them raise (WIDE-011).
    """
    if not is_valid_job_id(job_id):
        return {
            "job_id": "",
            "state": "invalid_id",
            "error": "job_id must be exactly 12 lowercase hex characters",
            "reason_code": "invalid_job_id",
        }

    try:
        canonical_root = Path(workspace_root).resolve(strict=True)
        store = GuardedWorkspaceStore(canonical_root)
    except (OSError, ToolExecutionFailure):
        return _job_status_error(job_id, "failed to read status", "read_failed")
    with _lock:
        fallback = _terminal_status_fallbacks.get((store.cache_key, job_id))
    if fallback is not None:
        return dict(fallback)
    job_ref = _job_ref(store, job_id)
    status_result = _read_background_status_bytes(
        store,
        store.child(job_ref, "status.json"),
        job_id=job_id,
    )
    if isinstance(status_result, dict):
        return status_result

    expected_output_path = os.path.abspath(
        os.fspath(
            canonical_root
            / TOOL_RESULTS_DIR
            / job_id
            / FULL_OUTPUT_FILE
        )
    )
    parsed = _parse_job_status(
        job_id,
        status_result,
        expected_output_path=expected_output_path,
    )
    return _reconcile_orphaned_running_status(store, job_ref, parsed)
