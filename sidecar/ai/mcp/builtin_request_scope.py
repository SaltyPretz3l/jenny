"""Trusted per-call authority binding for the reusable builtin MCP process."""

from __future__ import annotations

import hashlib
import os
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle
from sidecar.ai.tools import contracts as _contracts
from sidecar.ai.tools import hosted_file_io as _hosted_file_io
from sidecar.ai.tools import workspace_mutation_journal_store as _workspace_mutation_journal_store
from sidecar.ai.tools import workspace_retention as _workspace_retention
from sidecar.ai.tools.builtins.knowledge.roots import scoped_knowledge_tools
from sidecar.ai.tools.builtins.skills import scoped_skill_tool
from sidecar.ai.tools.workspace import WorkspaceGuard

TRUSTED_EXECUTION_CONTEXT_KEY = "_jenny_execution_context"
_REQUIRED_FIELDS = frozenset({
    "schema_version", "authority_revision", "project_id", "root_path", "root_id",
    "root_revision", "device_id", "inode", "tool_policy_snapshot", "knowledge_roots",
})
_OPTIONAL_FIELDS = frozenset({"skills_config"})
_MAX_KNOWLEDGE_ROOTS = 32


def _invalid() -> _contracts.ToolExecutionFailure:
    return _contracts.ToolExecutionFailure(
        code=CMP_TOOL_INVALID_PATH,
        message="trusted tool execution context is malformed",
        retryable=False,
    )


def _hosted(host_config: Any) -> bool:
    mode = host_config.get("host_mode") if isinstance(host_config, dict) else getattr(
        host_config, "host_mode", None
    )
    return mode == "server"


@dataclass
class BuiltinRequestScope:
    workspace: WorkspaceGuard
    workspace_device_id: str | None
    workspace_inode: str | None
    knowledge_roots: tuple[str, ...]
    skills_config: dict[str, Any] | None
    hosted: bool
    _stack: ExitStack = field(default_factory=ExitStack, init=False, repr=False)

    def __enter__(self) -> "BuiltinRequestScope":
        self._stack.enter_context(scoped_knowledge_tools(self.knowledge_roots))
        self._stack.enter_context(scoped_skill_tool(self.skills_config))
        self._stack.enter_context(_hosted_file_io.scoped_hosted_file_io(
            str(self.workspace.root) if self.workspace.root is not None else None,
            enabled=self.hosted,
            expected_device_id=self.workspace_device_id,
            expected_inode=self.workspace_inode,
        ))
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._stack.__exit__(exc_type, exc_value, traceback)


def _normalized_path(path: Path) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def _root_id(path: Path) -> str:
    identity = str(path).lower() if os.name == "nt" else str(path)
    return "root_" + hashlib.sha256(identity.encode()).hexdigest()[:24]


def _bound_workspace(value: dict[str, Any]) -> tuple[WorkspaceGuard, str | None, str | None]:
    root_path = value.get("root_path")
    root_id = value.get("root_id")
    device_id = value.get("device_id")
    inode = value.get("inode")
    if root_path is None:
        if any(item is not None for item in (root_id, device_id, inode)):
            raise _invalid()
        return WorkspaceGuard(None), None, None
    if (
        not isinstance(root_path, str)
        or not root_path.strip()
        or not Path(root_path).is_absolute()
        or not isinstance(root_id, str)
        or not root_id.strip()
        or ((device_id is None) != (inode is None))
        or (
            device_id is not None
            and (not isinstance(device_id, str) or not device_id.isdigit() or int(device_id) < 1)
        )
        or (
            inode is not None
            and (not isinstance(inode, str) or not inode.isdigit() or int(inode) < 1)
        )
    ):
        raise _invalid()
    try:
        raw_root = Path(root_path)
        resolved_root = raw_root.resolve(strict=True)
        status = resolved_root.stat()
    except (OSError, RuntimeError):
        raise _invalid() from None
    if (
        not resolved_root.is_dir()
        or _normalized_path(raw_root) != _normalized_path(resolved_root)
        or root_id != _root_id(resolved_root)
        or (
            device_id is not None
            and (str(status.st_dev) != device_id or str(status.st_ino) != inode)
        )
    ):
        raise _invalid()
    workspace = WorkspaceGuard(str(resolved_root))
    if (
        workspace.root is None
        or _normalized_path(workspace.root) != _normalized_path(resolved_root)
    ):
        raise _invalid()
    return workspace, device_id, inode


def _attach_recovery_owner(workspace: WorkspaceGuard, host_config: Any) -> None:
    """Rebind trusted profile services to the verified per-call workspace."""
    if workspace.root is None or not isinstance(host_config, dict):
        return
    snapshot_root = host_config.get("pre_change_snapshot_root")
    workspace.pre_change_snapshot_root = snapshot_root if isinstance(snapshot_root, str) else None
    recovery_root = host_config.get("workspace_recovery_root")
    if not isinstance(recovery_root, str) or not recovery_root.strip():
        return
    store = _workspace_mutation_journal_store.WorkspaceMutationJournalStore.from_version_root(
        recovery_root
    )
    root = workspace.root
    store.on_commit = lambda *_ids: _workspace_retention.run_recovery_maintenance(store, root)
    # A reusable process can interleave live turns across project roots. Never
    # reconcile on call admission: that would interrupt another active journal.
    workspace.mutation_journal = MutationChangeSetLifecycle(store, root)


def builtin_request_scope(
    arguments: object, *, legacy_workspace: WorkspaceGuard, host_config: Any
) -> BuiltinRequestScope | None:
    if not isinstance(arguments, dict) or TRUSTED_EXECUTION_CONTEXT_KEY not in arguments:
        return None
    value = arguments.get(TRUSTED_EXECUTION_CONTEXT_KEY)
    if (
        not isinstance(value, dict)
        or not _REQUIRED_FIELDS.issubset(value)
        or set(value) - _REQUIRED_FIELDS - _OPTIONAL_FIELDS
        or value.get("schema_version") != 1
    ):
        raise _invalid()
    workspace, device_id, inode = _bound_workspace(value)
    _attach_recovery_owner(workspace, host_config)
    raw_roots = value.get("knowledge_roots")
    if (
        not isinstance(raw_roots, list)
        or len(raw_roots) > _MAX_KNOWLEDGE_ROOTS
        or any(not isinstance(item, str) or not item.strip() for item in raw_roots)
    ):
        raise _invalid()
    skills_config = value.get("skills_config")
    if skills_config is not None and not isinstance(skills_config, dict):
        raise _invalid()
    return BuiltinRequestScope(
        workspace=workspace,
        workspace_device_id=device_id,
        workspace_inode=inode,
        knowledge_roots=tuple(item.strip() for item in raw_roots),
        skills_config=dict(skills_config) if isinstance(skills_config, dict) else None,
        hosted=_hosted(host_config),
    )


__all__ = ["TRUSTED_EXECUTION_CONTEXT_KEY", "builtin_request_scope"]
