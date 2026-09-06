"""Lifecycle ownership for background subprocesses spawned by the sidecar."""

from __future__ import annotations

import atexit

# Bound on this module on purpose: the Windows branch of ``process_exists`` is
# exercised by substituting ``subprocess_manager.ctypes.windll``, and that seam
# predates the move of the Win32 calls into process_containment. Both modules
# see the same stdlib module object, so the name staying here keeps the seam
# addressable from either side.
import ctypes  # noqa: F401
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from sidecar.ai.error_codes import CMP_MEMORY_BACKGROUND_TIMEOUT

# Platform liveness/containment lives in process_containment, and so do the
# receipt observers (root_reaped / tree_is_empty / surviving_pids / build_receipt)
# that read a child THROUGH one. The names are re-bound here under their original
# spellings so importers keep working - background_worker takes process_exists
# from this module - but a test substituting the POSIX group probe must patch it
# on process_containment, which is where the callers now live.
from sidecar.runtime.process_containment import (  # noqa: F401
    ChildContainment,
    ContainmentPolicy,
    ContainmentUnavailableError,
    TerminationReceipt,
    build_receipt,
    confirm_child_containment,
    create_child_containment,
    open_child_containment,
    process_exists,
    root_reaped,
    surviving_pids,
    tree_is_empty,
)
from sidecar.runtime.process_containment import (  # noqa: F401
    uses_posix_process_groups as _uses_posix_process_groups,
)

# Re-bound under the original private names for compatibility.
from sidecar.runtime.worker_payload import (  # noqa: F401
    build_background_env as _build_background_env,
)
from sidecar.runtime.worker_payload import (  # noqa: F401
    write_worker_payload as _write_worker_payload,
)
from sidecar.runtime.worker_secrets import (
    deliver_secrets_frame,
    encode_secrets_frame,
    split_config_secrets,
)

logger = logging.getLogger(__name__)

_DEFAULT_CLOSE_TIMEOUT_SECONDS = 5.0
# How long the escalation ladder is willing to wait for the kernel to finish
# tearing a tree down after kill_tree(). TerminateJobObject and killpg(SIGKILL)
# are both asynchronous: they mark the processes, they do not block until the
# last one is off the scheduler. Anything longer than a couple of seconds is a
# stuck tree, not a slow one, and the receipt should say so.
_CONTAINMENT_VERIFY_SECONDS = 2.0
_CONTAINMENT_VERIFY_POLL_SECONDS = 0.02
_POSIX_SIGKILL = getattr(signal, "SIGKILL", 9)
_POSIX_SIGTERM = getattr(signal, "SIGTERM", 15)



class TaskAlreadyRunningError(RuntimeError):
    """A spawn was rejected because its task key is still occupied.

    A distinct type rather than a bare ``RuntimeError`` because callers branch
    on it: image generation reports "already generating" to the renderer, while
    every other spawn failure is a genuine fault. Matching on the message text
    was the only alternative and it is not a contract.
    """

    def __init__(self, task_key: str) -> None:
        super().__init__(f"background task already running: {task_key}")
        self.task_key = str(task_key)


@dataclass
class ManagedSubprocess:
    task_key: str
    process: subprocess.Popen[bytes]
    payload_path: Path | None = None
    waiter: threading.Thread | None = None
    containment: ChildContainment | None = None
    # Set while an explicit termination is escalating through the rungs. The
    # waiter thread reaps concurrently and would otherwise close the containment
    # the moment the root exits - which is BEFORE the receipt interrogates it,
    # leaving the receipt to answer "is the tree empty?" from the uncontained
    # fallback. On Windows that fallback has no descendant evidence at all and
    # returns True, so the race turned a verified claim into a fail-open.
    terminating: bool = False


@dataclass
class _StartingReservation:
    """Identity-bound reservation held while ``Popen`` is in flight."""

    task_key: str
    payload_path: Path | None = None
    payload_cleanup_claimed: bool = False


@dataclass(frozen=True)
class SubprocessDrainResult:
    """Bounded close result for sidecar-owned subprocess reservations."""

    drained: bool
    child_count: int
    reservation_count: int
    unreaped_count: int
    manager_count: int = 1


