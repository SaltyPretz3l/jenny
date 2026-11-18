"""The hosted file root at the built-in worker's start: configure it, or degrade.

On a host in server mode whose file backend refuses (no confined file access on
this platform, the Windows switch off, the library missing or refusing the root),
the worker pins nothing, keeps hosted mode on so no tool falls back to a plain
`open`, and starts without the workspace-required tools; every other tool still
starts. `main()` logs the reason word once its logging is configured, so it
reaches the sidecar's log. Desktop mode is unchanged.

A rootless server worker may instead be given a root boundary: the one folder
whose direct children may be request roots. It
is resolved once here, probed once through the backend, and never pinned; every
operation still runs in a request scope (builtin_request_scope checks the root
against it). The worker learns no more about the folder than that.
"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path
from typing import Any

from sidecar.ai.mcp.builtin_request_scope import normalized_path
from sidecar.ai.tools import hosted_file_io
from sidecar.ai.tools.contracts import ToolExecutionFailure

_log = logging.getLogger(__name__)
# The start reason for a boundary that does not resolve to itself as a folder:
# the same word as the Windows backend's refused root (failure table).
ROOT_INVALID = "file_access_root_invalid"


class RootBoundaryArgumentError(ValueError):
    """`--hosted-root-boundary` outside a rootless server worker, or not absolute."""


def root_boundary_argument(raw: Any, *, server_mode: bool, workspace_root: Any) -> str | None:
    """The boundary argument, None when absent; any other combination refuses."""
    if raw is None:
        return None
    if (
        not server_mode
        or workspace_root not in (None, "")
        or not isinstance(raw, str)
        or not raw.strip()
        or raw != raw.strip()
        or not os.path.isabs(raw)
    ):
        raise RootBoundaryArgumentError("invalid hosted root boundary")
    return raw


def resolve_root_boundary(raw: str) -> str | None:
    """The boundary resolved once, or None when it is not a folder spelled as itself
    (a link, a junction, a short name, a trailing dot or space, a missing folder)."""
    try:
        resolved = Path(raw).resolve(strict=True)
        is_dir = resolved.is_dir()
    except (OSError, RuntimeError, ValueError):
        return None
    if not is_dir or normalized_path(Path(raw)) != normalized_path(resolved):
        return None
    return str(resolved)


def start_worker_file_access(
    args: argparse.Namespace, workspace_root: Path | None, *, server_mode: bool,
) -> tuple[str | None, dict[str, Any]]:
    """The start reason and the host config keys for this worker's file access.

    Without a boundary: `start_hosted_file_io`, unchanged. With one: the switch,
    the boundary resolved once and probed once, hosted mode on with no root."""
    raw = root_boundary_argument(getattr(args, "hosted_root_boundary", None),
                                 server_mode=server_mode, workspace_root=args.workspace_root)
    win32_files = args.hosted_win32_files is True
    if raw is None:
        return start_hosted_file_io(workspace_root, server_mode=server_mode,
                                    win32_files=win32_files), {}
    hosted_file_io.set_hosted_win32_files(win32_files)
    resolved = resolve_root_boundary(raw)
    reason = (ROOT_INVALID if resolved is None
              else hosted_file_io.hosted_file_io_unavailable_reason(resolved))
    hosted_file_io.configure_hosted_file_io(None, enabled=True)
    return reason, {
        "hosted_root_boundary": raw,
        "hosted_root_boundary_resolved": resolved,
        "hosted_files": {"available": reason is None, "reason": reason},
    }


def start_hosted_file_io(
    workspace_root: Path | None,
    *,
    server_mode: bool,
    win32_files: bool,
) -> str | None:
    """Configure the process-level hosted root; the reason it was left out, else None."""
    hosted_file_io.set_hosted_win32_files(win32_files)
    root = str(workspace_root) if workspace_root is not None else None
    reason = (
        hosted_file_io.hosted_file_io_unavailable_reason(root)
        if server_mode and root is not None
        else None
    )
    if reason is None:
        try:
            hosted_file_io.configure_hosted_file_io(root, enabled=server_mode)
            return None
        except ToolExecutionFailure:
            if hosted_file_io._platform() != "win32":  # POSIX start is unchanged.
                raise
            reason = (
                hosted_file_io.hosted_file_io_unavailable_reason(str(root))
                or hosted_file_io.COMPONENT_MISSING
            )
    hosted_file_io.configure_hosted_file_io(None, enabled=True)
    return reason


def report_hosted_file_reason(reason: str | None) -> None:
    """One log line; the reason is a fixed word from the failure table, never a path."""
    if reason is not None:
        _log.warning("hosted_file.unavailable reason=%s", reason)
