"""Mid-turn background-job notices: announce finished jobs to the model before its next generation.

``session.job_settled`` parks normalized job dicts on the turn's queue (``turn_job_notices``).
Each iteration the tool loop drains them here: jobs whose settled status the model already read
this turn are acknowledged silently, the rest become one harness note. The note carries state and
exit code only, never output (the model reads that with ``check_background_job``).
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any

from sidecar.runtime.turn_job_notices import current_pending_job_notices

if TYPE_CHECKING:
    from sidecar.ai.routing.tool_loop_run import _ToolLoopRun

logger = logging.getLogger(__name__)

_READ_TOOLS = frozenset({"check_background_job", "stop_background_job"})
_SETTLED_OUTPUT_RE = re.compile(r'"state"\s*:\s*"(?:completed|failed)"')
_OUTPUT_SCAN_CHARS = 4096
_NOTE_PREFIX = "[Harness note, not a message from the user]"
_NOTE_CLOSING = (
    "Its output is not shown here: read it with check_background_job when you need it. "
    "Carry on with your current step if it does not depend on this result."
)


def _already_read_job_ids(outcomes: list[Any]) -> set[str]:
    """Job ids whose settled status a check/stop outcome in this turn already reported."""
    read: set[str] = set()
    for outcome in outcomes:
        if getattr(outcome, "tool_name", None) not in _READ_TOOLS:
            continue
        tool_input = getattr(outcome, "tool_input", None)
        job_id = tool_input.get("job_id") if isinstance(tool_input, dict) else None
        output = getattr(outcome, "output", None)
        if (
            isinstance(job_id, str)
            and isinstance(output, str)
            and _SETTLED_OUTPUT_RE.search(output[:_OUTPUT_SCAN_CHARS])
        ):
            read.add(job_id)
    return read


def _job_line(job: dict[str, Any]) -> str:
    if job["state"] == "stopped":
        return f"- {job['job_id']} (`{job['command']}`): stopped by the user"
    exit_code = job.get("exit_code")
    exit_text = f", exit {exit_code}" if isinstance(exit_code, int) else ""
    return f"- {job['job_id']} (`{job['command']}`): {job['state']}{exit_text}"


def render_job_notice(jobs: list[dict[str, Any]]) -> str:
    """The harness note announcing ``jobs`` (one job: singular wording, 2+: plural)."""
    if len(jobs) == 1:
        head = f"{_NOTE_PREFIX} A background job you started finished:"
    else:
        head = f"{_NOTE_PREFIX} Background jobs you started finished:"
    return "\n".join([head, *(_job_line(job) for job in jobs), _NOTE_CLOSING])


def drain_job_notices(loop: "_ToolLoopRun", iteration: int) -> None:
    """Announce parked finished jobs before the next generation, then acknowledge them all.

    A sub-agent never drains its parent's notices. The acknowledgement covers every drained id
    (announced or already read), so Electron marks them read and no post-turn wake follows.
    Logs carry counts, never a command.
    """
    import sidecar.ai.routing.tool_loop as _tl_hub

    if loop.is_sub_agent_request:
        return
    pending = current_pending_job_notices()
    if pending is None:
        return
    jobs = pending.drain()
    if not jobs:
        return
    already_read = _already_read_job_ids(loop.outcomes)
    announce = [job for job in jobs if job["job_id"] not in already_read]
    if announce:
        loop.working_messages.append({"role": "user", "content": render_job_notice(announce)})
    job_ids = [str(job["job_id"]) for job in jobs]
    event = _tl_hub.BackgroundJobNoticeConsumedEvent(job_ids=job_ids, iteration=iteration)
    loop.runtime.emit(event)
    _tl_hub.log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.job_notices_consumed",
        message="Mid-turn background-job notices were drained.",
        status="active",
        data={"count": len(job_ids), "announced": len(announce), "iteration": iteration},
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
