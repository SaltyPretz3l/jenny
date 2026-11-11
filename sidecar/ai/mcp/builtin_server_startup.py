"""Builtin MCP server process startup: the workspace guard and its own diagnostics log."""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import configure_sidecar_logging

# Records keep the server's logger name (this code moved out of builtin_server).
logger = logging.getLogger("sidecar.ai.mcp.builtin_server")


def _build_workspace_guard(args: argparse.Namespace) -> WorkspaceGuard:
    root = args.workspace_root if isinstance(args.workspace_root, str) else None
    snapshot_root = (
        args.pre_change_snapshot_root
        if isinstance(args.pre_change_snapshot_root, str)
        else None
    )
    recovery_root = str(args.workspace_recovery_root or "").strip()
    mutation_journal = None
    if root and recovery_root:
        from sidecar.ai.routing.mutation_change_set_lifecycle import (
            MutationChangeSetLifecycle,
        )
        from sidecar.ai.tools.workspace_mutation_journal_store import (
            WorkspaceMutationJournalStore,
        )
        from sidecar.ai.tools.workspace_retention import (
            run_recovery_maintenance,
        )

        store = WorkspaceMutationJournalStore.from_version_root(recovery_root)
        # Reconcile abandoned journals before this subprocess accepts tools.
        # Commit maintenance must preserve other live or approval-paused turns.
        # Both retention paths are bounded and best-effort; neither uses a timer.
        try:
            store.reconcile_workspace(root)
        except (OSError, ValueError) as error:
            logger.warning(
                "workspace_retention_maintenance_reconcile_failed",
                extra={"reason": type(error).__name__},
            )
        store.on_commit = lambda *_ids: run_recovery_maintenance(store, root)
        run_recovery_maintenance(store, root)
        mutation_journal = MutationChangeSetLifecycle(store, root)
    return WorkspaceGuard(
        root,
        pre_change_snapshot_root=snapshot_root,
        mutation_journal=mutation_journal,
    )


def _configure_logging(*, log_level: str = "info", capture_mode: str = "redacted") -> bool:
    try:
        # Its own file: this process lives as long as the sidecar, and on Windows a
        # second long-lived handle on sidecar.log blocks every rotation rename.
        log_path = Path.home() / ".companion" / "logs" / "builtin-tools.log"
    except (RuntimeError, OSError):
        return False
    configure_sidecar_logging(
        log_path, log_level=log_level, capture_mode=capture_mode, mirror_to_stderr=False,
    )
    return True
