"""Budget tracker for a tool loop resumed after an approval (F26)."""

from __future__ import annotations

from typing import Any

from sidecar.ai.context.token_budget import (
    BudgetTracker,
    apply_budget_check,
    estimate_tool_schema_tokens,
)
from sidecar.ai.feature_flags import FEATURE_TOKEN_BUDGET, is_feature_flag_enabled
from sidecar.ai.routing.tool_budget_filter import count_full_tool_schemas


def resume_budget_tracker(  # noqa: PLR0913 - keyword-only budget inputs.
    config: Any,
    engine: Any,
    working_messages: list[dict[str, Any]],
    tool_payload: list[dict[str, Any]],
    *,
    reasoning_effort: str | None,
) -> BudgetTracker | None:
    """Build the tracker the first leg built, so the resumed leg can compact
    mid-turn and recover a context-full stop instead of stopping outright."""
    if not is_feature_flag_enabled(config.feature_flags or {}, FEATURE_TOKEN_BUDGET):
        return None
    num_tools = count_full_tool_schemas(tool_payload) if config.tools_enabled else 0
    _messages, _budget, tracker = apply_budget_check(
        working_messages,
        config,
        engine,
        num_tools=num_tools,
        reasoning_effort=reasoning_effort,
        tool_schema_tokens=estimate_tool_schema_tokens(tool_payload) if num_tools else None,
    )
    return tracker
