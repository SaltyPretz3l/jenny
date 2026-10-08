"""First-repo-mutation auto-checkpoint hook for the tool loop.

Always on for desktop runs: before the *first*
repo-mutating tool call of an agent run is dispatched, request a
git-ref checkpoint from the Electron side over the internal
``__jenny_git_checkpoint`` tool-bridge call so the user has a restore
point predating the run's changes. The Electron handler owns turning
that request into an actual git ref; this module decides *when* to ask
and records the outcome on the run as its restore point (row 34 S5):
``git_checkpoint`` (the ref), ``head`` (the tree was clean) or ``none``
with a reason. :func:`inject_restore_point` hands that record to builtin
scripted calls as a private argument so their user-only
``scripted_change_review`` names it; the model never sees it.

The retired ``auto_checkpoint`` feature flag (1.2.1) survives only as a
sidecar-internal policy key: ``sidecar.ai.config`` writes
``feature_flags["auto_checkpoint"] = False`` for the hosted and desktop
execution-sandbox policies, and an explicit ``False`` is the only value that
disables the hook. A missing key (Electron no longer ships it) means on.

Best-effort by design: any failure (no bridge available, timeout,
``MCPError``, or anything else) is logged as a warning and swallowed --
an auto-checkpoint hiccup must never break the turn.

Naming note: deliberately avoids the word "snapshot" -- that term is
already owned by ``tool_execution_snapshots.py`` for the unrelated
read-before-write cache concept.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_DISABLED
from sidecar.ai.host_policy import host_policy_is_enforced
from sidecar.ai.routing.mutation_change_set_lifecycle import (
    _CURRENT_RUN,
    SCRIPTED_MUTATION_TOOLS,
    TYPED_MUTATION_TOOLS,
)
from sidecar.ai.tools.builtins import scripted_restore_point as _restore_points
from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.electron_tool_bridge import (
    ElectronToolBridgeRequest,
    execute_electron_tool,
)

logger = logging.getLogger(__name__)

AUTO_CHECKPOINT_POLICY_KEY = "auto_checkpoint"

# Tools that may mutate the active repo root and therefore warrant a checkpoint
# before the first one runs: the typed file tools plus every scripted tool
# (a shell command, temp script or python_execute can rewrite source too).
# This is a "may mutate" set decided before the call; whether a call actually
# changed anything is decided after it from its evidence (verification_gate,
# the undo set). Deliberately EXCLUDES:
#   - worktree_* tools: they write to a sibling worktree directory, not the
#     active root, so there is nothing in the root to checkpoint.
#   - web/artifact/browser side-effecting tools: their side effects live
#     outside the repo working tree.
CHECKPOINT_BEFORE_TOOL_NAMES = TYPED_MUTATION_TOOLS | SCRIPTED_MUTATION_TOOLS

_CHECKPOINT_TOOL_NAME = "__jenny_git_checkpoint"
# Electron's bridge result for this op (electron-tool-bridge.js): a not-a-repo
# root comes back ok:false with NO reason (WorkspaceGitService._notARepo); a
# clean tree is ok:true with ``nothing_to_checkpoint``.
_CHECKPOINT_RESULT_KIND = "auto_checkpoint"
_CLEAN_TREE_REASON = "nothing_to_checkpoint"
_ANCHORED_KINDS = frozenset({"git_checkpoint", "head"})


def should_create_checkpoint(
    *,
    feature_flags: dict[str, bool] | None,
    already_created: bool,
    tool_ids: Iterable[str],
) -> bool:
    """Pure decision: is this the moment to fire an auto-checkpoint?

    True iff no execution policy disabled it, no checkpoint has been created
    yet this run, and at least one of ``tool_ids`` may mutate the repo.
    """
    if already_created:
        return False
    if (feature_flags or {}).get(AUTO_CHECKPOINT_POLICY_KEY) is False:
        return False
    return any(tool_id in CHECKPOINT_BEFORE_TOOL_NAMES for tool_id in tool_ids)


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


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _none(reason: str) -> dict[str, str]:
    return {"kind": "none", "reason": reason}


def restore_point_from_result(result: Any | None) -> dict[str, str]:
    """Map the bridge's checkpoint result onto the run's restore point.

    ``None`` (no bridge wired up) is ``unavailable``; an Electron refusal by
    execution policy (``CMP-TOOL-0002``) is ``disabled``; every other result
    that is neither a created checkpoint nor a clean tree is ``failed``.
    """
    if result is None:
        return _none("unavailable")
    metadata = getattr(result, "metadata", None) or {}
    success = getattr(result, "success", False) is True
    reason = str(metadata.get("reason") or "")
    if success and metadata.get("created") is True:
        point = _restore_points.bounded_restore_point({
            "kind": "git_checkpoint", "ref": metadata.get("ref"), "created_at": _utc_now(),
        })
        return point or _none("failed")
    if success and reason == _CLEAN_TREE_REASON:
        return {"kind": "head", "created_at": _utc_now()}
    if not success and not reason and metadata.get("result_kind") == _CHECKPOINT_RESULT_KIND:
        return _none("not_git")
    if getattr(result, "error_code", None) == CMP_TOOL_DISABLED:
        return _none("disabled")
    return _none("failed")


def _earlier_anchored_point(loop_run: Any) -> dict[str, str] | None:
    """A ``git_checkpoint``/``head`` this turn already recorded and can still see.

    An approval-resume rebuilds the run but seeds it with the turn's earlier
    outcomes, whose scripted reviews carry the restore point they ran under.
    """
    current = _restore_points.bounded_restore_point(getattr(loop_run, "restore_point", None))
    if current is not None and current["kind"] in _ANCHORED_KINDS:
        return current
    for outcome in getattr(loop_run, "outcomes", None) or ():
        review = (getattr(outcome, "metadata", None) or {}).get("scripted_change_review")
        if isinstance(review, Mapping):
            point = _restore_points.bounded_restore_point(review.get("restore_point"))
            if point is not None and point["kind"] in _ANCHORED_KINDS:
                return point
    return None


def _record_restore_point(loop_run: Any, point: dict[str, str]) -> None:
    loop_run.restore_point = _earlier_anchored_point(loop_run) or point


def _record_disabled(loop_run: Any, remaining: list[tuple[Any, int]]) -> None:
    if getattr(loop_run, "restore_point", None) is None and any(
        call.tool_id in CHECKPOINT_BEFORE_TOOL_NAMES for call, _ in remaining
    ):
        _record_restore_point(loop_run, _none("disabled"))


def inject_restore_point(tool_arguments: dict[str, Any], *, call: Any, descriptor: Any) -> None:
    """Give a builtin scripted call the bound run's restore point (never model-visible).

    Dispatch-time only, like the trace id: it never enters the frozen approval
    inputs. Calls dispatched before the run's checkpoint decision get nothing.
    """
    if (
        call.tool_id not in SCRIPTED_MUTATION_TOOLS
        or getattr(descriptor, "server_name", "") != BUILTIN_MCP_SERVER_NAME
    ):
        return
    context = _CURRENT_RUN.get()
    point = _restore_points.bounded_restore_point(
        getattr(context.run, "restore_point", None) if context is not None else None
    )
    if point is not None:
        tool_arguments[_restore_points.RESTORE_POINT_ARGUMENT_KEY] = point


def prepare_resume_restore_point(  # noqa: PLR0913 - the resumed run's identity, spelled out.
    runtime: Any, remaining: list[tuple[Any, int]], *, kernel: Any, request_id: str,
    session_id: str | None, outcomes: list[Any],
) -> None:
    """Checkpoint before an approved batch runs and bind its restore point.

    The approval pause comes before the paused run's checkpoint, so the
    resumed batch (dispatched with ``runtime`` as the bound run) takes its own
    restore point here; an earlier one in the turn's outcomes still wins.
    """
    resumed = SimpleNamespace(
        runtime=runtime, kernel=kernel, request_id=request_id, session_id=session_id,
        outcomes=outcomes, checkpoint_created=False, restore_point=None,
    )
    maybe_create_auto_checkpoint(resumed, remaining)
    if resumed.restore_point is not None:
        runtime.__dict__["restore_point"] = resumed.restore_point


def maybe_create_auto_checkpoint(loop_run: Any, remaining: list[tuple[Any, int]]) -> None:
    """Fire the auto-checkpoint at most once per ``loop_run``.

    ``remaining`` is the ``(call, index)`` list returned by
    ``pre_filter_tool_calls`` for the current iteration -- the set of tool
    calls about to be dispatched (parallel or sequential).

    The outcome becomes ``loop_run.restore_point``; a policy that disables
    the hook records ``disabled`` without marking a checkpoint as created.

    Note on approval-pause/resume: ``checkpoint_created`` lives on
    ``_ToolLoopRun``, which is reconstructed fresh on every approval-resume,
    so a resumed run MAY fire a second checkpoint. That is harmless -- it is
    just a distinct, later git-derived restore point on the Electron side --
    not a duplicate. The run's restore point keeps an earlier
    ``git_checkpoint``/``head`` of the turn when the resumed run's outcomes
    still show one. Strict once-per-turn-across-resume would require
    threading this flag through ``ApprovalPlan``; left as a follow-up since
    it is not required for correctness here.
    """
    # Cheapest gate first: once this run has checkpointed, every later
    # tool-call iteration must do nothing. Return before walking config or the
    # dispatch set (this runs on every iteration that has tool calls).
    if getattr(loop_run, "checkpoint_created", False):
        return
    config = getattr(loop_run.kernel, "_config", None)
    feature_flags = getattr(config, "feature_flags", None)
    if host_policy_is_enforced(config) or (feature_flags or {}).get(
        AUTO_CHECKPOINT_POLICY_KEY
    ) is False:
        _record_disabled(loop_run, remaining)
        return
    # tool_ids stays lazy (a generator).
    if not should_create_checkpoint(
        feature_flags=feature_flags,
        already_created=False,
        tool_ids=(call.tool_id for call, _ in remaining),
    ):
        return
    if not loop_run.session_id:
        # Headless / no session to attribute the checkpoint to -- skip silently.
        _record_restore_point(loop_run, _none("unavailable"))
        return

    # Set BEFORE attempting so a failure never retries on every subsequent
    # iteration of this run.
    loop_run.checkpoint_created = True
    try:
        result = _request_checkpoint(loop_run)
        _record_restore_point(loop_run, restore_point_from_result(result))
        if result is None:
            # No electron tool bridge wired up (headless/test runtime) --
            # this is a skip, not a failure, so no event is logged.
            return
        _log_checkpoint_result(loop_run, result)
    except TerminalChatStateError:
        raise
    except Exception as error:  # noqa: BLE001 - best-effort, must never break the turn
        _record_restore_point(loop_run, _none("failed"))
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.auto_checkpoint_failed",
            message=f"Auto-checkpoint failed: {error}",
            status="degraded",
            data={"request_id": loop_run.request_id, "error": str(error)},
        )


def _log_checkpoint_result(loop_run: Any, result: Any) -> None:
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
        return
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
