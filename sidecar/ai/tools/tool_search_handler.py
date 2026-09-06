"""Handler for the synthetic ``tool_search`` tool.

Executes ToolSearch calls, returns full schemas for matched tools, and
mutates the per-request un-deferral set so discovered tools stay
un-deferred for the remainder of the session.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.error_codes import CMP_TSRCH_INVALID_QUERY
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.tool_search import (
    DEFAULT_MAX_RESULTS,
    MAX_QUERY_LENGTH,
    MAX_RESULTS,
    TOOL_SEARCH_RESULT_KIND,
    ToolSearchIndex,
)


def handle_tool_search(
    arguments: dict[str, object],
    *,
    search_index: ToolSearchIndex,
    full_schema_map: dict[str, dict[str, Any]],
    un_deferred_set: set[str],
) -> ToolHandlerResult:
    """Execute a ToolSearch invocation.

    Returns formatted tool schema information for matched tools and
    marks them as un-deferred.  The *un_deferred_set* is mutated in
    place so the router can include full schemas in subsequent
    iterations.
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
        matches = search_index.search(query, max_results=max_results)
    except ValueError as error:
        return ToolHandlerResult(
            output=str(error),
            success=False,
            error_code=CMP_TSRCH_INVALID_QUERY,
        )
    if not matches:
        return ToolHandlerResult(
            output=f"No tools found matching '{query}'.",
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
    output_lines: list[str] = [f"Found {len(matches)} tool(s):"]
    for match in matches:
        schema = full_schema_map.get(match.name)
        if schema:
            desc = schema.get("description", match.description)
            output_lines.append(f"- {match.name}: {desc}")
            un_deferred_set.add(match.name)
            discovered_names.append(match.name)
        else:
            output_lines.append(f"- {match.name}: {match.description}")

    return ToolHandlerResult(
        output="\n".join(output_lines),
        metadata={
            "kind": TOOL_SEARCH_RESULT_KIND,
            "discovered_tools": discovered_names,
            "match_count": len(discovered_names),
            "effects": "none",
        },
    )
