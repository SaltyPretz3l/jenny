"""Shared, fail-closed probes for request-scoped tool preconditions."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PRECONDITION_SEVERITIES = ("blocking", "advisory")


@dataclass(frozen=True)
class PreconditionSpec:
    id: str
    probe: str
    severity: str = "blocking"


@dataclass(frozen=True)
class ProbeContext:
    workspace_root: Path | None
    config: Any = None


def _workspace_present(context: ProbeContext) -> bool:
    root = context.workspace_root
    return root is not None and root.is_dir()


def _git_root_present(context: ProbeContext) -> bool:
    root = context.workspace_root
    if root is None:
        return False

    # Lazy: probes must not pull the builtins graph into assembly import time.
    from sidecar.ai.tools.builtins.git_ops import _find_git_root  # noqa: PLC0415

    return _find_git_root(root, root) is not None


def _python_runtime_ready(context: ProbeContext) -> bool:
    if context.config is None:
        return False

    from sidecar.ai.tools.builtins.python_runtime.interpreter import (  # noqa: PLC0415
        _ready_marker,
        _venv_dir,
    )

    return _ready_marker(_venv_dir(context.config)).exists()


PRECONDITION_PROBES: dict[str, Callable[[ProbeContext], bool]] = {
    "workspace_present": _workspace_present,
    "git_root_present": _git_root_present,
    "python_runtime_ready": _python_runtime_ready,
}

PRECONDITION_RENDER: dict[str, tuple[str, str]] = {
    "git_repo": (
        "requires a git repository; workspace_root is not one.",
        "none here.",
    ),
    "python_runtime": (
        "managed runtime not built.",
        "builds on first use; the first call may take minutes.",
    ),
    "workspace": (
        "requires a configured workspace root.",
        "set a tools workspace root.",
    ),
}


def parse_tool_preconditions(value: Any) -> tuple[PreconditionSpec, ...]:
    """Parse a manifest ``preconditions`` payload against the closed registries."""
    if not isinstance(value, list):
        return ()
    preconditions: list[PreconditionSpec] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        precondition_id = entry.get("id")
        probe, severity = entry.get("probe"), entry.get("severity", "blocking")
        if not isinstance(precondition_id, str) or not precondition_id.strip():
            continue
        if not isinstance(probe, str) or probe not in PRECONDITION_PROBES:
            continue
        if severity not in PRECONDITION_SEVERITIES:
            continue
        preconditions.append(PreconditionSpec(precondition_id.strip(), probe, severity))
    return tuple(preconditions)


def run_probe(probe_id: str, context: ProbeContext) -> bool:
    """Evaluate one known probe, treating unknown ids and failures as unmet."""
    try:
        probe = PRECONDITION_PROBES.get(probe_id)
        return bool(probe(context)) if probe is not None else False
    except Exception:
        return False
