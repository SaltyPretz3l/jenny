"""Waiting on background shell jobs.

Two paths share one poll loop: ``check_background_job`` with ``wait_ms`` blocks
until the job leaves ``running``, and a sleep-only ``run_command`` (``ping -n N
127.0.0.1``, ``timeout /t N``, ``sleep N``, ``Start-Sleep N``) issued while a
background job of the same workspace is running ends as soon as one of those
jobs settles instead of sleeping out its full duration (2026-11-01 session
review: a model slept 70 s past its finished test suite). A pure sleep has no
effect besides time, so the intercepted command never spawns a process.
"""

from __future__ import annotations

import re
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path

from sidecar.ai.tools.builtins import cancellation
from sidecar.ai.tools.builtins.shell_background import active_job_ids, read_background_job
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore

MAX_WAIT_MS = 600_000
POLL_INTERVAL_SECONDS = 0.5
# With both a Stop (abort) and a person's message (wake) to watch, the pause blocks on the
# abort event in slices this long and looks at the wake between them (an Event cannot be
# waited on in pairs): Stop stays immediate, a message ends the wait within a quarter second,
# and an idle wait wakes four times a second rather than spinning.
WAKE_POLL_SECONDS = 0.25

_REDIRECTS = r"(?:\s*(?:[12]?>\s*(?:nul|/dev/null)|2>&1))*"
# Each pattern captures the requested seconds; ping counts echo requests, one
# second apart, so N requests sleep N - 1 seconds.
_SLEEP_PATTERNS: tuple[tuple[re.Pattern[str], int], ...] = tuple(
    (re.compile(rf"\s*{body}{_REDIRECTS}\s*", re.IGNORECASE), offset)
    for body, offset in (
        (r"ping\s+-[nc]\s+(\d+)\s+(?:127\.0\.0\.1|localhost)", -1),
        (r"timeout\s+/t\s+(\d+)(?:\s+/nobreak)?", 0),
        (r"sleep\s+(\d+(?:\.\d+)?)s?", 0),
        (r"start-sleep\s+(?:-s(?:econds)?\s+)?(\d+(?:\.\d+)?)", 0),
        (
            r"(?:powershell|pwsh)(?:\.exe)?(?:\s+-(?!c\b|command\b)\w+)*\s+-(?:c|command)\s+"
            r"([\"']?)start-sleep\s+(?:-s(?:econds)?\s+)?(\d+(?:\.\d+)?)\1",
            0,
        ),
    )
)


def sleep_only_seconds(command: str) -> float | None:
    """Seconds a sleep-only command waits, else ``None`` (anything else runs)."""
    for pattern, offset in _SLEEP_PATTERNS:
        match = pattern.fullmatch(command)
        if match is not None:
            return max(0.0, float(match.groups()[-1]) + offset)
    return None


def _pause(
    seconds: float, abort_event: threading.Event | None, wake_event: threading.Event | None
) -> None:
    """Sleep up to *seconds*, ending early on the abort event or the wake event."""
    if wake_event is None or abort_event is None:
        event = wake_event or abort_event
        (event.wait if event is not None else time.sleep)(seconds)
        return
    end = time.monotonic() + seconds
    while not wake_event.is_set() and not abort_event.is_set():
        left = end - time.monotonic()
        if left <= 0:
            return
        abort_event.wait(min(WAKE_POLL_SECONDS, left))


