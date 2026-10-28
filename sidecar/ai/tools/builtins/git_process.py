"""Contained subprocess adapter for read-only Git tools."""

from __future__ import annotations

import os
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Iterable
from pathlib import Path

from sidecar.ai.config import read_environment_value
from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcessCapacityError,
    OwnedProcessResult,
    OwnedProcessService,
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
    # Non-ASCII paths print literally instead of as octal escapes.
    ("core.quotePath", "false"),
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
# Discovered config key lists are reused briefly so one tool call does not pay
# a `git config --list` per git command. The key covers every config file a
# repository-controlled edit could touch (repo, worktree and global config by
# stat); a list that names an include is never cached, because an included
# file can change without touching any of them.
CONFIG_KEYS_TTL_SECONDS = 30.0
_CONFIG_KEYS_CACHE_LIMIT = 64
_GIT_POINTER_MAX_BYTES = 8 * 1024
_CONFIG_KEYS_LOCK = threading.Lock()
_CONFIG_KEYS_CACHE: OrderedDict[tuple[object, ...], tuple[float, tuple[str, ...]]] = OrderedDict()


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


def _stat_identity(path: Path) -> tuple[int, int] | None:
    try:
        file_stat = path.stat()
    except FileNotFoundError:
        return None
    return (file_stat.st_mtime_ns, file_stat.st_size)


def _read_git_pointer(path: Path) -> str:
    with path.open("rb") as handle:
        raw = handle.read(_GIT_POINTER_MAX_BYTES + 1)
    if len(raw) > _GIT_POINTER_MAX_BYTES:
        raise OSError("git pointer file is too large")
    return raw.decode("utf-8").strip()


def _git_dirs(repo_root: Path) -> tuple[Path, Path]:
    """The checkout's own git dir and the common dir that holds its ``config``."""
    entry = repo_root / ".git"
    if entry.is_dir():
        return entry, entry
    pointer = _read_git_pointer(entry)
    if not pointer.lower().startswith("gitdir:"):
        raise OSError("unsupported .git file")
    git_dir = Path(pointer[len("gitdir:"):].strip())
    git_dir = git_dir if git_dir.is_absolute() else repo_root / git_dir
    commondir_file = git_dir / "commondir"
    if not commondir_file.exists():
        return git_dir, git_dir
    common = Path(_read_git_pointer(commondir_file))
    return git_dir, common if common.is_absolute() else git_dir / common


def config_keys_cache_key(
    repo_root: Path, *, trusted_repo_root: Path | None, env: dict[str, str]
) -> tuple[object, ...] | None:
    """Stat identity of every config file the discovery reads, or None if unknown."""
    try:
        git_dir, common_dir = _git_dirs(repo_root)
        files = [repo_root / ".git", common_dir / "config", git_dir / "config.worktree"]
        for home_key in ("HOME", "USERPROFILE"):
            home = env.get(home_key)
            if home:
                files.extend((Path(home) / ".gitconfig", Path(home) / ".config" / "git" / "config"))
        stats = tuple((str(path), _stat_identity(path)) for path in files)
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    trust = trusted_repo_root.as_posix() if trusted_repo_root is not None else None
    return (os.path.normcase(str(repo_root)), trust, stats)


def _cached_config_keys(key: tuple[object, ...] | None) -> tuple[str, ...] | None:
    if key is None:
        return None
    now = time.monotonic()
    with _CONFIG_KEYS_LOCK:
        entry = _CONFIG_KEYS_CACHE.get(key)
        if entry is None:
            return None
        if now - entry[0] > CONFIG_KEYS_TTL_SECONDS:
            del _CONFIG_KEYS_CACHE[key]
            return None
        _CONFIG_KEYS_CACHE.move_to_end(key)
        return entry[1]


def _store_config_keys(key: tuple[object, ...] | None, configured_keys: list[str]) -> None:
    if key is None or any(
        name.casefold().startswith(("include.", "includeif.")) for name in configured_keys
    ):
        return
    with _CONFIG_KEYS_LOCK:
        _CONFIG_KEYS_CACHE[key] = (time.monotonic(), tuple(configured_keys))
        _CONFIG_KEYS_CACHE.move_to_end(key)
        while len(_CONFIG_KEYS_CACHE) > _CONFIG_KEYS_CACHE_LIMIT:
            _CONFIG_KEYS_CACHE.popitem(last=False)


def reset_config_keys_cache() -> None:
    with _CONFIG_KEYS_LOCK:
        _CONFIG_KEYS_CACHE.clear()


def _discover_config_keys(
    service: OwnedProcessService,
    argv: list[str],
    *,
    cwd: Path,
    timeout_seconds: float,
    env: dict[str, str],
) -> list[str]:
    try:
        discovery = service.run(
            argv,
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
    return _configured_keys(discovery)


def run_owned_git_process(  # noqa: PLR0913 - explicit process contract.
    arguments: list[str],
    *,
    cwd: Path,
    timeout_seconds: float,
    env: dict[str, str],
    trusted_repo_root: Path | None = None,
    repo_root: Path | None = None,
) -> OwnedProcessResult:
    trust_arguments = (
        ["-c", f"safe.directory={trusted_repo_root.as_posix()}"]
        if trusted_repo_root is not None
        else []
    )
    service = get_owned_process_service()
    cache_key = (
        config_keys_cache_key(repo_root, trusted_repo_root=trusted_repo_root, env=env)
        if repo_root is not None
        else None
    )
    cached = _cached_config_keys(cache_key)
    if cached is not None:
        configured_keys = list(cached)
    else:
        configured_keys = _discover_config_keys(
            service,
            [arguments[0], *trust_arguments, "config", "--list", "-z", "--name-only"],
            cwd=cwd, timeout_seconds=timeout_seconds, env=env,
        )
        _store_config_keys(cache_key, configured_keys)
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
    "CONFIG_KEYS_TTL_SECONDS",
    "OwnedProcessResult",
    "config_keys_cache_key",
    "git_environment",
    "neutralizing_config_arguments",
    "reset_config_keys_cache",
    "resolve_git_blob_path",
    "run_owned_git_process",
    "validate_git_blob_ref",
    "validate_git_blob_text",
]
