"""Argument handling shared by the git tools: booleans, and the `git_log` count, ref and path.

Kept apart from `git_ops.py`, which owns the validation of a ref and of a literal path
filter; the caller passes the already-validated values in.
"""

from __future__ import annotations

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.argument_coercion import BoolArgumentError, extract_bool_argument
from sidecar.ai.tools.contracts import ToolExecutionFailure

DEFAULT_LOG_COUNT = 20
MAX_LOG_COUNT = 100


def extract_boolean(arguments: dict[str, object], key: str, *, default: bool = False) -> bool:
    try:
        return extract_bool_argument(arguments, key, default=default)
    except BoolArgumentError as exc:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=str(exc),
            retryable=False,
        ) from exc


def parse_max_count(arguments: dict[str, object]) -> int:
    """The commit count, clamped to 1..MAX_LOG_COUNT; an integer or integer string."""
    raw = arguments.get("max_count", DEFAULT_LOG_COUNT)
    try:
        if not isinstance(raw, (int, str)):
            raise ValueError(raw)
        count = int(raw)
    except ValueError:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'max_count' must be an integer",
            retryable=False,
        ) from None
    return max(1, min(count, MAX_LOG_COUNT))


def build_git_log_arguments(
    *, max_count: int, ref: str | None, path_filter: str | None
) -> list[str]:
    """`git log` arguments; with neither a ref nor a path this is the plain one-line log."""
    arguments = ["log", "--no-show-signature", f"--max-count={max_count}", "--oneline"]
    if ref is not None:
        arguments.append(ref)
    if path_filter is not None:
        # Literal, like git_diff: a model path is a file name, not a glob.
        arguments.extend(["--", f":(literal){path_filter}"])
    elif ref is not None:
        # The ref is always a revision, never a path that happens to match.
        arguments.append("--")
    return arguments
