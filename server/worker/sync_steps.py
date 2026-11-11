"""Synced-workspace steps the supervisor runs around one job (row 106).

The pre-step applies the host's delta and records the pre-run manifest in the root-only control
directory before the command starts. The post-step runs in the successor incarnation, when no
command code is alive, and has the fixed mirror helper write the outbox. Both run the helper as
the job UID; only the collect helper gets the sync group that can traverse to the outbox.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from .job import DEFAULT_GID as JOB_GID
from .job import DEFAULT_UID as JOB_UID
from .job import _job_environment
from .mirror import helper_entry_code
from .security import SYNC_GID

SYNC_PENDING = "sync-pending.json"
SYNC_PENDING_LIMIT = 64 * 1024 * 1024
MIRROR_TIMEOUT_SECONDS = 900.0
PENDING_KEYS = {"schema_version", "job_id", "incarnation", "host", "manifest"}

MirrorRunner = Callable[[str, "bytes | None"], bytes]


class MirrorStepError(RuntimeError):
    """A mirror helper step failed; the host resyncs the whole mirror."""


def run_mirror_helper(operation: str, payload: bytes | None = None) -> bytes:
    """Run the fixed mirror helper as the job UID; collect alone may reach the outbox."""
    completed = subprocess.run(
        [sys.executable, "-I", "-c", helper_entry_code(), operation],
        input=payload or b"",
        capture_output=True,
        timeout=MIRROR_TIMEOUT_SECONDS,
        check=False,
        close_fds=True,
        start_new_session=True,
        cwd="/",
        user=JOB_UID,
        group=JOB_GID,
        extra_groups=[SYNC_GID] if operation == "collect" else [],
        env=_job_environment(),
    )
    if completed.returncode != 0:
        raise MirrorStepError("mirror_helper_failed")
    return completed.stdout


def pre_step(
    mirror: MirrorRunner, args: dict[str, Any], persist: Callable[[dict[str, Any]], None]
) -> None:
    """Apply the delta and durably record the manifest the post-step diffs against."""
    manifest = json.loads(mirror("apply", None).decode("utf-8"))
    if not isinstance(manifest, dict):
        raise MirrorStepError("mirror_manifest_invalid")
    persist({
        "schema_version": 1,
        "job_id": args["job_id"],
        "incarnation": args["incarnation"],
        "host": socket.gethostname(),
        "manifest": manifest,
    })


def post_step(
    mirror: MirrorRunner, pending_path: Path, data: bytes | None,
    previous_result: dict[str, Any] | None,
) -> bool:
    """Collect the previous job's changes once; returns whether the helper ran."""
    try:
        if data is None:
            return False
        pending = json.loads(data.decode("utf-8"))
        if not (
            isinstance(pending, dict)
            and set(pending) == PENDING_KEYS
            and pending["schema_version"] == 1
            and isinstance(pending["manifest"], dict)
            and previous_result is not None
            and previous_result["job_id"] == pending["job_id"]
            and previous_result["incarnation"] == pending["incarnation"]
            # The same container: a different one has its own outbox and mirror run.
            and pending["host"] == socket.gethostname()
        ):
            return False
        request = {"manifest": pending["manifest"], "job_id": pending["job_id"]}
        mirror("collect", json.dumps(request, separators=(",", ":")).encode())
        return True
    except (OSError, ValueError, MirrorStepError, subprocess.SubprocessError):
        # No outbox means the host refuses write-back and resyncs the whole mirror.
        return False
    finally:
        try:
            pending_path.unlink()
        except OSError:
            pass
