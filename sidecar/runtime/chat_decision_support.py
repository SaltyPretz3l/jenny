"""Shared imports/helpers for ``sidecar.ai.routing.chat_decision``."""

from __future__ import annotations

from sidecar.ai.config import resolve_effective_max_tokens
from sidecar.ai.context.builder import LearnedLesson
from sidecar.ai.context.compaction import compact_context
from sidecar.ai.context.compaction_prompts import resolve_compaction_prompt
from sidecar.ai.context.prompt_cache import StructuredSystemPrompt
from sidecar.ai.context.token_budget import (
    BudgetTracker,
    apply_budget_check,
    check_budget,
    estimate_messages_tokens,
)
from sidecar.ai.error_codes import CMP_CTX_BUDGET_EXHAUSTED
from sidecar.ai.feature_flags import (
    FEATURE_CONTEXT_COMPACTION,
    FEATURE_PROMPT_CACHE,
    FEATURE_TOKEN_BUDGET,
    FEATURE_TOOL_SEARCH,
    is_feature_flag_enabled,
)
from sidecar.ai.mode_policy import policy_for_mode
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_loop import run_tool_loop
from sidecar.ai.tools.models import GenerationUsage
from sidecar.ai.tools.tool_search import (
    ToolResolutionContext,
    build_search_index,
    compute_deferral_set,
    normalize_deferral_mode,
    scan_history_for_undeferrals,
)

__all__ = [
    "BudgetTracker",
    "CMP_CTX_BUDGET_EXHAUSTED",
    "FEATURE_CONTEXT_COMPACTION",
    "FEATURE_PROMPT_CACHE",
    "FEATURE_TOKEN_BUDGET",
    "FEATURE_TOOL_SEARCH",
    "GenerationUsage",
    "LearnedLesson",
    "LoopRuntime",
    "StructuredSystemPrompt",
    "ToolResolutionContext",
    "apply_budget_check",
    "build_search_index",
    "check_budget",
    "compact_context",
    "compute_deferral_set",
    "estimate_messages_tokens",
    "is_feature_flag_enabled",
    "normalize_deferral_mode",
    "policy_for_mode",
    "resolve_compaction_prompt",
    "resolve_effective_max_tokens",
    "run_tool_loop",
    "scan_history_for_undeferrals",
]
