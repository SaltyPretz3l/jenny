"""Read-oriented git builtin tools."""

from __future__ import annotations

import os
import re
import stat
import subprocess  # noqa: F401 - compatibility seam for injected unit fakes.
from dataclasses import dataclass
from pathlib import Path

from sidecar.ai.error_codes import (
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_PRECONDITION_UNMET,
)
from sidecar.ai.tools.argument_coercion import BoolArgumentError, extract_bool_argument
from sidecar.ai.tools.builtins.git_ops_settings import (
    _GIT_RUNTIME_OPTIONS,
)
from sidecar.ai.tools.builtins.git_ops_settings import (
    GIT_TIMEOUT_SECONDS as _GIT_TIMEOUT_SECONDS,
)
from sidecar.ai.tools.builtins.git_ops_settings import (
    MAX_GIT_TIMEOUT_SECONDS as _MAX_GIT_TIMEOUT_SECONDS,
)
from sidecar.ai.tools.builtins.git_ops_settings import (
    configure_git_tools as _configure_git_tools,
)
from sidecar.ai.tools.builtins.git_process import (
    git_environment as _git_environment,
)
from sidecar.ai.tools.builtins.git_process import (
    resolve_git_blob_path,
    validate_git_blob_ref,
    validate_git_blob_text,
)
from sidecar.ai.tools.builtins.git_process import (
    run_owned_git_process as _run_owned_process,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

GIT_TIMEOUT_SECONDS = _GIT_TIMEOUT_SECONDS
MAX_GIT_TIMEOUT_SECONDS = _MAX_GIT_TIMEOUT_SECONDS
configure_git_tools = _configure_git_tools

MAX_OUTPUT_CHARS = 32_000
MAX_DIFF_DETAIL_FILES = 200
MAX_DIFF_DETAIL_LINES = 20_000
# Git pointer files (.git gitfile, gitdir, commondir) are tiny single-line
# paths; a few KiB is a generous ceiling. Anything larger, a symlink, a
# FIFO/device, or non-UTF-8 bytes is a malformed / hostile artifact, not real
# git metadata, and is rejected before its contents can steer path resolution.
_GIT_METADATA_MAX_BYTES = 8 * 1024
_SHORTSTAT_PATTERN = re.compile(
    r"(\d+)\s+files?\s+changed"
    r"(?:,\s+(\d+)\s+insertions?\(\+\))?"
    r"(?:,\s+(\d+)\s+deletions?\(-\))?"
)


@dataclass(frozen=True)
class _ShortStat:
    files_changed: int
    lines_added: int
    lines_removed: int

    @property
    def total_lines_changed(self) -> int:
        return self.lines_added + self.lines_removed


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return f"{text[:MAX_OUTPUT_CHARS]}\n...[truncated]"


def _resolve_cwd(arguments: dict[str, object], workspace: WorkspaceGuard) -> Path:
    cwd_value = arguments.get("cwd")
    if cwd_value is not None and not isinstance(cwd_value, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'cwd' must be a string",
            retryable=False,
        )
    cwd_explicit = True
    if cwd_value is None or not cwd_value.strip():
        # Blank/whitespace-only cwd is treated the same as an omitted cwd
        # rather than falling through to the generic "non-empty string"
        # path-resolution error, which carried no git-specific remediation.
        cwd = workspace.require_root()
        cwd_explicit = False
    else:
        try:
            cwd = workspace.resolve_list_path(cwd_value)
        except ToolExecutionFailure as error:
            # Rewrap with git-specific remediation naming the fallback and the
            # actual root path, so a model can self-correct instead of retrying
            # the same bad argument.
            root = workspace.root
            root_hint = f" ({root})" if root is not None else ""
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=(
                    f"git tool argument 'cwd' is invalid: {error.message} "
                    f"Omit 'cwd' to use the tools workspace root{root_hint}."
                ),
                retryable=False,
            ) from error
    _validate_git_cwd(cwd, workspace, cwd_explicit=cwd_explicit)
    return cwd


def _extract_optional_string(arguments: dict[str, object], key: str) -> str | None:
    value = arguments.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument '{key}' must be a string",
            retryable=False,
        )
    token = value.strip()
    if not token:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument '{key}' cannot be empty",
            retryable=False,
        )
    return token


def _extract_git_ref(arguments: dict[str, object], key: str) -> str | None:
    token = _extract_optional_string(arguments, key)
    if token is None:
        return None
    if token.startswith("-"):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument '{key}' must not start with '-'",
            retryable=False,
        )
    return token


