"""Shared ReDoS-safe regex compilation for tool builtins.

Single-sources the catastrophic-backtracking guard and safe ``re.compile`` used by
content-search tools (``grep_search``) and the monitor salience gate
(``MonitorManager``), so model-supplied patterns are validated identically and
fail deterministically before any side effect.
"""

from __future__ import annotations

import re

from sidecar.ai.tools.contracts import ToolExecutionFailure


def looks_like_catastrophic_regex(pattern: str) -> bool:
    """Heuristic PRE-FILTER for patterns prone to catastrophic backtracking.

    Deliberately over-broad and explicitly NOT a guarantee: it rejects nested and
    ambiguous-alternation quantifier shapes (including finite ones like
    ``(a{2}){3}``, exactly as it already rejects the equivalent ``(a+){3}``), but
    plenty of slow patterns pass it. The real bound is always the subprocess
    timeout that evaluates the pattern -- ``REGEX_SEARCH_TIMEOUT_SECONDS`` per
    file in ``grep_search``, ``MONITOR_SALIENCE_BUDGET_SECONDS`` per monitor in
    ``sidecar.runtime.monitor_salience``.
    """
    if re.search(r"\([^)]*(?:[+*]|\{\d+(?:,\d*)?\})[^)]*\)\s*[+*{]", pattern):
        return True
    for body in re.findall(r"\(([^()]*\|[^()]*)\)\s*[+*{]", pattern):
        alternatives = [part for part in body.removeprefix("?:").split("|") if part]
        for index, left in enumerate(alternatives):
            for right in alternatives[index + 1 :]:
                if left.startswith(right) or right.startswith(left):
                    return True
    return False


def compile_safe_pattern(
    pattern: object,
    *,
    ignore_case: bool = True,
    error_code: str,
) -> re.Pattern[str]:
    """Compile *pattern* to a regex, rejecting empty / ReDoS-prone / invalid input.

    Raises ``ToolExecutionFailure`` with *error_code* (``retryable=False``) on any
    rejection so callers can surface a deterministic failure at tool-call time.
    """
    if not isinstance(pattern, str) or not pattern.strip():
        raise ToolExecutionFailure(
            code=error_code,
            message="regex pattern must be a non-empty string",
            retryable=False,
        )
    if looks_like_catastrophic_regex(pattern):
        raise ToolExecutionFailure(
            code=error_code,
            message="regex pattern looks prone to catastrophic backtracking",
            retryable=False,
        )
    flags = re.IGNORECASE if ignore_case else 0
    try:
        return re.compile(pattern, flags)
    except re.error as error:
        raise ToolExecutionFailure(
            code=error_code,
            message=f"invalid regex pattern: {error}",
            retryable=False,
        ) from error
