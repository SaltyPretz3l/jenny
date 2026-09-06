"""``load_skill`` builtin: read a skill's SKILL.md body server-side.

The context builder's skill index (``sidecar/ai/context/builder_skills.py``)
advertises bundled/user/project skills the model may want to load. Those
scope roots live outside the tools workspace root -- bundled skills ship
under the app root (``services/main/runtime-service-composition.js``), and
user/project scope roots are resolved independently in
``sidecar.ai.container._resolve_skill_scopes``. ``WorkspaceGuard`` confines
every filesystem tool to the workspace root (``sidecar/ai/tools/workspace.py``),
so a model advertised an indexed skill has no tool that can actually reach
its SKILL.md. This module is the dedicated, workspace-guard-free read path
for exactly that file: it resolves strictly against the configured skill
scope roots, never against the tools workspace root or an arbitrary path.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.context.context_io import discover_skill_files, read_bounded_context_text
from sidecar.ai.error_codes import (
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_SKILL_NOT_FOUND,
)
from sidecar.ai.tools.config_utils import config_value
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

# Mirrors MAX_SKILL_FILE_BYTES in builder_shared.py: the tool's read bound
# should never be looser than what the context builder itself would load.
MAX_SKILL_FILE_BYTES = 15 * 1024
MAX_SKILL_FILES = 128
MAX_SKILL_DISCOVERY_ENTRIES = 2_048
MAX_SKILL_DEPTH = 8
MAX_SKILL_DISCOVERY_SECONDS = 0.5
MAX_AVAILABLE_SKILL_HINTS = 32
SKILL_FILENAME = "SKILL.md"
# Matches sidecar.ai.container._resolve_skill_scopes' candidate order exactly
# -- both the set of valid scope names and the precedence used when a caller
# omits `scope`.
SCOPE_PRECEDENCE: tuple[str, ...] = ("bundled", "user", "project")
# One or more safe directory segments, matching the bounded recursive catalog
# used by the context builder. Backslashes and dot-prefixed segments are not
# accepted, so the identifier is stable across platforms.
_SAFE_NAME_RE = re.compile(
    rf"^[A-Za-z0-9_][A-Za-z0-9._-]*(?:/[A-Za-z0-9_][A-Za-z0-9._-]*){{0,{MAX_SKILL_DEPTH - 1}}}$"
)


@dataclass(frozen=True)
class _SkillScopeRoot:
    scope: str
    root: Path
    enabled: bool


_scope_roots: tuple[_SkillScopeRoot, ...] = ()
_disabled_skill_ids: frozenset[str] = frozenset()


def configure_skill_tool(config: Any | None) -> None:
    """Cache the load_skill scope roots from runtime config.

    Reads the same ``skills_<scope>_root`` / ``skills_<scope>_enabled`` keys
    ``sidecar.ai.container._resolve_skill_scopes`` reads, so this tool can
    only ever read a skill the context builder actually advertised.
    """
    global _disabled_skill_ids, _scope_roots  # noqa: PLW0603
    roots: list[_SkillScopeRoot] = []
    for scope_name in SCOPE_PRECEDENCE:
        raw_root = config_value(config, f"skills_{scope_name}_root")
        if not isinstance(raw_root, str) or not raw_root.strip():
            continue
        raw_enabled = config_value(config, f"skills_{scope_name}_enabled", True)
        roots.append(
            _SkillScopeRoot(
                scope=scope_name,
                root=Path(raw_root).expanduser(),
                enabled=raw_enabled is not False,
            )
        )
    _scope_roots = tuple(roots)
    raw_disabled_ids = config_value(config, "skills_disabled_ids", ())
    _disabled_skill_ids = frozenset(
        item.strip()
        for item in raw_disabled_ids
        if isinstance(item, str) and item.strip()
    ) if isinstance(raw_disabled_ids, (list, tuple)) else frozenset()


def _reset_skill_tool_state() -> None:
    """Test helper: clear module-level configuration between tests."""
    global _disabled_skill_ids, _scope_roots  # noqa: PLW0603
    _scope_roots = ()
    _disabled_skill_ids = frozenset()


def _candidate_scopes(requested_scope: str | None) -> tuple[_SkillScopeRoot, ...]:
    if requested_scope is None:
        return _scope_roots
    return tuple(scope_root for scope_root in _scope_roots if scope_root.scope == requested_scope)


def _skill_dir_names(scope_root: _SkillScopeRoot) -> list[str]:
    if not scope_root.enabled or not scope_root.root.exists():
        return []
    discovery = discover_skill_files(
        scope_root.root,
        max_depth=MAX_SKILL_DEPTH,
        max_entries=MAX_SKILL_DISCOVERY_ENTRIES,
        max_files=MAX_SKILL_FILES,
        max_seconds=MAX_SKILL_DISCOVERY_SECONDS,
    )
    names: list[str] = []
    for skill_path in discovery.files:
        try:
            relative = skill_path.relative_to(scope_root.root.resolve(strict=True))
        except (OSError, ValueError):
            continue
        name = relative.parent.as_posix()
        if f"{scope_root.scope}/{name}" not in _disabled_skill_ids:
            names.append(name)
    return names


def _available_skill_labels() -> list[str]:
    labels: list[str] = []
    for scope_root in _scope_roots:
        for name in _skill_dir_names(scope_root):
            label = f"{scope_root.scope}/{name}"
            if label not in labels:
                labels.append(label)
            if len(labels) >= MAX_AVAILABLE_SKILL_HINTS:
                return labels
    return labels


def _resolve_skill_path(scope_root: _SkillScopeRoot, name: str) -> Path | None:
    """Resolve ``<scope_root>/<nested name>/SKILL.md`` within the scope root."""
    if not scope_root.enabled or not scope_root.root.exists():
        return None
    try:
        resolved_root = scope_root.root.resolve(strict=True)
    except OSError:
        return None
    candidate_dir = scope_root.root / name
    try:
        resolved_dir = candidate_dir.resolve(strict=True)
    except OSError:
        return None
    try:
        relative_dir = resolved_dir.relative_to(resolved_root)
    except ValueError:
        return None
    if relative_dir.as_posix() != name:
        return None
    skill_path = resolved_dir / SKILL_FILENAME
    return skill_path if skill_path.is_file() else None


def load_skill_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    # Skills live in scope roots outside the tools workspace root by design;
    # WorkspaceGuard has nothing to authorize here.
    del workspace

    raw_name = arguments.get("name")
    name = raw_name.strip() if isinstance(raw_name, str) else ""
    if not name or not _SAFE_NAME_RE.match(name):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                f"invalid skill name {name!r}: expected the bounded relative skill id "
                "shown in the Available Skills index"
            ),
            retryable=False,
        )

    raw_scope = arguments.get("scope")
    stripped_scope = raw_scope.strip() if isinstance(raw_scope, str) else ""
    requested_scope: str | None = stripped_scope or None
    if requested_scope is not None and requested_scope not in SCOPE_PRECEDENCE:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"invalid scope {requested_scope!r}: expected one of {SCOPE_PRECEDENCE}",
            retryable=False,
        )

    for scope_root in _candidate_scopes(requested_scope):
        if f"{scope_root.scope}/{name}" in _disabled_skill_ids:
            continue
        skill_path = _resolve_skill_path(scope_root, name)
        if skill_path is None:
            continue
        return _read_skill(scope_root, name, skill_path)

    available = _available_skill_labels()
    hint = (
        f" Available skills: {', '.join(available)}."
        if available
        else " No skills are currently indexed."
    )
    raise ToolExecutionFailure(
        code=CMP_TOOL_SKILL_NOT_FOUND,
        message=f"unknown skill {name!r}.{hint}",
        retryable=False,
    )


def _read_skill(scope_root: _SkillScopeRoot, name: str, skill_path: Path) -> ToolHandlerResult:
    read_result = read_bounded_context_text(
        skill_path,
        authorized_root=scope_root.root,
        max_bytes=MAX_SKILL_FILE_BYTES,
        truncate=True,
    )
    if read_result.text is None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to read skill {name!r}: {read_result.reason or 'unknown error'}",
            retryable=True,
        )
    output = read_result.text
    if read_result.truncated:
        output += f"\n\n[skill content truncated at {MAX_SKILL_FILE_BYTES} bytes]"
    return ToolHandlerResult(
        output=output,
        metadata={
            "scope": scope_root.scope,
            "name": name,
            "truncated": read_result.truncated,
        },
    )