def _extract_boolean(arguments: dict[str, object], key: str, *, default: bool = False) -> bool:
    try:
        return extract_bool_argument(arguments, key, default=default)
    except BoolArgumentError as exc:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=str(exc),
            retryable=False,
        ) from exc


def _resolve_git_path_filter(raw_path: str, *, cwd: Path, workspace: WorkspaceGuard) -> str:
    requested = Path(raw_path)
    target = requested if requested.is_absolute() else cwd / requested
    try:
        resolved = target.resolve(strict=False)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"failed to resolve git path filter: {error}",
            retryable=False,
        ) from error
    workspace.ensure_within_root(resolved)
    return os.path.relpath(resolved, cwd).replace("\\", "/")


def _find_git_root(start: Path, workspace_root: Path) -> Path | None:
    current = start
    while current.is_relative_to(workspace_root):
        git_entry = current / ".git"
        if git_entry.is_dir() or git_entry.is_file():
            return current
        if current == workspace_root:
            break
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


def _read_git_metadata_file(path: Path, *, label: str) -> str:
    # Hardened read for the git pointer files that steer metadata resolution.
    # Regular-file-only (rejects symlink/FIFO/device), no-follow + non-blocking
    # open where the platform supports it, a pre/post identity check to defeat a
    # TOCTOU swap, a few-KiB size cap, and a STRICT UTF-8 decode. A lossy decode
    # or a followed symlink here could redirect worktree containment checks.
    try:
        pre_stat = os.lstat(path)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"failed to stat git {label}: {error}",
            retryable=False,
        ) from error
    if stat.S_ISLNK(pre_stat.st_mode):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"git {label} must not be a symlink",
            retryable=False,
        )
    if not stat.S_ISREG(pre_stat.st_mode):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"git {label} must be a regular file",
            retryable=False,
        )
    open_flags = (
        os.O_RDONLY
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
        | getattr(os, "O_BINARY", 0)
    )
    try:
        fd = os.open(path, open_flags)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"failed to open git {label}: {error}",
            retryable=False,
        ) from error
    try:
        post_stat = os.fstat(fd)
        if not stat.S_ISREG(post_stat.st_mode) or (
            (pre_stat.st_dev, pre_stat.st_ino) != (post_stat.st_dev, post_stat.st_ino)
        ):
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=f"git {label} changed identity while being read",
                retryable=False,
            )
        raw = os.read(fd, _GIT_METADATA_MAX_BYTES + 1)
    finally:
        os.close(fd)
    if len(raw) > _GIT_METADATA_MAX_BYTES:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"git {label} is too large to be valid metadata",
            retryable=False,
        )
    try:
        return raw.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"git {label} is not valid UTF-8",
            retryable=False,
        ) from error


def _resolve_git_metadata_path(base: Path, raw_value: str, *, label: str) -> Path:
    token = raw_value.strip()
    if not token:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"git {label} cannot be empty",
            retryable=False,
        )
    candidate = Path(token)
    target = candidate if candidate.is_absolute() else base / candidate
    try:
        return target.resolve(strict=True)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"failed to resolve git {label}: {error}",
            retryable=False,
        ) from error


def _validate_git_metadata_root(git_root: Path, workspace: WorkspaceGuard) -> None:
    workspace.ensure_within_root(git_root)
    git_entry = git_root / ".git"
    if git_entry.is_dir():
        workspace.ensure_within_root(git_entry)
        return
    if not git_entry.is_file():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="path must point inside a git repository within the tools workspace root",
            retryable=False,
        )

    git_file = _read_git_metadata_file(git_entry, label=".git file")
    prefix = "gitdir:"
    if not git_file.lower().startswith(prefix):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="unsupported .git file format inside the tools workspace root",
            retryable=False,
        )

    git_dir = _resolve_git_metadata_path(git_root, git_file[len(prefix) :], label="gitdir")
    if not git_dir.is_dir():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="gitdir must resolve to a directory",
            retryable=False,
        )

    common_dir_file = git_dir / "commondir"
    if not common_dir_file.exists():
        # Ordinary in-workspace gitfile layouts retain the original containment
        # rule. Only a mutually linked worktree layout may trust metadata outside
        # the selected checkout.
        workspace.ensure_within_root(git_dir)
        return

    common_dir = _resolve_git_metadata_path(
        git_dir,
        _read_git_metadata_file(common_dir_file, label="commondir"),
        label="commondir",
    )
    if not common_dir.is_dir():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="git commondir must resolve to a directory",
            retryable=False,
        )

    expected_parent = (common_dir / "worktrees").resolve(strict=False)
    actual_parent = git_dir.parent.resolve(strict=False)
    if actual_parent != expected_parent:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="git worktree metadata does not match a trusted worktree layout",
            retryable=False,
        )

    backlink = _resolve_git_metadata_path(
        git_dir,
        _read_git_metadata_file(git_dir / "gitdir", label="worktree backlink"),
        label="worktree backlink",
    )
    expected_backlink = (git_root.resolve(strict=True) / ".git").resolve(strict=True)
    if backlink != expected_backlink:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="git worktree metadata does not match the workspace checkout",
            retryable=False,
        )


