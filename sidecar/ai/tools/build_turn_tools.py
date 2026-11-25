"""Typed tools a build turn must keep under tool-schema budget pressure (HB-029).

The budget filter keeps ``tool_search`` and every history un-deferral as
mandatory, so a long session could fill the cap before the typed file tools got
a slot and an approved build turn ran without ``edit_file``. This leaf names the
floor the filter adds to its mandatory set. It only chooses among the filter's
candidates, so it never resurrects a tool the contract marks unavailable.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from sidecar.ai.mode_policy import policy_for_mode

if TYPE_CHECKING:
    from sidecar.runtime.chat_models import ChatRequestContext

BUILD_TURN_FLOOR = ("read_file", "edit_file", "write_file", "run_command")
_APPROVED_PLAN_EXTRA = ("todo_write",)

_CODE_TASK_RE = re.compile(
    r"\b("
    r"code|codebase|repo|repository|source|implementation|implement|fix|bug|"
    r"test|tests|failing|trace|debug|refactor|module|file|files|class|"
    r"function|runtime|renderer|electron|sidecar|ipc|protocol|tool|"
    r"context|prompt|lsp|manifest|schema|migration"
    r")\b",
    re.IGNORECASE,
)


def looks_like_coding_task(value: str) -> bool:
    return bool(_CODE_TASK_RE.search(str(value or "")))


def build_turn_floor_names(
    request_context: ChatRequestContext, relevance_text: str
) -> tuple[str, ...]:
    """Return the floor for a build turn, or ``()`` when the turn cannot build.

    An approved plan (from an earlier turn or approved in this one) gets the
    floor plus ``todo_write``; a coding request with a bound workspace gets the
    floor. Plan Mode, read-only requests and modes without side-effecting tools
    get nothing.
    """
    if request_context.plan_mode or request_context.read_only:
        return ()
    if not policy_for_mode(request_context.mode).allow_side_effecting_tools:
        return ()
    if request_context.approved_plan or request_context.plan_approved_in_turn:
        return (*BUILD_TURN_FLOOR, *_APPROVED_PLAN_EXTRA)
    if not request_context.workspace_root_present:
        return ()
    return BUILD_TURN_FLOOR if looks_like_coding_task(relevance_text) else ()
