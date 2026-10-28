"""Read-only next-send estimate using the request's prompt and tool owners.

No generation, recall, compaction, tool execution or transcript mutation. Dynamic
retrieval is intentionally excluded and disclosed as an estimate limitation.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from sidecar.ai.context.context_count import (
    ScaledTokenizerBackend,
    normalize_context_calibration,
    resolve_token_scale,
)
from sidecar.ai.context.history_reframe import reframe_tool_history_messages
from sidecar.ai.context.messages import (
    build_context_block_system_messages,
    compact_semantic_messages_with_report,
    resolve_personality_rendered,
)
from sidecar.ai.context.prompt_modes import append_mode_runtime_overlays
from sidecar.ai.context.runtime_overlays import (
    _render_model_identity_block,
    _render_session_environment_block,
)
from sidecar.ai.context.token_budget import (
    CharEstimationBackend,
    apply_budget_check,
    estimate_messages_tokens,
    estimate_tool_schema_tokens,
    resolve_context_window_hint,
)
from sidecar.ai.context.turn_context import split_context_blocks
from sidecar.ai.feature_flags import (
    FEATURE_CONTEXT_COMPACTION,
    FEATURE_PROMPT_CACHE,
    FEATURE_TOKEN_BUDGET,
    FEATURE_TOOL_SEARCH,
    is_feature_flag_enabled,
)
from sidecar.ai.routing.system_messages import build_request_system_messages
from sidecar.ai.routing.tool_budget_filter import (
    ToolBudgetFilterInput,
    apply_budget_aware_tool_filter,
    build_system_prompt_for_statuses,
    build_turn_context_row_for_statuses,
    count_full_tool_schemas,
)
from sidecar.runtime.chat_decision_support import (
    ToolResolutionContext,
    build_search_index,
    compute_deferral_set,
    normalize_deferral_mode,
    scan_history_for_undeferrals,
)
from sidecar.runtime.chat_models import ChatRequestContext


def _compact_at_tokens(  # noqa: PLR0913 - keyword-only scale inputs.
    kernel: Any,
    request: ChatRequestContext,
    tool_payload: list[Any],
    tool_tokens: int,
    capacity: int | None,
    *,
    token_scale: float | None = None,
    scale_source: str = "estimate",
) -> int | None:
    """Turn-boundary auto-compact point in whole-prompt units, or ``None``.

    The send compacts when system rows plus history reach the threshold of the
    budget built below, the same way ``chat_decision`` builds it; that threshold
    already sets the tool schemas aside, so adding them back puts it in the same
    units as ``used_tokens``. ``token_scale`` carries the same count source the
    send resolves, so the point is in the units of ``used_tokens``.
    """
    config = kernel._config
    flags = config.feature_flags or {}
    if not capacity or not (
        is_feature_flag_enabled(flags, FEATURE_TOKEN_BUDGET)
        and is_feature_flag_enabled(flags, FEATURE_CONTEXT_COMPACTION)
    ):
        return None
    num_tools = count_full_tool_schemas(tool_payload) if config.tools_enabled else 0
    try:
        _messages, budget, _tracker = apply_budget_check(
            [],
            config,
            kernel._engine,
            num_tools=num_tools,
            reasoning_effort=request.reasoning_effort,
            tool_schema_tokens=estimate_tool_schema_tokens(tool_payload) if num_tools else None,
            token_scale=token_scale,
            scale_source=scale_source,
        )
    # Engine metadata reads feed the budget; the estimate degrades, never fails.
    except (ArithmeticError, OSError, TypeError, ValueError):
        return None
    threshold = budget.auto_compact_threshold(num_tools) if budget is not None else 0
    return min(threshold + tool_tokens, capacity) if threshold > 0 else None


def preview_context(
    kernel: Any,
    request: ChatRequestContext,
    history: list[dict[str, Any]],
    *,
    context_calibration: Any = None,
) -> dict[str, Any]:
    config = kernel._config
    canonical_history = history
    history = compact_semantic_messages_with_report(
        reframe_tool_history_messages(history, config=config)
    ).messages
    inner_backend = kernel._tokenizer_backend() or CharEstimationBackend()
    flags = config.feature_flags or {}
    search = bool(
        config.tools_enabled
        and is_feature_flag_enabled(flags, FEATURE_TOOL_SEARCH)
        and (
            kernel._engine_supports_tool_calling() or kernel._engine_supports_inband_tool_calling()
        )
    )
    # The window the request budget is built from (the configured num_ctx clamp,
    # not the native window); tool deferral keeps the send's own window read.
    capacity = resolve_context_window_hint(kernel._engine, config)
    # The same count source the send resolves, so the composer's next-send figure
    # and its compaction point share units. No exact round trip on a preview.
    token_scale, scale_source = resolve_token_scale(
        engine=kernel._engine,
        config=config,
        messages=[],
        tool_payload=(),
        inner_backend=inner_backend,
        calibration=normalize_context_calibration(context_calibration),
        raw_window=capacity or 0,
        allow_exact=False,
    )
    backend = (
        ScaledTokenizerBackend(inner_backend, token_scale)
        if token_scale is not None
        else inner_backend
    )
    deferral_window = config.context_length or kernel._engine.get_model_context_length() or 0
    resolution = None
    if search:
        base = kernel._assemble_tool_contract(request_context=request, include_deferred_tools=False)
        descriptors = base.filtered_descriptors
        deferred = compute_deferral_set(
            normalize_deferral_mode(config.tool_search_mode),
            descriptors,
            frozenset(d.name for d in descriptors if d.availability.defer_eligible is not True),
            context_window=deferral_window,
            tool_token_threshold_pct=config.tool_search_auto_threshold_pct,
        )
        resolution = ToolResolutionContext(
            deferred_names=deferred,
            un_deferred_names=set(scan_history_for_undeferrals(canonical_history)),
            search_index=build_search_index(deferred, descriptors) if deferred else None,
        )
    contract = kernel._assemble_tool_contract(
        request_context=request, resolution_context=resolution
    )
    leading_blocks, trailing_blocks = split_context_blocks(config, request.context_blocks)
    personality_rendered = resolve_personality_rendered(config, request.context_blocks)
    blocks = build_context_block_system_messages(
        leading_blocks,
        include_personality=personality_rendered,
        agent_name=config.assistant_name,
        ui_language=config.ui_language,
    )
    overlays: list[str] = []
    append_mode_runtime_overlays(overlays, request_context=request)
    if config.model_identity_overlay_enabled:
        overlays.append(
            _render_model_identity_block(provider=config.engine_type, model=config.model)
        )

    def environment_block(tool_schemas: list[Any]) -> str:
        return _render_session_environment_block(
            config=config,
            context_builder=kernel._context_builder,
            tool_schemas=tool_schemas,
            session_id=None,
            execution_context=request.execution_context,
        )

    environment_index = None
    if config.session_environment_overlay_enabled:
        environment_index = len(overlays)
        overlays.append(environment_block(list(contract.prompt_schemas)))
    context = ToolBudgetFilterInput(
        kernel=kernel,
        feature_flags=flags,
        request_context=request,
        tool_resolution_context=resolution,
        semantic_history=history,
        runtime_overlay_messages=overlays,
        context_block_messages=blocks,
        learned_lessons=[],
        prompt_cache_enabled=is_feature_flag_enabled(flags, FEATURE_PROMPT_CACHE),
        pinned_current_date=request.current_date or "",
        latest_user_content="",
        request_id=request.request_id,
        session_id=request.session_id,
        tool_search_enabled=search,
        trailing_context_blocks=trailing_blocks,
    )
    filtered = apply_budget_aware_tool_filter(
        context,
        tool_contract=contract,
        tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )
    if environment_index is not None:
        overlays[environment_index] = environment_block(filtered.tool_payload)
    prompt = filtered.system_prompt or build_system_prompt_for_statuses(
        context, filtered.tool_statuses
    )
    messages = build_request_system_messages(
        kernel,
        base_system_prompt=str(prompt),
        tool_statuses=filtered.tool_statuses,
        context_block_messages=blocks,
        # Attribute prompt rows separately. Canonical placement copies history
        # dictionaries; identity cannot distinguish those copies from overlays.
        # The token counter is additive, so placement does not affect the sum.
        history=(),
        runtime_system_messages=overlays,
        personality_rendered=personality_rendered,
        turn_context_row=build_turn_context_row_for_statuses(context, filtered.tool_statuses),
        execution_context=request.execution_context,
    )
    counts = {
        key: 0 for key in ("messages", "system_prompt", "tools", "instructions", "skills", "other")
    }
    counts["messages"] = estimate_messages_tokens(history, backend)
    counts["tools"] = estimate_tool_schema_tokens(filtered.tool_payload, backend)
    # The runtime drops section metadata when prompt caching is disabled.
    # Reuse the builder's structured projection solely to attribute counts;
    # the counted request above still uses the actual cache configuration.
    attributed = (
        prompt
        if hasattr(prompt, "sections")
        else build_system_prompt_for_statuses(
            replace(context, prompt_cache_enabled=True), filtered.tool_statuses
        )
    )
    for section in getattr(attributed, "sections", ()):
        key = (
            "instructions"
            if section.name in {"workspace_instructions", "workspace_manifest"}
            else "system_prompt"
        )
        counts[key] += backend.count_tokens(section.content)
    # Dynamic skill/personality rows are emitted by the same assembly as chat.send.
    for row in messages[1:]:
        content = str(row.get("content") or "")
        key = (
            "skills"
            if "## Runtime Skills Overlay" in content or "## Available Skills" in content
            else "other"
        )
        counts[key] += estimate_messages_tokens([row], backend)
    total = estimate_messages_tokens(messages, backend) + counts["messages"] + counts["tools"]
    # Framing, cache boundaries and inter-section separators belong to the prompt.
    counts["system_prompt"] += total - sum(counts.values())
    compact_at = _compact_at_tokens(
        kernel,
        request,
        filtered.tool_payload,
        counts["tools"],
        capacity,
        token_scale=token_scale,
        scale_source=scale_source,
    )
    return {
        "status": "estimated",
        "measurement": "estimated",
        "scope": "next_send",
        "used_tokens": total,
        "capacity_tokens": capacity,
        "available_tokens": max(0, capacity - total) if capacity else None,
        "compact_at_tokens": compact_at,
        # Window space held back above the compaction point.
        "reserve_tokens": capacity - compact_at if capacity and compact_at is not None else None,
        "breakdown": counts,
        "provenance": "canonical_prompt_estimate",
        "retrieval_pending": True,
    }