def _validate_git_cwd(
    cwd: Path, workspace: WorkspaceGuard, *, cwd_explicit: bool = True
) -> None:
    workspace_root = workspace.require_root()
    git_root = _find_git_root(cwd, workspace_root)
    if git_root is None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_PRECONDITION_UNMET,
            message=_non_repo_message(cwd, workspace_root, cwd_explicit=cwd_explicit),
            retryable=False,
            error_details={
                "precondition_id": "git_repo",
                "failure_class": "precondition_unmet",
            },
        )
    _validate_git_metadata_root(git_root, workspace)


def _non_repo_message(cwd: Path, workspace_root: Path, *, cwd_explicit: bool) -> str:
    """Explain a missing repository without nonsense remediation.

    When the caller never passed 'cwd' the resolved directory *is* the workspace
    root, so "Omit 'cwd' to use the workspace root" told the model to do what it
    had already done. Split the two lanes so each one only offers a step that can
    actually change the outcome.
    """

    if not cwd_explicit:
        return (
            f"The tools workspace root ({workspace_root}) is not a git repository, so git "
            "tools are unavailable here. Pass 'cwd' pointing at a git checkout under the "
            "workspace root if one exists."
        )
    return (
        f"git tool 'cwd' ({cwd}) is not inside a git repository within the tools "
        f"workspace root ({workspace_root}). Omit 'cwd' to use the workspace root, "
        "or pass a 'cwd' that points inside a git checkout under it."
    )


def _run_git_completed(arguments: list[str], *, cwd: Path) -> object:
    try:
        completed = _run_owned_process(
            ["git", "--no-pager", "--no-optional-locks", *arguments],
            cwd=cwd,
            timeout_seconds=_GIT_RUNTIME_OPTIONS["timeout_seconds"],
            env=_git_environment(),
        )
    except FileNotFoundError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="git is not installed or not available on PATH",
            retryable=False,
        ) from error
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to run git command: {error}",
            retryable=True,
        ) from error
    if getattr(completed, "timed_out", False):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="git command timed out",
            retryable=True,
        )
    return completed


def _run_git(arguments: list[str], *, cwd: Path) -> str:
    completed = _run_git_completed(arguments, cwd=cwd)
    stdout = _truncate(str(getattr(completed, "stdout", "") or ""))
    stderr = _truncate(str(getattr(completed, "stderr", "") or ""))
    if int(getattr(completed, "returncode", -1)) != 0:
        detail = stderr.strip() or stdout.strip() or "git command failed"
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=detail,
            retryable=False,
        )

    return stdout.strip()


def _run_git_raw(arguments: list[str], *, cwd: Path) -> str:
    completed = _run_git_completed(arguments, cwd=cwd)
    stdout = str(getattr(completed, "stdout", "") or "")
    stderr = _truncate(str(getattr(completed, "stderr", "") or ""))
    if int(getattr(completed, "returncode", -1)) != 0:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=stderr.strip() or "git command failed",
            retryable=False,
        )
    return stdout


def _run_git_blob(ref: str, path: str, *, cwd: Path) -> str:
    stdout = _run_git_raw(["show", f"{ref}:{path}"], cwd=cwd)
    validate_git_blob_text(stdout)
    return _truncate(stdout)


def _parse_shortstat(output: str) -> _ShortStat | None:
    match = _SHORTSTAT_PATTERN.search(output)
    if match is None:
        return None
    return _ShortStat(
        files_changed=int(match.group(1) or 0),
        lines_added=int(match.group(2) or 0),
        lines_removed=int(match.group(3) or 0),
    )


