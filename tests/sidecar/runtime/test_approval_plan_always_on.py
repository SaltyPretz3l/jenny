"""Approval resume replays the frozen ``## Always-on memories`` row byte-identically."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context.always_on_memories import (
    is_always_on_system_message,
    render_always_on_section,
)
from sidecar.runtime.approval_plan import build_approval_plan
from sidecar.runtime.chat_resume_prefix import (
    _build_live_approval_working_messages,
    _is_live_dynamic_system_message,
    personality_row_is_replaceable,
)

_SECTION = render_always_on_section(
    [SimpleNamespace(id=1, lesson_text="Uses metric units.", lesson_kind="preference",
                     project_id="project_general", revision=1)]
)
_BARE_OVERLAY = "## Personality\nYour name is OldName."
_LIVE_OVERLAY = "## Personality\nYour name is NewName."
_PERSONALITY_BLOCK = "## Personality\nYour name is Jenny.\n\n### Voice\n\nOWNER-NOTE"
_LOCAL_CONFIG = SimpleNamespace(engine_type="ollama")


def _plan(working_messages: list[dict[str, Any]], *, context_blocks: tuple[Any, ...] = ()) -> Any:
    return build_approval_plan(
        approved_call_id="call-1",
        request_context=SimpleNamespace(
            request_id="req-1", trace_id="trace-1", session_id="session-1", mode="chat",
            reasoning_effort="medium", tool_preferences=None, plan_mode=False,
            context_blocks=context_blocks,
        ),
        latest_user_content="hello",
        request_messages_hash="request-history-hash",
        working_messages=working_messages,
        generation_result=SimpleNamespace(content="calling tools"),
        tool_calls=(),
        frozen_inputs=(),
        tool_contract=SimpleNamespace(prompt_schemas=(), status_entries=()),
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=(),
        usage_totals=None,
        streamed_event_types=frozenset(),
        system_prompt="System",
        prompt_cache_enabled=False,
        cache_source_key="req-1",
        remaining_iterations=1,
        tool_call_limit=3,
        remaining_tool_calls=1,
        tool_payload=[],
        tool_statuses=(),
        config=SimpleNamespace(
            engine_type="ollama", model="m", model_tier="", fallback_model="",
            temperature=0.0, top_p=1.0, stop_sequences=None,
        ),
        engine=SimpleNamespace(),
        resolved_max_tokens=256,
    )


def test_plan_freezes_the_rendered_section_beside_personality_rendered() -> None:
    plan = _plan([
        {"role": "system", "content": "System"},
        {"role": "system", "content": _SECTION},
        {"role": "user", "content": "hello"},
    ])

    assert plan.always_on_rendered == _SECTION
    assert plan.personality_rendered is False
    assert _plan([{"role": "system", "content": "System"}]).always_on_rendered == ""


def test_the_section_is_never_part_of_the_regenerated_live_prefix() -> None:
    assert not _is_live_dynamic_system_message(_SECTION, personality_row_replaceable=True)


@pytest.mark.parametrize("with_block", [False, True])
def test_resume_replays_the_frozen_section_identically(with_block: bool) -> None:
    personality_row = _PERSONALITY_BLOCK if with_block else _BARE_OVERLAY
    blocks = ({"kind": "personality", "content": "### Voice\n\nOWNER-NOTE"},) if with_block else ()
    plan = _plan(
        [
            {"role": "system", "content": "old prompt"},
            {"role": "system", "content": personality_row},
            {"role": "system", "content": _SECTION},
            {"role": "user", "content": "hello"},
        ],
        context_blocks=blocks,
    )

    resumed = _build_live_approval_working_messages(
        plan,
        live_system_prompt="new prompt",
        dynamic_system_messages=[] if with_block else [{"role": "system", "content": _LIVE_OVERLAY}],
        personality_row_replaceable=personality_row_is_replaceable(plan, _LOCAL_CONFIG),
    )

    contents = [str(message.get("content") or "") for message in resumed]
    always_on = [text for text in contents if is_always_on_system_message(text)]
    assert always_on == [plan.always_on_rendered]
    expected_personality = _PERSONALITY_BLOCK if with_block else _LIVE_OVERLAY
    assert contents.index(plan.always_on_rendered) == contents.index(expected_personality) + 1
