"""Handler for the synthetic ``tool_search`` tool.

Executes ToolSearch calls, returns full schemas for matched tools, and
mutates the per-request un-deferral set so discovered tools stay
un-deferred for the remainder of the session.
"""

from __future__ import annotations

from typing import AbstractSet, Any, Callable

from sidecar.ai.error_codes import CMP_TSRCH_INVALID_QUERY
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.tool_search import (
    DEFAULT_MAX_RESULTS,
    DEFERRED_TOOL_COMPANIONS,
    MAX_QUERY_LENGTH,
    MAX_RESULTS,
    TOOL_SEARCH_RESULT_KIND,
    ToolSearchIndex,
)


def _callable_note(discovered_names: list[str], *, any_unavailable: bool) -> list[str]:
    """The closing sentence: the tools listed above can be called now, by those names."""
    if not discovered_names:
        return []
    exception = " (except any marked not available)" if any_unavailable else ""
    return [f"You can call the listed tools now, by the names listed{exception}."]


def handle_tool_search(
    arguments: dict[str, object],
    *,
    search_index: ToolSearchIndex,
    un_deferred_set: set[str],
    schema_for: Callable[[str], dict[str, Any] | None],
    excluded_names: AbstractSet[str] = frozenset(),
) -> ToolHandlerResult:
    """Execute a ToolSearch invocation.

    Returns formatted tool schema information for matched tools and
    marks them as un-deferred.  The *un_deferred_set* is mutated in
    place so the router can include full schemas in subsequent
    iterations. ``schema_for`` is only called once a query has matched, so
    a caller can defer building the schema map; ``excluded_names`` (tools
    retired this turn) never match.
    """
    query = str(arguments.get("query", "")).strip()
    if not query:
        return ToolHandlerResult(
            output="No query provided. Use 'select:ToolName' or keywords.",
            success=False,
            error_code=CMP_TSRCH_INVALID_QUERY,
        )
    if len(query) > MAX_QUERY_LENGTH:
        return ToolHandlerResult(
            output=f"Tool search query exceeds {MAX_QUERY_LENGTH} characters.",
            success=False,
            error_code=CMP_TSRCH_INVALID_QUERY,
        )

    raw_max = arguments.get("max_results", DEFAULT_MAX_RESULTS)
    try:
        max_results = min(MAX_RESULTS, max(1, int(str(raw_max))))
    except (TypeError, ValueError):
        max_results = DEFAULT_MAX_RESULTS

    try:
        matches = [
            match
            for match in search_index.search(query, max_results=max_results)
            if match.name not in excluded_names
        ]
    except ValueError as error:
        return ToolHandlerResult(
            output=str(error),
            success=False,
            error_code=CMP_TSRCH_INVALID_QUERY,
        )
    if not matches:
        return ToolHandlerResult(
            output=(
                f"No tools found matching '{query}'. Try other keywords, or use "
                "'select:ToolName' with an exact tool name."
            ),
            metadata={
                "kind": TOOL_SEARCH_RESULT_KIND,
                "discovered_tools": [],
                "match_count": 0,
                # Pseudo-tool outside the registry: assert the honest value so
                # the derived-effects fallback doesn't render "unknown".
                "effects": "none",
            },
        )

    discovered_names: list[str] = []
    output_lines: list[str] = []
    any_unavailable = False
    for match in matches:
        schema = schema_for(match.name)
        if schema:
            desc = schema.get("description", match.description)
            output_lines.append(f"- {match.name}: {desc}")
            un_deferred_set.add(match.name)
            discovered_names.append(match.name)
        else:
            output_lines.append(f"- {match.name}: {match.description} (not available)")
            any_unavailable = True
    for name in tuple(discovered_names):
        for companion in DEFERRED_TOOL_COMPANIONS.get(name, ()):
            if companion in discovered_names or companion in excluded_names:
                continue
            schema = schema_for(companion)
            if schema:
                output_lines.append(f"- {companion}: {schema.get('description', '')}")
                un_deferred_set.add(companion)
                discovered_names.append(companion)

    # The header counts what the model can now call, the same number as match_count.
    output_lines.insert(0, f"Found {len(discovered_names)} tool(s):")
    output_lines.extend(_callable_note(discovered_names, any_unavailable=any_unavailable))
    return ToolHandlerResult(
        output="\n".join(output_lines),
        metadata={
            "kind": TOOL_SEARCH_RESULT_KIND,
            "discovered_tools": discovered_names,
            "match_count": len(discovered_names),
            "effects": "none",
        },
    )