class SubprocessManager:
    """Track all background workers and stop them on sidecar shutdown."""

    def __init__(
        self,
        *,
        popen_factory: Callable[..., subprocess.Popen[bytes]] | None = None,
        containment_factory: Callable[..., ChildContainment | None] | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._state_changed = threading.Condition(self._lock)
        self._children: dict[str, ManagedSubprocess | _StartingReservation] = {}
        self._closed = False
        self._close_timeout_seconds = _DEFAULT_CLOSE_TIMEOUT_SECONDS
        self._popen_factory = popen_factory or subprocess.Popen
        # Injectable so containment behaviour is testable off Windows, and so a
        # test never has to reach past the public surface to reshape it.
        # ``None`` means "resolve create_child_containment at spawn time", which
        # also keeps the module-global name substitutable.
        self._containment_factory = containment_factory
        # atexit covers the ordinary interpreter exit; the parent watchdog and
        # ordered shutdown close the injected manager on the paths atexit
        # cannot reach (os._exit).
        atexit.register(self.close)

    def is_task_running(self, task_key: str) -> bool:
        with self._lock:
            child = self._children.get(str(task_key))
            if child is None:
                return False
            if isinstance(child, _StartingReservation):
                return True
            return not self._is_child_reaped(child)

    def spawn_json_worker(  # noqa: PLR0913 - explicit process boundary contract.
        self,
        task_name: str,
        payload: dict[str, Any],
        *,
        payload_dir: Path,
        task_key: str,
        secrets: dict[str, Any] | None = None,
        timeout_seconds: float | None = None,
    ) -> subprocess.Popen[bytes]:
        safe_task_key = str(task_key).strip()
        if not safe_task_key:
            raise ValueError("task_key is required")
        sanitized, lifted = self._prepare_worker_payload(payload, secrets)
        # Encode first: an oversize or unencodable frame must fail with nothing
        # written to disk and no child process running.
        frame = encode_secrets_frame(lifted)
        payload_path = _write_worker_payload(payload_dir, sanitized)
        process = self.spawn_module(
            "sidecar.runtime.background_worker",
            args=[task_name, str(payload_path)],
            task_key=safe_task_key,
            payload_path=payload_path,
            stdin_pipe=True,
        )
        # Only now, with the child already inside the Windows Job Object.
        self._deliver_worker_secrets(process, frame, task_key=safe_task_key)
        if timeout_seconds is not None and float(timeout_seconds) > 0:
            self._watch_worker_deadline(
                process,
                task_key=safe_task_key,
                timeout_seconds=float(timeout_seconds),
            )
        return process

    def _watch_worker_deadline(
        self,
        process: subprocess.Popen[bytes],
        *,
        task_key: str,
        timeout_seconds: float,
    ) -> None:
        def _watch() -> None:
            try:
                process.wait(timeout=timeout_seconds)
                return
            except subprocess.TimeoutExpired:
                logger.warning(
                    "background worker deadline exceeded",
                    extra={
                        "event": "sidecar.runtime.background_worker.timeout",
                        "code": CMP_MEMORY_BACKGROUND_TIMEOUT,
                        "task_type": task_key.partition(":")[0],
                    },
                )
            self.terminate_task(task_key, timeout_seconds=1.0)

        threading.Thread(
            target=_watch,
            daemon=True,
            name=f"background-deadline:{task_key}",
        ).start()

    def _prepare_worker_payload(
        self,
        payload: dict[str, Any],
        secrets: dict[str, Any] | None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Lift secrets out of the payload config and FORWARD them, never drop.

        A stray secret key that lands in the payload config becomes both a
        security no-op (it leaves the file) and a behavior no-op (it still
        reaches the worker over stdin).
        """
        sanitized = dict(payload) if isinstance(payload, dict) else {}
        raw_config = sanitized.get("config")
        if isinstance(raw_config, dict):
            scrubbed, lifted = split_config_secrets(raw_config)
            sanitized["config"] = scrubbed
        else:
            lifted = {}
        explicit = dict(secrets) if isinstance(secrets, dict) else {}
        return sanitized, {**lifted, **explicit}

    def _deliver_worker_secrets(
        self,
        process: subprocess.Popen[bytes],
        frame: bytes,
        *,
        task_key: str,
    ) -> bool:
        """Release the credential into the running child. Never raises.

        Must not touch the manager lock: the write is bounded by a join timeout
        inside ``deliver_secrets_frame``, and a wedged child must never stall
        another spawn.
        """
        stdin = getattr(process, "stdin", None)
        if frame and stdin is None:
            logger.debug(
                "background worker has no control pipe for secret handoff task_key=%s",
                task_key,
            )
            return False
        return deliver_secrets_frame(stdin, frame, task_key=task_key)

    def spawn_module(
        self,
        module: str,
        *,
        args: list[str] | None = None,
        task_key: str,
        payload_path: Path | None = None,
        stdin_pipe: bool = False,
    ) -> subprocess.Popen[bytes]:
        safe_task_key = str(task_key).strip()
        if not safe_task_key:
            raise ValueError("task_key is required")
        reservation = self._reserve_start(safe_task_key, payload_path)
        command, popen_kwargs = self._build_module_launch(module, args, stdin_pipe=stdin_pipe)
        # automation_run is restartable and idempotent; failing it closed on a
        # host without Job Objects would cost more than its bounded process.
        return self._launch(
            reservation,
            safe_task_key,
            command,
            popen_kwargs,
            policy=ContainmentPolicy.BEST_EFFORT,
        )

    def _launch(
        self,
        reservation: _StartingReservation,
        task_key: str,
        command: list[str],
        popen_kwargs: dict[str, Any],
        *,
        policy: ContainmentPolicy,
    ) -> subprocess.Popen[bytes]:
        """Create containment, spawn, then confirm containment - in that order.

        The job/session has to exist before ``Popen`` because its launch flags
        are part of the spawn, and confirmation has to happen immediately after
        because descendants created in the gap are not retroactively contained.
        That gap is unavoidable without an intermediary launcher process, which
        is rejected for this worker (see the note in ``imagegen/worker_client``:
        its stdin is the protocol channel, and an intermediary would make the
        manager wait on the wrong process).
        """
        try:
            containment = self._open_containment(task_key, policy)
        except Exception:
            # The reservation was taken before this point, so a refusal here has
            # to give the task key back or it stays occupied by nothing.
            self._cancel_start(reservation)
            raise
        if containment is not None:
            popen_kwargs = {**popen_kwargs, **containment.popen_kwargs()}
        try:
            process = self._popen_factory(command, **popen_kwargs)
        except Exception:
            if containment is not None:
                containment.close()
            self._cancel_start(reservation)
            raise
        try:
            containment = self._contain_child(containment, process, task_key, policy)
        except ContainmentUnavailableError:
            # Kill BEFORE releasing the reservation: the key is the only thing
            # keeping a replacement worker from racing this one for the GPU.
            self._kill_uncontained_child(task_key, process)
            self._cancel_start(reservation)
            raise
        return self._attach_started_child(
            reservation,
            task_key,
            process,
            payload_path=reservation.payload_path,
            containment=containment,
        )

    def _open_containment(
        self,
        task_key: str,
        policy: ContainmentPolicy,
    ) -> ChildContainment | None:
        return open_child_containment(
            task_key=task_key,
            policy=policy,
            factory=self._containment_factory or create_child_containment,
        )

    def _contain_child(
        self,
        containment: ChildContainment | None,
        process: subprocess.Popen[bytes],
        task_key: str,
        policy: ContainmentPolicy,
    ) -> ChildContainment | None:
        return confirm_child_containment(
            containment,
            pid=int(getattr(process, "pid", 0) or 0),
            task_key=task_key,
            policy=policy,
        )

    def _kill_uncontained_child(
        self,
        task_key: str,
        process: subprocess.Popen[bytes],
    ) -> None:
        try:
            process.kill()
        except Exception:  # noqa: BLE001
            logger.warning(
                "failed to kill uncontained subprocess task_key=%s pid=%s",
                task_key,
                getattr(process, "pid", 0),
                exc_info=True,
            )
        try:
            process.wait(timeout=_CONTAINMENT_VERIFY_SECONDS)
        except Exception:  # noqa: BLE001
            logger.error(
                "uncontained subprocess did not exit after kill task_key=%s pid=%s",
                task_key,
                getattr(process, "pid", 0),
            )

    def _attach_started_child(
        self,
        reservation: _StartingReservation,
        task_key: str,
        process: subprocess.Popen[bytes],
        *,
        payload_path: Path | None = None,
        containment: ChildContainment | None = None,
    ) -> subprocess.Popen[bytes]:
        child = ManagedSubprocess(
            task_key=task_key,
            process=process,
            payload_path=payload_path,
            containment=containment,
        )
        waiter = threading.Thread(
            target=self._wait_for_exit,
            args=(child,),
            daemon=True,
            name=f"background-waiter:{task_key}",
        )
        child.waiter = waiter
        if not self._publish_started_child(reservation, child):
            self._settle_rejected_start(reservation, child)
            raise RuntimeError("background subprocess manager is closed")
        try:
            waiter.start()
        except Exception:
            self._rollback_waiter_start(child)
            raise
        return process

    def terminate_task(
        self,
        task_key: str,
        *,
        timeout_seconds: float = _DEFAULT_CLOSE_TIMEOUT_SECONDS,
    ) -> TerminationReceipt:
        """Terminate one managed child by key and report what was verified.

        Idempotent. An unknown key yields ``known=False`` with
        ``terminated=True``: keys are removed only by ``_finalize_child``, which
        runs only once a child is proven reaped, so "not tracked" really does
        mean "nothing of ours is running under that key".
        """
        safe_task_key = str(task_key)
        with self._lock:
            child = self._children.get(safe_task_key)
        if not isinstance(child, ManagedSubprocess):
            return TerminationReceipt(
                task_key=safe_task_key,
                known=False,
                reaped=True,
                contained=False,
                tree_empty=True,
                escalated="",
            )
        receipt = self._terminate_child(child, timeout_seconds=timeout_seconds)
        if receipt.terminated:
            self._finalize_child(child.task_key, expected_child=child)
        return receipt

    def _reserve_start(
        self,
        task_key: str,
        payload_path: Path | None,
    ) -> _StartingReservation:
        reservation = _StartingReservation(
            task_key=task_key,
            payload_path=payload_path,
        )
        stale_child: ManagedSubprocess | None = None
        spawn_error: RuntimeError | None = None
        with self._state_changed:
            if self._closed:
                spawn_error = RuntimeError("background subprocess manager is closed")
            else:
                existing = self._children.get(task_key)
                if isinstance(existing, _StartingReservation) or (
                    isinstance(existing, ManagedSubprocess)
                    and not self._is_child_reaped(existing)
                ):
                    spawn_error = TaskAlreadyRunningError(task_key)
                else:
                    if isinstance(existing, ManagedSubprocess):
                        stale_child = existing
                    self._children[task_key] = reservation
        if stale_child is not None:
            self._cleanup_payload(stale_child)
            self._close_containment(stale_child)
        if spawn_error is not None:
            self._cleanup_payload_path(payload_path)
            raise spawn_error
        return reservation

    def _build_module_launch(
        self,
        module: str,
        args: list[str] | None,
        *,
        stdin_pipe: bool = False,
    ) -> tuple[list[str], dict[str, Any]]:
        command = [sys.executable, "-m", module, *(args or [])]
        env = _build_background_env()
        # No platform branch here any more: the launch flags that create the
        # group/job belong to the containment object, which is the thing that
        # later has to reap what they created.
        # stdout/stderr likewise stay DEVNULL; only the control pipe is ever
        # opened, and only so a credential can be released off-disk.
        popen_kwargs: dict[str, Any] = {
            "stdin": subprocess.PIPE if stdin_pipe else subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "env": env,
        }
        if stdin_pipe:
            popen_kwargs["bufsize"] = 0
        return command, popen_kwargs

    def _publish_started_child(
        self,
        reservation: _StartingReservation,
        child: ManagedSubprocess,
    ) -> bool:
        with self._state_changed:
            if self._children.get(reservation.task_key) is not reservation:
                return False
            # Containment is established in _launch, before publication, so this
            # method no longer performs a fail-open assign under the lock: by
            # the time a child reaches the registry it is either contained or
            # its policy has already decided that is acceptable.
            if self._closed:
                return False
            self._children[reservation.task_key] = child
            self._state_changed.notify_all()
            return True

    def _cancel_start(self, reservation: _StartingReservation) -> None:
        payload_path: Path | None = None
        with self._state_changed:
            if self._children.get(reservation.task_key) is reservation:
                self._children.pop(reservation.task_key, None)
                if not reservation.payload_cleanup_claimed:
                    reservation.payload_cleanup_claimed = True
                    payload_path = reservation.payload_path
                self._state_changed.notify_all()
        self._cleanup_payload_path(payload_path)

    def _settle_rejected_start(
        self,
        reservation: _StartingReservation,
        child: ManagedSubprocess,
    ) -> None:
        reaped = False
        try:
            reaped = bool(
                self._terminate_child(
                    child,
                    timeout_seconds=self._close_timeout_seconds,
                )
            )
        finally:
            reaped = reaped or self._is_child_reaped(child)
            if reaped:
                self._cancel_start(reservation)
            else:
                self._retain_unreaped_start(reservation, child)

    def _retain_unreaped_start(
        self,
        reservation: _StartingReservation,
        child: ManagedSubprocess,
    ) -> None:
        with self._state_changed:
            if self._children.get(reservation.task_key) is reservation:
                if reservation.payload_cleanup_claimed:
                    child.payload_path = None
                self._children[reservation.task_key] = child
                self._state_changed.notify_all()
        logger.error(
            "background subprocess remained alive after rejected start; "
            "retaining lifecycle ownership task_key=%s pid=%s",
            child.task_key,
            getattr(child.process, "pid", 0),
        )
        waiter = child.waiter
        if waiter is None:
            return
        try:
            waiter.start()
        except Exception:  # noqa: BLE001
            logger.error(
                "background subprocess waiter failed to start; retaining registry ownership "
                "task_key=%s pid=%s",
                child.task_key,
                getattr(child.process, "pid", 0),
                exc_info=True,
            )

    def _rollback_waiter_start(self, child: ManagedSubprocess) -> None:
        reaped = self._terminate_child(
            child,
            timeout_seconds=self._close_timeout_seconds,
        )
        if reaped:
            self._finalize_child(child.task_key, expected_child=child)
            return
        logger.error(
            "background subprocess waiter start failed and child remains alive; "
            "retaining lifecycle ownership task_key=%s pid=%s",
            child.task_key,
            getattr(child.process, "pid", 0),
        )

    def _wait_for_exit(self, child: ManagedSubprocess) -> None:
        try:
            child.process.wait()
        except Exception:  # noqa: BLE001
            logger.warning(
                "background subprocess waiter failed task_key=%s pid=%s",
                child.task_key,
                getattr(child.process, "pid", 0),
                exc_info=True,
            )
        while not self._is_child_reaped(child):
            with self._state_changed:
                if self._children.get(child.task_key) is not child:
                    return
                self._state_changed.wait(timeout=0.05)
        self._finalize_child(child.task_key, expected_child=child)

    def _cleanup_payload(self, child: ManagedSubprocess) -> None:
        self._cleanup_payload_path(child.payload_path)

    def _cleanup_payload_path(self, payload_path: Path | None) -> None:
        if payload_path is None:
            return
        try:
            payload_path.unlink(missing_ok=True)
        except OSError:
            logger.debug("failed to remove background worker payload", exc_info=True)

    def _finalize_child(
        self,
        task_key: str,
        *,
        expected_child: ManagedSubprocess | None = None,
    ) -> None:
        with self._lock:
            candidate = self._children.get(task_key)
            if not isinstance(candidate, ManagedSubprocess) or (
                expected_child is not None and candidate is not expected_child
            ):
                return
            child = self._children.pop(task_key)
        if not isinstance(child, ManagedSubprocess):
            return
        self._cleanup_payload(child)
        # Safe to drop the handle only here: _finalize_child runs exclusively
        # for children whose tree has been observed empty, so KILL_ON_JOB_CLOSE
        # has nothing left to kill.
        self._close_containment(child)

    def _close_containment(self, child: ManagedSubprocess) -> None:
        containment = child.containment
        if containment is None:
            return
        if child.terminating:
            # An explicit termination owns the handle until it has built its
            # receipt; it closes the containment itself on the way out.
            return
        child.containment = None
        try:
            containment.close()
        except Exception:  # noqa: BLE001
            logger.debug("failed to close child containment", exc_info=True)

    def close(
        self,
        timeout_seconds: float = _DEFAULT_CLOSE_TIMEOUT_SECONDS,
    ) -> SubprocessDrainResult:
        normalized_timeout = max(float(timeout_seconds), 0.0)
        deadline = time.monotonic() + normalized_timeout
        children, timed_out_payload_paths = self._begin_close(deadline)
        if children is None:
            with self._lock:
                unreaped_count = sum(
                    isinstance(child, ManagedSubprocess)
                    and not self._is_child_reaped(child)
                    for child in self._children.values()
                )
            return SubprocessDrainResult(
                drained=unreaped_count == 0,
                child_count=0,
                reservation_count=0,
                unreaped_count=unreaped_count,
            )
        for payload_path in timed_out_payload_paths:
            self._cleanup_payload_path(payload_path)
        self._stop_and_join_children(children, deadline)
        reaped_children = self._remove_reaped_children(children)
        for child in reaped_children:
            self._cleanup_payload(child)
        unreaped_count = sum(not self._is_child_reaped(child) for child in children)
        for child in children:
            # Whole-manager close is the one place where dropping a handle on a
            # still-populated job is the point: KILL_ON_JOB_CLOSE is the final
            # backstop for anything the escalation ladder could not reach.
            self._close_containment(child)
        return SubprocessDrainResult(
            drained=unreaped_count == 0 and not timed_out_payload_paths,
            child_count=len(children),
            reservation_count=len(timed_out_payload_paths),
            unreaped_count=unreaped_count,
        )

    def _begin_close(
        self,
        deadline: float,
    ) -> tuple[list[ManagedSubprocess] | None, list[Path]]:
        timed_out_payload_paths: list[Path] = []
        with self._state_changed:
            if self._closed:
                return None, timed_out_payload_paths
            self._closed = True
            self._close_timeout_seconds = max(deadline - time.monotonic(), 0.0)
            while any(
                isinstance(child, _StartingReservation)
                for child in self._children.values()
            ):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._state_changed.wait(timeout=remaining)
            for child in self._children.values():
                if (
                    isinstance(child, _StartingReservation)
                    and not child.payload_cleanup_claimed
                ):
                    child.payload_cleanup_claimed = True
                    if child.payload_path is not None:
                        timed_out_payload_paths.append(child.payload_path)
            children = [
                child
                for child in self._children.values()
                if isinstance(child, ManagedSubprocess)
            ]
        return children, timed_out_payload_paths

    def _stop_and_join_children(
        self,
        children: list[ManagedSubprocess],
        deadline: float,
    ) -> None:
        if children:
            with ThreadPoolExecutor(max_workers=len(children)) as executor:
                for child in children:
                    executor.submit(
                        self._terminate_child,
                        child,
                        deadline=deadline,
                    )
        for child in children:
            waiter = child.waiter
            if waiter is None or waiter is threading.current_thread() or not waiter.is_alive():
                continue
            waiter.join(timeout=max(deadline - time.monotonic(), 0))

    def _remove_reaped_children(
        self,
        children: list[ManagedSubprocess],
    ) -> list[ManagedSubprocess]:
        with self._lock:
            remaining_children: list[ManagedSubprocess] = []
            for child in children:
                if (
                    self._children.get(child.task_key) is child
                    and self._is_child_reaped(child)
                ):
                    self._children.pop(child.task_key, None)
                    remaining_children.append(child)
        return remaining_children

    def _is_child_reaped(self, child: ManagedSubprocess) -> bool:
        return root_reaped(child) and tree_is_empty(child)

    def _wait_for_child_until(
        self,
        child: ManagedSubprocess,
        *,
        deadline: float,
        stage: str,
    ) -> bool:
        try:
            child.process.wait(timeout=max(deadline - time.monotonic(), 0.0))
        except subprocess.TimeoutExpired:
            return self._is_child_reaped(child)
        except Exception:  # noqa: BLE001
            logger.warning(
                "background subprocess %s wait failed task_key=%s pid=%s",
                stage,
                child.task_key,
                getattr(child.process, "pid", 0),
                exc_info=True,
            )
        return self._is_child_reaped(child)

    def _signal_child(
        self,
        child: ManagedSubprocess,
        *,
        force: bool,
    ) -> None:
        action = "kill" if force else "terminate"
        if _uses_posix_process_groups():
            kill_process_group = getattr(os, "killpg", None)
            if callable(kill_process_group):
                try:
                    group_id = int(child.process.pid)
                    group_signal = _POSIX_SIGKILL if force else _POSIX_SIGTERM
                    kill_process_group(group_id, group_signal)
                    return
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "background subprocess group %s failed; falling back to direct handle "
                        "task_key=%s pid=%s",
                        action,
                        child.task_key,
                        getattr(child.process, "pid", 0),
                        exc_info=True,
                    )
        direct_signal = child.process.kill if force else child.process.terminate
        direct_signal()

    def _terminate_child(
        self,
        child: ManagedSubprocess,
        *,
        timeout_seconds: float | None = None,
        deadline: float | None = None,
    ) -> TerminationReceipt:
        """Escalate terminate -> kill -> kill_tree, re-verifying at every rung."""
        # Claim the containment handle for the duration. Without this the waiter
        # thread finalizes the instant the root exits, and every receipt built
        # after that point reports `contained=False` with a `tree_empty` that
        # nothing actually verified.
        child.terminating = True
        try:
            return self._escalate_termination(
                child, timeout_seconds=timeout_seconds, deadline=deadline
            )
        finally:
            child.terminating = False
            with self._lock:
                still_tracked = self._children.get(child.task_key) is child
            if not still_tracked:
                # The waiter thread finalized this child while we held the
                # handle, so its own close was skipped and the job object would
                # otherwise leak. Ownership comes back here.
                self._close_containment(child)

    def _escalate_termination(
        self,
        child: ManagedSubprocess,
        *,
        timeout_seconds: float | None = None,
        deadline: float | None = None,
    ) -> TerminationReceipt:
        if self._is_child_reaped(child):
            return build_receipt(child, escalated="")
        close_deadline = (
            float(deadline)
            if deadline is not None
            else time.monotonic() + max(float(timeout_seconds or 0.0), 0.0)
        )
        for force in (False, True):
            stage = "kill" if force else "terminate"
            try:
                self._signal_child(child, force=force)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "background subprocess %s failed task_key=%s pid=%s",
                    stage,
                    child.task_key,
                    getattr(child.process, "pid", 0),
                    exc_info=True,
                )
            if self._wait_for_child_until(child, deadline=close_deadline, stage=stage):
                return build_receipt(child, escalated=stage)
        return self._kill_tree_and_verify(child)

    def _kill_tree_and_verify(self, child: ManagedSubprocess) -> TerminationReceipt:
        """Last rung: reap through containment, then prove the tree is empty.

        ``kill()`` reached one pid. On Windows that is the root and nothing else,
        so a compile-worker fan-out survives it entirely; on POSIX the group
        signal can still lose a child that re-parented itself. Only the
        containment object addresses the whole tree - and, crucially, only it can
        answer whether the tree is now gone, which is what makes the returned
        receipt a statement of fact rather than an assumption.
        """
        containment = child.containment
        if containment is not None:
            try:
                containment.kill_tree()
            except Exception:  # noqa: BLE001
                logger.warning(
                    "background subprocess tree kill failed task_key=%s",
                    child.task_key,
                    exc_info=True,
                )
        # TerminateJobObject and killpg(SIGKILL) both return before the kernel
        # has finished unwinding the processes, so the answer is polled.
        verify_deadline = time.monotonic() + _CONTAINMENT_VERIFY_SECONDS
        receipt = build_receipt(child, escalated="kill_tree")
        while not receipt.terminated and time.monotonic() < verify_deadline:
            time.sleep(_CONTAINMENT_VERIFY_POLL_SECONDS)
            receipt = build_receipt(child, escalated="kill_tree")
        if receipt.terminated:
            return receipt
        logger.error(
            "background subprocess tree survived containment kill; retaining lifecycle "
            "ownership task_key=%s pid=%s contained=%s surviving_pids=%s",
            child.task_key,
            getattr(child.process, "pid", 0),
            receipt.contained,
            receipt.surviving_pids[:32],
        )
        return receipt
