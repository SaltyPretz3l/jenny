"""Contained subprocess adapter for read-only Git tools."""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
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

_ALWAYS_NEUTRAL_CONFIG = (
    ("core.fsmonitor", "false"),
    ("core.hooksPath", os.devnull),
    ("diff.external", ""),
    ("core.sshCommand", ""),
    ("core.askPass", ""),
    ("credential.helper", ""),
    ("core.pager", "cat"),
    ("log.showSignature", "false"),
)
_EXECUTABLE_CONFIG_KEY = re.compile(
    r"^(?:"
    r"filter\..+\.(?:clean|smudge|process|required)"
    r"|diff\..+\.(?:command|textconv)"
    r"|credential\..+\.helper"
    r")$",
    re.IGNORECASE,
)
_UNVERIFIED_CONFIG_MESSAGE = (
    "The repository's Git configuration could not be verified, so the read-only "
    "command was not run."
)


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


def neutralizing_config_arguments(configured_keys: Iterable[str]) -> list[str]:
    """Return command-scoped overrides for executable Git configuration."""
    dynamic_keys = sorted(
        {
            key
            for key in configured_keys
            if _EXECUTABLE_CONFIG_KEY.fullmatch(key) is not None
        },
        key=lambda key: (key.casefold(), key),
    )
    settings = list(_ALWAYS_NEUTRAL_CONFIG)
    settings.extend(
        (key, "false" if key.casefold().endswith(".required") else "")
        for key in dynamic_keys
    )
    arguments: list[str] = []
    for key, value in settings:
        arguments.extend(("-c", f"{key}={value}"))
    return arguments


def _configured_keys(result: object) -> list[str]:
    output_details = getattr(result, "output", None)
    discovery_incomplete = any(
        (
            getattr(result, "returncode", -1) != 0,
            bool(getattr(result, "timed_out", False)),
            bool(getattr(result, "aborted", False)),
            bool(getattr(result, "drain_incomplete", False)),
            bool(getattr(output_details, "truncated", False)),
        )
    )
    if discovery_incomplete:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=_UNVERIFIED_CONFIG_MESSAGE,
            retryable=False,
        )
    output = getattr(result, "stdout", "")
    if isinstance(output, str):
        output = output.encode("utf-8")
    if not isinstance(output, bytes):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=_UNVERIFIED_CONFIG_MESSAGE,
            retryable=False,
        )
    return [key.decode("utf-8", errors="replace") for key in output.split(b"\0") if key]


def run_owned_git_process(
    arguments: list[str],
    *,
    cwd: Path,
    timeout_seconds: float,
    env: dict[str, str],
    trusted_repo_root: Path | None = None,
) -> OwnedProcessResult:
    trust_arguments = (
        ["-c", f"safe.directory={trusted_repo_root.as_posix()}"]
        if trusted_repo_root is not None
        else []
    )
    service = get_owned_process_service()
    try:
        discovery = service.run(
            [arguments[0], *trust_arguments, "config", "--list", "-z", "--name-only"],
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
    configured_keys = _configured_keys(discovery)
    arguments = [
        arguments[0],
        *neutralizing_config_arguments(configured_keys),
        *trust_arguments,
        *arguments[1:],
    ]
    try:
        return service.run(
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
    "neutralizing_config_arguments",
    "resolve_git_blob_path",
    "run_owned_git_process",
    "validate_git_blob_ref",
    "validate_git_blob_text",
]