def wait_for_settle(  # noqa: PLR0913 - explicit wait inputs, all keyword-only
    workspace_root: Path,
    job_ids: list[str],
    *,
    max_seconds: float,
    abort_event: threading.Event | None = None,
    wake_event: threading.Event | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[str, dict[str, object]] | None:
    """Poll until one of *job_ids* leaves ``running``; ``None`` on timeout, cancel or wake.

    Returns the first settled job's id and status. A job that cannot be read
    counts as settled so its caller reports it instead of waiting it out. A set
    *wake_event* (a person's message arrived, row 180) ends the wait without
    stopping any job: the caller tells a wake from a timeout by ``wake_event.is_set()``.
    """
    deadline = clock() + max(0.0, max_seconds)
    while True:
        for job_id in job_ids:
            status = read_background_job(workspace_root, job_id)
            if status.get("state") != "running":
                return job_id, status
        remaining = deadline - clock()
        if (
            remaining <= 0
            or (abort_event is not None and abort_event.is_set())
            or (wake_event is not None and wake_event.is_set())
        ):
            return None
        _pause(min(POLL_INTERVAL_SECONDS, remaining), abort_event, wake_event)


def interrupted_message(job_id: str) -> str:
    """Model-facing wording when a person's message ended a wait on a still-running job."""
    return (
        f"The person sent a message. Job {job_id} is still running; "
        "you will be told when it finishes."
    )


def wait_on_background_job(
    workspace_root: Path, job_id: str, max_seconds: float
) -> dict[str, object]:
    """``check_background_job wait_ms``: the job's status after waiting for it to settle.

    When a person's message ended the wait early the status stays ``running`` and carries
    ``interrupted_by_user_message`` plus the model-facing note.
    """
    wake = cancellation.current_wake_event()
    settled = wait_for_settle(
        workspace_root,
        [job_id],
        max_seconds=max_seconds,
        abort_event=cancellation.current_abort_event(),
        wake_event=wake,
    )
    if settled is not None:
        return settled[1]
    status = read_background_job(workspace_root, job_id)
    if wake is not None and wake.is_set() and status.get("state") == "running":
        status["interrupted_by_user_message"] = True
        status["message"] = interrupted_message(job_id)
    return status


def running_workspace_jobs(workspace_root: Path) -> list[str]:
    """Background jobs this process runs for *workspace_root*'s store."""
    try:
        store_key = GuardedWorkspaceStore(workspace_root).cache_key
    except Exception:  # noqa: BLE001 - an unreadable root has no jobs to wait on.
        return []
    return active_job_ids(store_key=store_key)


def sleep_until_job_settles(
    seconds: float,
    workspace_root: Path,
    job_ids: list[str],
    *,
    abort_event: threading.Event | None = None,
    wake_event: threading.Event | None = None,
) -> dict[str, object]:
    """Run a sleep-only command as a wait on *job_ids*; the run_command payload fields.

    It ends early only once every one of them settled: any still running may be
    what the sleep is for (a dev server booting while a lint job finishes). A
    person's message (*wake_event*) ends it at once with the jobs still running.
    """
    started = time.monotonic()
    deadline = started + max(0.0, seconds)
    waiting = list(job_ids)
    settled: tuple[str, dict[str, object]] | None = None
    while waiting:
        found = wait_for_settle(
            workspace_root,
            waiting,
            max_seconds=deadline - time.monotonic(),
            abort_event=abort_event,
            wake_event=wake_event,
        )
        if found is None:
            break
        settled = found
        waiting.remove(found[0])
    slept = round(time.monotonic() - started, 1)
    if waiting and wake_event is not None and wake_event.is_set():
        return {
            "slept_seconds": slept,
            "interrupted_by_user_message": True,
            "message": interrupted_message(waiting[0]),
        }
    if waiting or settled is None:
        still = ", ".join(waiting or job_ids)
        return {
            "slept_seconds": slept,
            "message": (
                f"Background job {still} is still running. You are told when it finishes, so "
                "keep working; to block until then, call check_background_job with wait_ms."
            ),
        }
    job_id, status = settled
    return {
        "slept_seconds": slept,
        "ended_early": True,
        "background_job": {
            "job_id": job_id,
            "state": status.get("state"),
            "exit_code": status.get("exit_code"),
        },
        "message": (
            f"Stopped waiting after {slept:g} s because background job {job_id} "
            f"finished ({status.get('state')}). Read its output with check_background_job."
        ),
    }


def sleep_payload_if_waiting(
    command: str,
    arguments: Mapping[str, object],
    timeout_seconds: float,
    workspace_root: Callable[[], Path],
    *,
    abort_event: threading.Event | None = None,
) -> dict[str, object] | None:
    """A foreground sleep while a workspace job runs waits on the job; None runs it."""
    if arguments.get("run_in_background") is True:
        return None
    seconds = sleep_only_seconds(command)
    if seconds is None:
        return None
    root = workspace_root()
    job_ids = running_workspace_jobs(root)
    if not job_ids:
        return None
    return sleep_until_job_settles(
        min(seconds, timeout_seconds),
        root,
        job_ids,
        abort_event=abort_event,
        wake_event=cancellation.current_wake_event(),
    )
