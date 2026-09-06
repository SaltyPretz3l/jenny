"""Shared request system-message assembly helpers."""

from __future__ import annotations

from typing import Any

from sidecar.ai.context.runtime_overlays import build_dynamic_system_messages


def build_request_system_messages(  # noqa: PLR0913
    kernel: Any,
    *,
    base_system_prompt: str,
    tool_statuses: tuple[Any, ...],
    runtime_system_messages: list[str] | None = None,
    personality_rendered: bool = False,
    skill_invocation: dict[str, str] | None = None,
) -> list[dict[str, object]]:
    messages: list[dict[str, object]] = [{"role": "system", "content": base_system_prompt}]
    messages.extend(
        build_dynamic_system_messages(
            context_builder=kernel._context_builder,
            config=kernel._config,
            tool_statuses=tool_statuses,
            personality_rendered=personality_rendered,
            skill_invocation=skill_invocation,
        )
    )
    return kernel._context_builder.insert_runtime_system_messages(
        messages,
        runtime_system_messages or [],
    )


__all__ = ["build_request_system_messages"]