def _diff_is_oversized(stats: _ShortStat) -> bool:
    return (
        stats.files_changed > MAX_DIFF_DETAIL_FILES
        or stats.total_lines_changed > MAX_DIFF_DETAIL_LINES
    )


def _format_oversized_diff_response(summary: str, *, subject: str) -> str:
    normalized_summary = summary.strip() or "Summary unavailable."
    if subject == "commit":
        guidance = "Patch omitted because the commit diff is too large; narrow with git_diff path=... or inspect a smaller ref range."
    else:
        guidance = "Patch omitted because the diff is too large; narrow with path=... or diff a smaller ref range."
    return f"{normalized_summary}\n\n({guidance})"


def _build_git_diff_arguments(
    *,
    staged: bool,
    ref: str | None,
    path_filter: str | None,
    shortstat: bool = False,
) -> list[str]:
    arguments = ["diff", "--no-ext-diff", "--no-textconv"]
    if shortstat:
        arguments.append("--shortstat")
    if staged:
        arguments.append("--cached")
    if ref is not None:
        arguments.append(ref)
    if path_filter is not None:
        arguments.extend(["--", path_filter])
    return arguments


def git_status_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> str:
    cwd = _resolve_cwd(arguments, workspace)
    output = _run_git(["status", "--short", "--branch"], cwd=cwd)
    return output or "(clean working tree)"


def git_log_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> str:
    cwd = _resolve_cwd(arguments, workspace)

    raw_max_count = arguments.get("max_count", 20)
    if isinstance(raw_max_count, int):
        max_count = raw_max_count
    elif isinstance(raw_max_count, str):
        try:
            max_count = int(raw_max_count)
        except ValueError:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="tool argument 'max_count' must be an integer",
                retryable=False,
            ) from None
    else:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'max_count' must be an integer",
            retryable=False,
        )
    max_count = max(1, min(max_count, 100))

    output = _run_git(["log", f"--max-count={max_count}", "--oneline"], cwd=cwd)
    return output or "(no commits found)"


def git_diff_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> str:
    staged = _extract_boolean(arguments, "staged", default=False)
    ref = _extract_git_ref(arguments, "ref")
    raw_path_filter = _extract_optional_string(arguments, "path")
    cwd = _resolve_cwd(arguments, workspace)
    path_filter = None
    if raw_path_filter is not None:
        path_filter = _resolve_git_path_filter(raw_path_filter, cwd=cwd, workspace=workspace)

    shortstat_output = _run_git(
        _build_git_diff_arguments(
            staged=staged,
            ref=ref,
            path_filter=path_filter,
            shortstat=True,
        ),
        cwd=cwd,
    )
    stats = _parse_shortstat(shortstat_output)
    if stats is not None and _diff_is_oversized(stats):
        return _format_oversized_diff_response(shortstat_output, subject="diff")

    output = _run_git(
        _build_git_diff_arguments(
            staged=staged,
            ref=ref,
            path_filter=path_filter,
        ),
        cwd=cwd,
    )
    return output or "(no changes found)"


def git_show_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> str:
    ref = _extract_git_ref(arguments, "ref") or "HEAD"
    cwd = _resolve_cwd(arguments, workspace)
    raw_path = _extract_optional_string(arguments, "path")
    if raw_path is not None:
        validate_git_blob_ref(ref)
        repo_root = _find_git_root(cwd, workspace.require_root().resolve())
        if repo_root is None:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="git_show path requires cwd inside a repository within the workspace",
                retryable=False,
            )
        blob_path = resolve_git_blob_path(
            raw_path, cwd=cwd, repo_root=repo_root, workspace=workspace
        )
        return _run_git_blob(ref, blob_path, cwd=cwd)

    shortstat_output = _run_git(
        [
            "show",
            "--no-ext-diff",
            "--no-textconv",
            "--format=",
            "--shortstat",
            ref,
        ],
        cwd=cwd,
    )
    stats = _parse_shortstat(shortstat_output)
    if stats is not None and _diff_is_oversized(stats):
        metadata_output = _run_git(
            ["show", "--format=medium", "--no-patch", ref],
            cwd=cwd,
        )
        summary_output = "\n".join(
            part for part in (metadata_output.strip(), shortstat_output.strip()) if part
        )
        return _format_oversized_diff_response(summary_output, subject="commit")

    output = _run_git(
        ["show", "--no-ext-diff", "--no-textconv", "--stat", "--patch", ref],
        cwd=cwd,
    )
    return output or "(no commit details found)"
