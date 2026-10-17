"""Terminal mutation settlement shared by live runs and discarded approval plans."""
from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_live_owner import (
    held_owner_path,
    release_live_owner,
    run_journal_owner,
)

logger = logging.getLogger(__name__)


def settle_run_change_set(run: Any, *, reason: str) -> None:
    """Always release live ownership; unsuccessful durability remains recoverable."""
    from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle

    change_set_id = str(getattr(run, "_jenny_change_set_id", "") or "").strip()
    owner = run_journal_owner(run)
    if not change_set_id or owner is None:
        return
    store, root = owner
    session_id, turn_id = _run_identity(run)
    path = held_owner_path(store.version_root, change_set_id,
                           session_id=session_id, turn_id=turn_id)
    try:
        if path is None:
            path = store.live_owner_path(workspace_identity(root).workspace_id, change_set_id)
        cancelled = bool(getattr(getattr(getattr(run, "runtime", None), "cancel_handle", None),
                                 "cancelled", False))
        interrupted = cancelled or any(
            word in reason for word in ("interrupt", "cancel", "discard"))
        failed = any(not bool(getattr(item, "success", True))
                     for item in getattr(run, "outcomes", ()))
        result = MutationChangeSetLifecycle(store, root).finalize(
            change_set_id, interrupted=interrupted, tool_failed=failed)
        if not result.ok:
            logger.warning("workspace_mutation_settlement_unconfirmed", extra={
                "reason": getattr(result.failure, "reason", "unknown")})
        if result.record is not None and result.record["state"] == "committed":
            _maintain(store, root)
    finally:
        if path is not None:
            release_live_owner(path, session_id=session_id, turn_id=turn_id)


def discard_approval_mutations(plan: Any, *, config: Any) -> None:
    """Terminate a process-local plan, while durable checkpoint handoffs stay pinned."""
    run = SimpleNamespace(_jenny_change_set_id=getattr(plan, "change_set_id", ""),
        session_id=getattr(plan, "session_id", ""), request_id=getattr(plan, "request_id", ""),
        request_context=getattr(plan, "request_context", None),
        outcomes=getattr(plan, "outcomes", ()), kernel=SimpleNamespace(_config=config))
    try:
        owner = run_journal_owner(run)
        if owner is not None and run._jenny_change_set_id:
            from sidecar.ai.tools.workspace_mutation_checkpoint import has_runtime_checkpoint
            store, root = owner
            session_id, turn_id = _run_identity(run)
            path = held_owner_path(store.version_root, run._jenny_change_set_id,
                                   session_id=session_id, turn_id=turn_id)
            workspace_id = (path.parent.parent.name if path is not None
                            else workspace_identity(root).workspace_id)
            loaded = store.load(workspace_id, run._jenny_change_set_id)
            if loaded.ok and loaded.record is not None and has_runtime_checkpoint(
                    loaded.record, allow_preparing=True):
                return
        settle_run_change_set(run, reason="approval_discarded")
    except Exception as error:  # noqa: BLE001 - terminal cleanup cannot mask the turn result.
        logger.warning("workspace_mutation_approval_cleanup_failed",
                       extra={"reason": type(error).__name__})


def _maintain(store: Any, root: str) -> None:
    try:
        from sidecar.ai.tools.workspace_retention import run_recovery_maintenance
        run_recovery_maintenance(store, root)
    except Exception as error:  # noqa: BLE001 - maintenance is best-effort.
        logger.warning("workspace_recovery_maintenance_failed",
                       extra={"reason": type(error).__name__})


def _run_identity(run: Any) -> tuple[str, str]:
    attribution = getattr(run, "_jenny_mutation_attribution", None)
    context = getattr(run, "request_context", None)
    session_id = str(getattr(attribution, "session_id", None)
                     or getattr(run, "session_id", "") or "")
    turn_id = str(getattr(attribution, "turn_id", None)
        or getattr(run, "logical_turn_id", None) or getattr(context, "logical_turn_id", None)
        or getattr(getattr(run, "runtime", None), "logical_turn_id", None)
        or getattr(run, "request_id", "") or "")
    return session_id, turn_id
