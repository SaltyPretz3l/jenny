"""The hosted file root at the built-in worker's start: configure it, or degrade.

On a host in server mode whose file backend refuses (no confined file access on
this platform, the Windows switch off, the library missing or refusing the root),
the worker pins nothing, keeps hosted mode on so no tool falls back to a plain
`open`, and starts without the workspace-required tools; every other tool still
starts. `main()` logs the reason word once its logging is configured, so it
reaches the sidecar's log. Desktop mode is unchanged.
"""

from __future__ import annotations

import logging
from pathlib import Path

from sidecar.ai.tools import hosted_file_io
from sidecar.ai.tools.contracts import ToolExecutionFailure

_log = logging.getLogger(__name__)


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
