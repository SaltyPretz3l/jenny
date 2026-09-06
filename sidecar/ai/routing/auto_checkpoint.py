"""First-repo-mutation auto-checkpoint hook for the tool loop.

Default-on (flag ``auto_checkpoint``): before the *first*
repo-mutating tool call of an agent run is dispatched, request a
git-ref checkpoint from the Electron side over the internal
``__jenny_git_checkpoint`` tool-bridge call so the user has a restore
point predating the run's changes. The Electron handler owns turning
that request into an actual git ref; this module only decides *when*
to ask and never inspects the result beyond logging it.

Best-effort by design: any failure (no bridge available, timeout,
``MCPError``, or anything else) is logged as a warning and swallowed --
an auto-checkpoint hiccup must never break the turn.

Naming note: deliberately avoids the word "snapshot" -- that term is
already owned by ``tool_execution_snapshots.py`` for the unrelated
read-before-write cache concept.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any

from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.electron_tool_bridge import (
    ElectronToolBridgeRequest,
    execute_electron_tool,
)
from sidecar.runtime.tool_execution_support import is_feature_flag_enabled

logger = logging.getLogger(__name__)

AUTO_CHECKPOINT_FLAG = "auto_checkpoint"

# Tools that mutate the active repo root and therefore warrant a checkpoint
# before the first one runs. Deliberately EXCLUDES:
#   - worktree_* tools: they write to a sibling worktree directory, not the
#     active root, so there is nothing in the root to checkpoint.
#   - web/artifact/browser side-effecting tools: their side effects live
#     outside the repo working tree.
REPO_MUTATING_TOOL_NAMES = frozenset(
    {"write_file", "edit_file", "delete_file", "move_file", "run_command"}
)

_CHECKPOINT_TOOL_NAME = "__jenny_git_checkpoint"


def should_create_checkpoint(
    *,
    feature_flags: dict[str, bool] | None,
    already_created: bool,
    tool_ids: Iterable[str],
) -> bool:
    """Pure decision: is this the moment to fire an auto-checkpoint?

    True iff the flag is enabled, no checkpoint has been created yet this
    run, and at least one of ``tool_ids`` is repo-mutating.
    """
    if already_created:
        return False
    if not is_feature_flag_enabled(feature_flags or {}, AUTO_CHECKPOINT_FLAG):
        return False
    return any(tool_id in REPO_MUTATING_TOOL_NAMES for tool_id in tool_ids)


def _request_checkpoint(loop_run: Any) -> Any | None:
    """Issue the electron-tool-bridge checkpoint request, or ``None`` if no
    bridge is wired up (headless / test runtime -- not an error).

    Uses ``loop_run.request_id`` (the enclosing TURN's request id), NOT a
    freshly minted id: the Electron-side handler correlates the response by
    the turn's request id, so a fresh id would never be matched.
    """
    runtime = loop_run.runtime
    runtime.raise_if_interrupted()
    write_message = getattr(runtime, "electron_tool_writer", None)
    if write_message is None:
        return None
    request = ElectronToolBridgeRequest(
        tool_name=_CHECKPOINT_TOOL_NAME,
        arguments={"session_id": loop_run.session_id},
        request_id=str(loop_run.request_id or ""),
        trace_id=getattr(runtime, "trace_id", None),
        session_id=loop_run.session_id,
        tool_call_id=f"{_CHECKPOINT_TOOL_NAME}:{loop_run.request_id}",
        write_message=write_message,
        read_message=getattr(runtime, "electron_tool_reader", None),
        response_reader_factory=getattr(runtime, "electron_tool_reader_factory", None),
        timeout_seconds=runtime.tool_timeout_seconds(15.0),
        logger=logger,
        cancel_handle=getattr(runtime, "cancel_handle", None),
    )
    return execute_electron_tool(request)


def maybe_create_auto_checkpoint(loop_run: Any, remaining: list[tuple[Any, int]]) -> None:
    """Fire the auto-checkpoint at most once per ``loop_run``.

    ``remaining`` is the ``(call, index)`` list returned by
    ``pre_filter_tool_calls`` for the current iteration -- the set of tool
    calls about to be dispatched (parallel or sequential).

    Note on approval-pause/resume: ``checkpoint_created`` lives on
    ``_ToolLoopRun``, which is reconstructed fresh on every approval-resume,
    so a resumed run MAY fire a second checkpoint. That is harmless -- it is
    just a distinct, later git-derived restore point on the Electron side --
    not a duplicate. Strict once-per-turn-across-resume would require
    threading this flag through ``ApprovalPlan``; left as a follow-up since
    it is not required for correctness here.
    """
    # Cheapest gate first: once this run has checkpointed, every later
    # tool-call iteration must do nothing. Return before walking config or the
    # dispatch set (this runs on every iteration that has tool calls).
    if getattr(loop_run, "checkpoint_created", False):
        return
    feature_flags = getattr(getattr(loop_run.kernel, "_config", None), "feature_flags", None)
    # tool_ids stays lazy (a generator): should_create_checkpoint tests the flag
    # before it consumes them, so the dispatch set is never walked on the common
    # flag-off path.
    if not should_create_checkpoint(
        feature_flags=feature_flags,
        already_created=False,
        tool_ids=(call.tool_id for call, _ in remaining),
    ):
        return
    if not loop_run.session_id:
        # Headless / no session to attribute the checkpoint to -- skip silently.
        return

    # Set BEFORE attempting so a failure never retries on every subsequent
    # iteration of this run.
    loop_run.checkpoint_created = True
    try:
        result = _request_checkpoint(loop_run)
        if result is None:
            # No electron tool bridge wired up (headless/test runtime) --
            # this is a skip, not a failure, so no event is logged.
            return
        metadata = result.metadata or {}
        if result.success and metadata.get("created"):
            log_event(
                logger,
                logging.INFO,
                component="ai.router",
                event="ai.router.auto_checkpoint_created",
                message="Auto-checkpoint created before first repo-mutating tool call",
                status="success",
                data={"request_id": loop_run.request_id, "ref": metadata.get("ref")},
            )
        else:
            failure_detail = getattr(result, "output", None) or getattr(result, "message", None)
            reason = metadata.get("reason") or str(
                failure_detail or "checkpoint_not_created"
            ).strip()[:200]
            log_event(
                logger,
                logging.INFO,
                component="ai.router",
                event="ai.router.auto_checkpoint_skipped",
                message=f"Auto-checkpoint skipped: {reason}",
                status="skipped",
                data={"request_id": loop_run.request_id, "reason": reason},
            )
    except TerminalChatStateError:
        raise
    except Exception as error:  # noqa: BLE001 - best-effort, must never break the turn
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.auto_checkpoint_failed",
            message=f"Auto-checkpoint failed: {error}",
            status="degraded",
            data={"request_id": loop_run.request_id, "error": str(error)},
        )
