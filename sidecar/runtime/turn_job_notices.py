"""Mid-turn background-job notices: ``session.job_settled`` parks finished jobs on the live turn.

Mirrors the mid-turn mail hops (``turn_state``): an unversioned inbound notification is
admitted onto the matching live turn's queue, a contextvar hands the queue to the worker's
tool loop, and the loop drains it before its next generation.
"""

from __future__ import annotations

import logging
import re
import threading
import unicodedata
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any, Iterator

from sidecar.runtime.turn_state import TurnLookup

MAX_JOBS_PER_FRAME = 8
MAX_PENDING_JOB_NOTICES = 16
MAX_NOTICE_COMMAND_CHARS = 120

_JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_SETTLED_STATES = frozenset({"completed", "failed", "stopped"})
_UNSAFE_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp"})
_WHITESPACE_RE = re.compile(r"\s+")


def sanitize_job_command(raw: str) -> str:
    """Make a command safe to quote in a harness note: no control chars or backticks, clipped."""
    # Control/format characters, line/paragraph separators and backticks (same set as
    # ``promptCommand`` in services/backend/background-job-mid-turn.js).
    spaced = "".join(
        " " if ch == "`" or unicodedata.category(ch) in _UNSAFE_CATEGORIES else ch for ch in raw
    )
    clean = _WHITESPACE_RE.sub(" ", spaced).strip()
    if len(clean) > MAX_NOTICE_COMMAND_CHARS:
        return f"{clean[: MAX_NOTICE_COMMAND_CHARS - 1]}…"
    return clean


def _normalize_job(job: Any) -> dict[str, Any] | None:
    """Return a clean job dict, or None when the entry is malformed."""
    if not isinstance(job, dict):
        return None
    job_id = job.get("job_id")
    state = job.get("state")
    exit_code = job.get("exit_code")
    command = job.get("command")
    if not isinstance(job_id, str) or not _JOB_ID_RE.fullmatch(job_id):
        return None
    if state not in _SETTLED_STATES or not isinstance(command, str):
        return None
    if exit_code is not None and (isinstance(exit_code, bool) or not isinstance(exit_code, int)):
        return None
    return {
        "job_id": job_id,
        "command": sanitize_job_command(command),
        "state": state,
        "exit_code": exit_code,
    }


@dataclass
class PendingJobNoticeQueue:
    """Finished background jobs parked for the tool loop: normalized job dicts.

    Bounded per turn (not per drain): a job id is accepted at most once and at most
    ``MAX_PENDING_JOB_NOTICES`` ids are ever accepted, the earliest kept.
    """

    _jobs: list[dict[str, Any]] = field(default_factory=list)
    _accepted_ids: set[str] = field(default_factory=set)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def push(self, jobs: list[dict[str, Any]]) -> tuple[list[str], int]:
        """Queue jobs in order; returns (accepted job ids, dropped job count)."""
        accepted: list[str] = []
        dropped = 0
        with self._lock:
            for job in jobs:
                job_id = job["job_id"]
                full = len(self._accepted_ids) >= MAX_PENDING_JOB_NOTICES
                if job_id in self._accepted_ids or full:
                    dropped += 1
                    continue
                self._accepted_ids.add(job_id)
                self._jobs.append(job)
                accepted.append(job_id)
        return accepted, dropped

    def drain(self) -> list[dict[str, Any]]:
        """Return and clear the queued jobs (the per-turn bound is not reset)."""
        with self._lock:
            jobs, self._jobs = self._jobs, []
        return jobs


_PENDING_JOB_NOTICES: ContextVar[PendingJobNoticeQueue | None] = ContextVar(
    "sidecar_pending_job_notices",
    default=None,
)


@contextmanager
def bind_pending_job_notices(queue: PendingJobNoticeQueue) -> Iterator[None]:
    token: Token[PendingJobNoticeQueue | None] = _PENDING_JOB_NOTICES.set(queue)
    try:
        yield
    finally:
        _PENDING_JOB_NOTICES.reset(token)


def current_pending_job_notices() -> PendingJobNoticeQueue | None:
    return _PENDING_JOB_NOTICES.get()


def _non_empty_str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def admit_job_settled(params: dict[str, Any], lookup: TurnLookup, logger: logging.Logger) -> None:
    """Park ``session.job_settled`` jobs on the matching live turn's queue.

    A notification: never raises and never answers. Commands are user data, so the
    logs carry ids and counts only, never a command.
    """
    try:
        session_id = _non_empty_str(params.get("session_id"))
        request_id = _non_empty_str(params.get("request_id"))
        jobs = params.get("jobs")
        if not session_id or not request_id or not isinstance(jobs, list):
            logger.warning(
                "Ignored malformed background-job notice",
                extra={"event": "sidecar.runtime.job_settled.invalid"},
            )
            return
        handle = lookup(session_id)
        queue = getattr(handle, "pending_job_notices", None)
        live = handle is not None and handle.request_id == request_id
        if not live or not isinstance(queue, PendingJobNoticeQueue):
            logger.info(
                "Ignored background-job notice for a turn that is not live",
                extra={
                    "event": "sidecar.runtime.job_settled.stale",
                    "session_id": session_id,
                    "request_id": request_id,
                },
            )
            return
        context = {"session_id": session_id, "request_id": request_id}
        read = jobs[:MAX_JOBS_PER_FRAME]
        valid = [job for job in map(_normalize_job, read) if job is not None]
        accepted, _queue_dropped = queue.push(valid)
        dropped = len(jobs) - len(accepted)
        if dropped:
            logger.warning(
                "Dropped invalid, duplicate or over-bound background-job notices",
                extra={
                    "event": "sidecar.runtime.job_settled.dropped",
                    "count": dropped,
                    **context,
                },
            )
        logger.info(
            "Queued background-job notices",
            extra={
                "event": "sidecar.runtime.job_settled",
                "accepted": len(accepted),
                "dropped": dropped,
                **context,
            },
        )
    except Exception:  # noqa: BLE001 - a notification handler must never break the reader.
        logger.warning(
            "Background-job notice handling failed",
            extra={"event": "sidecar.runtime.job_settled.failed"},
        )
