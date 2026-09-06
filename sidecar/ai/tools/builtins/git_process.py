"""Contained subprocess adapter for read-only Git tools."""

from __future__ import annotations

from pathlib import Path

from sidecar.ai.config import read_environment_value
from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcessCapacityError,
    OwnedProcessResult,
    OwnedProcessShutdownError,
    get_owned_process_service,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def git_environment() -> dict[str, str]:
    env = {
        key: value
        for key in (
            "PATH",
            "HOME",
            "USERPROFILE",
            "LANG",
            "LC_ALL",
            "SYSTEMROOT",
            "COMSPEC",
        )
        if (value := read_environment_value(key))
    }
    env["GIT_PAGER"] = "cat"
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_EXTERNAL_DIFF"] = ""
    return env


def run_owned_git_process(
    arguments: list[str],
    *,
    cwd: Path,
    timeout_seconds: float,
    env: dict[str, str],
) -> OwnedProcessResult:
    try:
        return get_owned_process_service().run(
            arguments,
            cwd=cwd,
            timeout_seconds=timeout_seconds,
            env=env,
        )
    except (OwnedProcessCapacityError, OwnedProcessShutdownError) as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_CAP_EXCEEDED,
            message=f"git process capacity unavailable: {error}",
            retryable=True,
        ) from error


def resolve_git_blob_path(
    raw_path: str,
    *,
    cwd: Path,
    repo_root: Path,
    workspace: WorkspaceGuard,
) -> str:
    """Resolve a historical blob path inside both repository and workspace."""
    if raw_path.startswith("-"):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'path' must not start with '-'",
            retryable=False,
        )
    requested = Path(raw_path)
    target = requested if requested.is_absolute() else cwd / requested
    try:
        resolved = target.resolve(strict=False)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"failed to resolve git blob path: {error}",
            retryable=False,
        ) from error
    workspace.ensure_within_root(resolved)
    try:
        return resolved.relative_to(repo_root.resolve()).as_posix()
    except ValueError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="git_show path must remain inside the selected repository",
            retryable=False,
        ) from error


def validate_git_blob_text(output: str) -> None:
    if "\x00" in output or "\ufffd" in output:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="git blob is binary or not valid UTF-8",
            retryable=False,
        )


def validate_git_blob_ref(ref: str) -> None:
    if ":" in ref or "\x00" in ref:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="git_show ref must not contain ':' or a NUL byte when path is supplied",
            retryable=False,
        )


__all__ = [
    "git_environment",
    "resolve_git_blob_path",
    "run_owned_git_process",
    "validate_git_blob_ref",
    "validate_git_blob_text",
]
