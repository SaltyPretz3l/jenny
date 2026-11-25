"""Row 184 W3: a delegate task in write mode works in its own git worktree.

Electron issues the worktree on the parent's request and vouches for its root
(``services/backend/helper-worktree-authority.js``); the child's execution context
is the parent's with that root, so builtin file tools bind to the worktree and
never to the parent's checkout. A writing helper runs only on a cloud model, in
Auto, with a project folder. Its other rules live where they are enforced: the
builtin-only and no-``.git`` dispatch rule in ``route_policy_runtime``, the
worktree-answering admission in ``sub_agent_invocation``, the no-card rule in
``tool_loop_recovery``. After the child, the worktree is measured and settled
(``sidecar/runtime/helper_worktree_admission.py``): an unchanged one is removed,
a changed one is kept on its branch for the parent to review and merge.
"""

from __future__ import annotations

import re
from dataclasses import replace
from typing import Any, Callable

from sidecar.ai.config_models import is_cloud_engine_type
from sidecar.ai.error_codes import CMP_TOOL_POLICY_DENIED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.routing.delegation_contract import DELEGATE_MODE_WRITE
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.helper_worktree_admission import worktree_changes, worktree_head
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED


def write_task_refusal(*, router: Any, parent_context: Any, runtime: Any, route: Any) -> str:
    """Why this turn cannot start a writing helper, or '' when it can.

    Electron re-checks the binding (Auto, root, not read-only, not handoff) and a
    hosted server has no worktree service, so both sides fail closed.
    """
    config = getattr(router, "_config", None)
    execution_context = getattr(parent_context, "execution_context", None)
    admission = getattr(runtime, "operation_admission", None)
    checks = (
        (is_cloud_engine_type(getattr(config, "engine_type", None)),
         "Writing helpers need a cloud model."),
        (not route.local, "A writing helper cannot run on the local helper model."),
        (getattr(execution_context, "root_path", None) is not None,
         "The chat has no project folder to make a worktree of."),
        (parent_context.approval_mode == "auto_run",
         "Writing helpers run only when the run mode is Auto."),
        (not (parent_context.plan_mode or parent_context.propose_mode or parent_context.read_only),
         "Writing helpers are unavailable in Plan, Propose and read-only turns."),
        (callable(getattr(admission, "helper_worktree", None)),
         "Writing helpers are unavailable here."),
    )
    return next((message for allowed, message in checks if not allowed), "")


def task_invoker(  # noqa: PLR0913 - the scheduler's explicit task inputs.
    *, router: Any, parent_context: Any, runtime: Any, task: Any, route: Any,
    invoke: Callable[..., Any],
) -> Callable[..., Any]:
    """``invoke`` for a read task; for a write task, ``invoke`` wrapped in a worktree."""
    if task.mode != DELEGATE_MODE_WRITE:
        return invoke
    refusal = write_task_refusal(
        router=router, parent_context=parent_context, runtime=runtime, route=route,
    )
    if refusal:
        raise ToolExecutionFailure(code=CMP_TOOL_POLICY_DENIED, message=refusal, retryable=False)
    admission = runtime.operation_admission

    def _invoke_write(**kwargs: Any) -> Any:
        return run_write_task(admission=admission, task=task, invoke=invoke, kwargs=kwargs)

    return _invoke_write


def run_write_task(
    *, admission: Any, task: Any, invoke: Callable[..., Any], kwargs: dict[str, Any],
) -> Any:
    from sidecar.ai.routing.sub_agent_invocation import subagent_failure_result

    identity = kwargs["identity"]
    try:
        worktree = admission.helper_worktree(
            action="create", operation_id=f"{identity.task_id}:worktree",
            name=worktree_name(task),
        )
    except MCPError as error:
        return subagent_failure_result(identity, code=error.code, message=str(error.message))
    parent_context = kwargs["parent_context"]
    write_context = replace(
        parent_context.execution_context,
        root_path=worktree.root_path, root_id=worktree.root_id,
        device_id=worktree.device_id, inode=worktree.inode,
    )
    start = worktree_head(worktree.root_path)
    try:
        result = invoke(write_context=write_context, **kwargs)
    except TerminalChatStateError as error:
        if error.status != TURN_STATE_CANCELLED:
            raise
        # Settled below, so the parent still learns where the partial edits are.
        result = subagent_failure_result(
            identity, message="Sub-agent cancelled by parent.", completion_reason="cancelled",
        )
    except Exception:  # noqa: BLE001 - one failed child; the worktree is still reported.
        result = subagent_failure_result(identity)
    changes = worktree_changes(worktree.root_path, start)
    changed = changes is None or changes["files_changed"] > 0 or changes["commits"] > 0
    try:
        kept = admission.helper_worktree(
            action="settle", operation_id=f"{identity.task_id}:settle",
            helper_worktree_id=worktree.id, keep=changed,
        )
    except Exception:  # noqa: BLE001 - unsettled: Electron offers it for removal at turn end.
        kept = True
    return replace(result, worktree={
        "branch": worktree.branch,
        "path": worktree.root_path,
        "kept": kept,
        **(changes or dict.fromkeys(("files_changed", "insertions", "deletions", "commits"))),
    })


def worktree_name(task: Any) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(task.prompt or "").lower()).strip("-")[:30].strip("-")
    return slug or "helper"


__all__ = ["run_write_task", "task_invoker", "worktree_name", "write_task_refusal"]
