"""Shared request system-message assembly helpers."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from sidecar.ai.context.messages import build_context_block_system_messages
from sidecar.ai.context.runtime_overlays import (
    build_dynamic_system_messages,
    build_invoked_skill_message,
    runtime_clock_line,
)
from sidecar.ai.context.turn_context import (
    build_turn_context_row,
    fold_runtime_messages,
    is_trailing_runtime_message,
    place_turn_context_row,
    split_context_blocks,
    trailing_turn_context_enabled,
)


def build_request_system_messages(  # noqa: PLR0913
    kernel: Any,
    *,
    base_system_prompt: str,
    tool_statuses: tuple[Any, ...],
    runtime_system_messages: list[str] | None = None,
    personality_rendered: bool = False,
    skill_invocation: dict[str, str] | None = None,
    context_block_messages: Sequence[dict[str, object]] = (),
    history: Sequence[dict[str, object]] = (),
    turn_context_row: Mapping[str, Any] | None = None,
    execution_context: Any | None = None,
) -> list[dict[str, object]]:
    """Assemble the request: prompt block, typed context rows, history.

    Electron's typed context overlays (active file / @-mentions, git,
    personality, codebase, linked-session recall) join the TRUSTED system tier
    after the prompt and runtime overlays and BEFORE semantic history, so they
    sit ahead of any pinned compaction summary (derived, untrusted). They
    cannot arrive via history: compact_semantic_messages rejects system rows on
    untrusted request history.

    With a trailing *turn_context_row* (``turn_context.py``) the per-turn
    runtime overlays fold into that row, which goes before the latest user
    message; the caller has already moved the per-turn context kinds and the
    invoked skill (``render_turn_context_row``) into it.
    """
    messages: list[dict[str, object]] = [{"role": "system", "content": base_system_prompt}]
    messages.extend(
        build_dynamic_system_messages(
            context_builder=kernel._context_builder,
            config=kernel._config,
            tool_statuses=tool_statuses,
            personality_rendered=personality_rendered,
            skill_invocation=skill_invocation if turn_context_row is None else None,
            execution_context=execution_context,
        )
    )
    runtime = list(runtime_system_messages or [])
    if turn_context_row is not None:
        turn_context_row = fold_runtime_messages(
            turn_context_row, [text for text in runtime if is_trailing_runtime_message(text)]
        )
        runtime = [text for text in runtime if not is_trailing_runtime_message(text)]
    messages = kernel._context_builder.insert_runtime_system_messages(messages, runtime)
    messages.extend(context_block_messages)
    messages.extend(history)
    if turn_context_row is None:
        return messages
    return place_turn_context_row(messages, turn_context_row)


def render_turn_context_row(  # noqa: PLR0913
    context_builder: Any,
    config: Any,
    *,
    tool_statuses: Any,
    latest_user_content: str,
    trailing_context_blocks: Any,
    root_kwargs: dict[str, Any],
    skill_invocation: dict[str, str] | None = None,
    execution_context: Any | None = None,
) -> dict[str, object] | None:
    """The row's base parts, in order: per-turn prompt sections, the per-turn
    Electron context blocks, the invoked skill, the clock line. Runtime
    overlays fold in later through ``insert_runtime_system_messages``. ``None``
    when the flag is off.

    The invoked skill changes with every invocation; in the leading run it
    would re-prefill the whole conversation on the turn that uses it and again
    on the next. Here it is read as user-role context the user asked for.
    """
    if not trailing_turn_context_enabled(config):
        return None
    # Duck-typed builders without the per-turn split contribute no sections.
    section_builder = getattr(context_builder, "build_turn_context_sections", None)
    sections = (
        section_builder(
            tool_statuses=None if tool_statuses is None else list(tool_statuses),
            latest_user_content=latest_user_content,
            workspace_manifest_enabled=bool(
                getattr(config, "tools_workspace_manifest_enabled", False)
            ),
            task_capsule_enabled=bool(getattr(config, "tools_task_capsule_enabled", False)),
            **root_kwargs,
        )
        if callable(section_builder)
        else ()
    )
    blocks = build_context_block_system_messages(
        tuple(trailing_context_blocks or ()), include_personality=False
    )
    invoked_skill = build_invoked_skill_message(
        context_builder=context_builder,
        config=config,
        skill_invocation=skill_invocation,
        execution_context=execution_context,
    )
    clock = runtime_clock_line() if getattr(config, "use_24_hour_time", False) is True else ""
    return build_turn_context_row(
        [*sections, *(str(block.get("content") or "") for block in blocks), invoked_skill, clock]
    )


__all__ = [
    "build_request_system_messages",
    "render_turn_context_row",
    "split_context_blocks",
    "trailing_turn_context_enabled",
]
