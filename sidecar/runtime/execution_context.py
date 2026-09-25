"""Immutable application-authored authority carried by one ``chat.send``."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from sidecar.ai.config_models import ToolPolicySnapshot
from sidecar.ai.config_parsing import _normalize_tool_policy_snapshot
from sidecar.ai.memory.contracts import require_project_id

EXECUTION_CONTEXT_SCHEMA_VERSION = 1
MAX_CONTEXT_BYTES = 5 * 1024 * 1024
MAX_POLICY_BYTES = 4 * 1024 * 1024
MAX_ID_CHARS = 128
MAX_PATH_CHARS = 4096
MAX_KNOWLEDGE_ROOTS = 32
MAX_DISABLED_SKILLS = 256
_CONTROL_CODE_BOUNDARY = 32
_FIELDS = frozenset(
    {
        "schema_version",
        "authority_revision",
        "project_id",
        "root_path",
        "root_id",
        "root_revision",
        "device_id",
        "inode",
        "tool_policy_snapshot",
        "knowledge_roots",
        "skills_config",
    }
)
_REQUIRED_FIELDS = _FIELDS - {"skills_config"}
_SKILLS_FIELDS = frozenset(
    {
        "skills_bundled_root", "skills_user_root", "skills_project_root",
        "skills_bundled_enabled", "skills_user_enabled", "skills_project_enabled",
        "skills_disabled_ids", "skills_auto_index",
    }
)


def _bounded_token(value: Any, field: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise ValueError(f"chat.send params.execution_context.{field} must be a string")
    token = value.strip()
    if not token or len(token) > MAX_ID_CHARS or any(
        ord(char) < _CONTROL_CODE_BOUNDARY for char in token
    ):
        raise ValueError(f"chat.send params.execution_context.{field} is invalid")
    return token


def _absolute_path(value: Any, field: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise ValueError(f"chat.send params.execution_context.{field} must be a path string")
    token = value.strip()
    if not token or len(token) > MAX_PATH_CHARS or "\x00" in token or not Path(token).is_absolute():
        raise ValueError(f"chat.send params.execution_context.{field} must be an absolute path")
    return token


def _policy_to_wire(snapshot: ToolPolicySnapshot) -> dict[str, Any]:
    return {
        "version": snapshot.version,
        "legacy_policies": dict(snapshot.legacy_policies),
        "rules": [
            {
                "id": rule.id,
                "decision": rule.decision,
                "reason": rule.reason,
                "match": {
                    key: value
                    for key, value in {
                        "tool_id": rule.match.tool_id,
                        "action": rule.match.action,
                        "tool_family": rule.match.tool_family,
                        "source_kind": rule.match.source_kind,
                        "mode": list(rule.match.mode),
                        "path_prefix": rule.match.path_prefix,
                        "mcp_server": rule.match.mcp_server,
                    }.items()
                    if value is not None and value != []
                },
            }
            for rule in snapshot.rules
        ],
    }


@dataclass(frozen=True, slots=True)
class SkillsExecutionConfig:
    bundled_root: str | None
    user_root: str | None
    project_root: str | None
    bundled_enabled: bool
    user_enabled: bool
    project_enabled: bool
    disabled_ids: tuple[str, ...]
    auto_index: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "skills_bundled_root": self.bundled_root,
            "skills_user_root": self.user_root,
            "skills_project_root": self.project_root,
            "skills_bundled_enabled": self.bundled_enabled,
            "skills_user_enabled": self.user_enabled,
            "skills_project_enabled": self.project_enabled,
            "skills_disabled_ids": list(self.disabled_ids),
            "skills_auto_index": self.auto_index,
        }


def _skills_config(value: Any) -> SkillsExecutionConfig | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != _SKILLS_FIELDS:
        raise ValueError("chat.send params.execution_context.skills_config must be an exact object")
    roots = tuple(
        _absolute_path(value.get(key), f"skills_config.{key}", nullable=True)
        for key in ("skills_bundled_root", "skills_user_root", "skills_project_root")
    )
    flags = tuple(
        value.get(key)
        for key in ("skills_bundled_enabled", "skills_user_enabled", "skills_project_enabled")
    )
    if not all(isinstance(flag, bool) for flag in flags):
        raise ValueError(
            "chat.send params.execution_context.skills_config enabled fields must be booleans"
        )
    raw_disabled = value.get("skills_disabled_ids")
    if not isinstance(raw_disabled, list) or len(raw_disabled) > MAX_DISABLED_SKILLS:
        raise ValueError(
            "chat.send params.execution_context.skills_config.skills_disabled_ids is invalid"
        )
    disabled = tuple(
        _bounded_token(item, "skills_config.skills_disabled_ids") for item in raw_disabled
    )
    if len(set(disabled)) != len(disabled):
        raise ValueError(
            "chat.send params.execution_context.skills_config.skills_disabled_ids has duplicates"
        )
    auto_index = value.get("skills_auto_index")
    if auto_index not in {"auto", "on", "off"}:
        raise ValueError(
            "chat.send params.execution_context.skills_config.skills_auto_index is invalid"
        )
    return SkillsExecutionConfig(
        bundled_root=roots[0], user_root=roots[1], project_root=roots[2],
        bundled_enabled=bool(flags[0]), user_enabled=bool(flags[1]),
        project_enabled=bool(flags[2]),
        disabled_ids=tuple(str(item) for item in disabled), auto_index=auto_index,
    )


@dataclass(frozen=True, slots=True)
class ExecutionContext:
    schema_version: int
    authority_revision: str
    project_id: str
    root_path: str | None
    root_id: str | None
    root_revision: int
    device_id: str | None
    inode: str | None
    tool_policy_snapshot: ToolPolicySnapshot
    knowledge_roots: tuple[str, ...]
    skills_config: SkillsExecutionConfig | None = None

    @property
    def workspace_root_present(self) -> bool:
        return self.root_path is not None

    def to_wire(self) -> dict[str, Any]:
        payload = {
            "schema_version": self.schema_version,
            "authority_revision": self.authority_revision,
            "project_id": self.project_id,
            "root_path": self.root_path,
            "root_id": self.root_id,
            "root_revision": self.root_revision,
            "device_id": self.device_id,
            "inode": self.inode,
            "tool_policy_snapshot": _policy_to_wire(self.tool_policy_snapshot),
            "knowledge_roots": list(self.knowledge_roots),
        }
        if self.skills_config is not None:
            payload["skills_config"] = self.skills_config.to_wire()
        return payload


def execution_context_from_params(params: Any) -> ExecutionContext | None:  # noqa: C901, PLR0912
    """Parse the trusted v1 carrier. Omission preserves standalone compatibility."""

    if not isinstance(params, dict) or "execution_context" not in params:
        return None
    value = params.get("execution_context")
    if not isinstance(value, dict) or not _REQUIRED_FIELDS.issubset(value) or set(value) - _FIELDS:
        raise ValueError("chat.send params.execution_context must be an exact version-1 object")
    try:
        encoded_size = len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("chat.send params.execution_context must be JSON serializable") from error
    if encoded_size > MAX_CONTEXT_BYTES:
        raise ValueError("chat.send params.execution_context exceeds the size limit")
    if value.get("schema_version") != EXECUTION_CONTEXT_SCHEMA_VERSION:
        raise ValueError("chat.send params.execution_context.schema_version is unsupported")
    authority_revision = _bounded_token(value.get("authority_revision"), "authority_revision")
    project_id = require_project_id(value.get("project_id"))
    root_path = _absolute_path(value.get("root_path"), "root_path", nullable=True)
    root_id = _bounded_token(value.get("root_id"), "root_id", nullable=True)
    root_revision = value.get("root_revision")
    if isinstance(root_revision, bool) or not isinstance(root_revision, int) or root_revision < 0:
        raise ValueError(
            "chat.send params.execution_context.root_revision must be a non-negative integer"
        )
    device_id = _bounded_token(value.get("device_id"), "device_id", nullable=True)
    inode = _bounded_token(value.get("inode"), "inode", nullable=True)
    if root_path is None:
        if any(item is not None for item in (root_id, device_id, inode)):
            raise ValueError(
                "chat.send params.execution_context null root has inconsistent identity"
            )
    elif root_id is None or ((device_id is None) != (inode is None)):
        raise ValueError("chat.send params.execution_context rooted authority is incomplete")
    raw_policy = value.get("tool_policy_snapshot")
    if not isinstance(raw_policy, dict):
        raise ValueError(
            "chat.send params.execution_context.tool_policy_snapshot must be an object"
        )
    policy_size = len(
        json.dumps(raw_policy, ensure_ascii=False, separators=(",", ":")).encode()
    )
    if policy_size > MAX_POLICY_BYTES:
        raise ValueError(
            "chat.send params.execution_context.tool_policy_snapshot exceeds the size limit"
        )
    snapshot = _normalize_tool_policy_snapshot(raw_policy)
    if snapshot is None:
        raise ValueError("chat.send params.execution_context.tool_policy_snapshot is invalid")
    raw_knowledge = value.get("knowledge_roots")
    if not isinstance(raw_knowledge, list) or len(raw_knowledge) > MAX_KNOWLEDGE_ROOTS:
        raise ValueError(
            "chat.send params.execution_context.knowledge_roots must be a bounded list"
        )
    roots = tuple(
        cast(str, _absolute_path(item, "knowledge_roots")) for item in raw_knowledge
    )
    if len(set(roots)) != len(roots):
        raise ValueError("chat.send params.execution_context.knowledge_roots contains duplicates")
    skills = _skills_config(value.get("skills_config"))
    if root_path is None and (
        roots
        or (
            skills is not None
            and (skills.project_root is not None or skills.project_enabled)
        )
    ):
        raise ValueError(
            "chat.send params.execution_context null root cannot authorize project resources"
        )
    return ExecutionContext(
        schema_version=EXECUTION_CONTEXT_SCHEMA_VERSION,
        authority_revision=str(authority_revision),
        project_id=project_id,
        root_path=root_path,
        root_id=root_id,
        root_revision=root_revision,
        device_id=device_id,
        inode=inode,
        tool_policy_snapshot=snapshot,
        knowledge_roots=roots,
        skills_config=skills,
    )


def request_execution_context(value: Any) -> ExecutionContext | None:
    candidate = getattr(value, "execution_context", None)
    return candidate if isinstance(candidate, ExecutionContext) else None


def workspace_root_for_request(request_context: Any, config: Any) -> str | None:
    scoped = request_execution_context(request_context)
    if scoped is not None:
        return scoped.root_path
    return getattr(config, "tools_workspace_root", None) or getattr(
        config, "agent_workspace_root", None
    )


__all__ = [
    "EXECUTION_CONTEXT_SCHEMA_VERSION",
    "ExecutionContext",
    "SkillsExecutionConfig",
    "execution_context_from_params",
    "request_execution_context",
    "workspace_root_for_request",
]
