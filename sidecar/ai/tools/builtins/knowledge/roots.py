"""Knowledge-root registry state shared by the knowledge_* tools.

Roots arrive via ``RuntimeConfig.knowledge_roots`` (Electron-validated
absolute paths). Every tool re-validates containment per access through a
per-root ``WorkspaceGuard`` — registration-time validation is a convenience,
not the security boundary.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from sidecar.ai.error_codes import (
    CMP_TOOL_DISABLED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_OUTSIDE_WORKSPACE,
)
from sidecar.ai.tools.config_utils import config_value
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

MAX_SOURCES = 20
MAX_SNIPPET_CHARS = 280
KNOWLEDGE_SOURCE_TYPE = "knowledge"

_DRIVE_PREFIX_RE = re.compile(r"^[A-Za-z]:")

RichAdapterHandler = Callable[[dict[str, object], WorkspaceGuard], ToolHandlerResult]


@dataclass(frozen=True)
class KnowledgeRoot:
    """One registered folder; ``path`` is None when it failed to resolve."""

    label: str
    path: Path | None
    raw_path: str
    guard: WorkspaceGuard


@dataclass
class _KnowledgeRegistryState:
    roots: tuple[KnowledgeRoot, ...] = ()
    rich_adapters: dict[str, RichAdapterHandler] | None = None


_registry_state = _KnowledgeRegistryState()


def configure_knowledge_tools(
    config: Any | None,
    *,
    rich_adapters: dict[str, RichAdapterHandler] | None = None,
) -> None:
    raw_roots = config_value(config, "knowledge_roots")
    roots: list[KnowledgeRoot] = []
    if isinstance(raw_roots, (list, tuple)):
        for raw in raw_roots:
            if not isinstance(raw, str) or not raw.strip():
                continue
            token = raw.strip()
            guard = WorkspaceGuard(token)
            roots.append(
                KnowledgeRoot(
                    label=_unique_label(token, roots),
                    path=guard.root,
                    raw_path=token,
                    guard=guard,
                )
            )
    _registry_state.roots = tuple(roots)
    _registry_state.rich_adapters = dict(rich_adapters or {})


def _unique_label(raw_path: str, existing: list[KnowledgeRoot]) -> str:
    base = Path(raw_path).name or "root"
    used = {root.label.lower() for root in existing}
    label = base
    suffix = 2
    while label.lower() in used:
        label = f"{base}-{suffix}"
        suffix += 1
    return label


def rich_adapters() -> dict[str, RichAdapterHandler]:
    return dict(_registry_state.rich_adapters or {})


def available_roots() -> tuple[KnowledgeRoot, ...]:
    return tuple(root for root in _registry_state.roots if root.path is not None)


def skipped_root_labels() -> tuple[str, ...]:
    return tuple(root.label for root in _registry_state.roots if root.path is None)


def require_roots() -> tuple[KnowledgeRoot, ...]:
    roots = available_roots()
    if not roots:
        raise ToolExecutionFailure(
            code=CMP_TOOL_DISABLED,
            message=(
                "no knowledge folders are registered or accessible; "
                "register a folder in Settings before using knowledge tools"
            ),
            retryable=False,
        )
    return roots


def _normalized_token(value: str) -> str:
    return value.replace("\\", "/").rstrip("/").lower()


def select_roots(root_argument: object) -> tuple[KnowledgeRoot, ...]:
    """Resolve the optional ``root`` argument to a subset of registered roots."""
    roots = require_roots()
    if root_argument is None:
        return roots
    if not isinstance(root_argument, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'root' must be a string",
            retryable=False,
        )
    token = root_argument.strip()
    if not token:
        return roots
    normalized = _normalized_token(token)
    for root in roots:
        candidates = {_normalized_token(root.label), _normalized_token(root.raw_path)}
        if root.path is not None:
            candidates.add(_normalized_token(str(root.path)))
        if normalized in candidates:
            return (root,)
    labels = ", ".join(root.label for root in roots)
    raise ToolExecutionFailure(
        code=CMP_TOOL_INVALID_PATH,
        message=f"unknown knowledge root '{token}'. Registered folders: {labels}",
        retryable=False,
    )


def resolve_knowledge_path(raw_path: object) -> tuple[KnowledgeRoot, Path, str]:
    """Resolve a model-supplied path to (root, real path, display path).

    Accepted shapes: ``<root-label>/relative/path``, an absolute path inside
    a registered root, or a bare relative path when exactly one root is
    registered. Everything resolves through the root's ``WorkspaceGuard``,
    which rejects traversal and symlink escapes on the REAL path.
    """
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'path' must be a non-empty string",
            retryable=False,
        )
    roots = require_roots()
    candidate = raw_path.strip()
    # Reject NTFS alternate-data-stream forms (file.txt:stream / ::$DATA) —
    # streams bypass the binary/size gating the plain file goes through. The
    # only legal ':' is a drive-letter separator at index 1.
    drive_free = candidate[2:] if _DRIVE_PREFIX_RE.match(candidate) else candidate
    if ":" in drive_free:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="path contains an unsupported ':' segment",
            retryable=False,
        )

    if Path(candidate).is_absolute():
        for root in roots:
            try:
                resolved = root.guard.resolve_read_path(candidate)
            except ToolExecutionFailure:
                continue
            return root, resolved, display_path(root, resolved)
        raise ToolExecutionFailure(
            code=CMP_TOOL_OUTSIDE_WORKSPACE,
            message="path is not inside any registered knowledge folder",
            retryable=False,
        )

    first, _, rest = candidate.replace("\\", "/").partition("/")
    for root in roots:
        if root.label.lower() == first.lower():
            resolved = root.guard.resolve_read_path(rest or ".")
            return root, resolved, display_path(root, resolved)
    if len(roots) == 1:
        root = roots[0]
        resolved = root.guard.resolve_read_path(candidate)
        return root, resolved, display_path(root, resolved)
    labels = ", ".join(root.label for root in roots)
    raise ToolExecutionFailure(
        code=CMP_TOOL_INVALID_PATH,
        message=(
            f"path must start with a registered folder name ({labels}); "
            "use knowledge_exec op=ls to list folders"
        ),
        retryable=False,
    )


def display_path(root: KnowledgeRoot, resolved: Path) -> str:
    """Label-prefixed POSIX display path — never the absolute local path."""
    if root.path is not None:
        try:
            relative = resolved.relative_to(root.path).as_posix()
        except ValueError:
            relative = resolved.name
    else:
        relative = resolved.name
    if relative == ".":
        return root.label
    return f"{root.label}/{relative}"


def bound_snippet(text: object) -> str:
    """Collapse whitespace and bound untrusted document content."""
    compact = " ".join(str(text or "").split())
    return compact[:MAX_SNIPPET_CHARS]


def build_sources(entries: list[tuple[str, str]]) -> list[dict[str, object]]:
    """Build the web_search-shaped source refs (ids kb:N, 1-based)."""
    sources: list[dict[str, object]] = []
    for index, (path, snippet) in enumerate(entries[:MAX_SOURCES], start=1):
        sources.append(
            {
                "id": f"kb:{index}",
                "path": path,
                "title": path.rsplit("/", 1)[-1],
                "snippet": bound_snippet(snippet),
                "source_type": KNOWLEDGE_SOURCE_TYPE,
            }
        )
    return sources
