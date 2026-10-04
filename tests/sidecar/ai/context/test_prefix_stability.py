"""Prefix-stability meter: where a request first diverges from the previous one."""

from __future__ import annotations

import pytest

from sidecar.ai.context import prefix_stability as ps
from sidecar.ai.context.prompt_cache import CacheSection, StructuredSystemPrompt

_TOOLS = [{"name": "read_file", "parameters": {"type": "object"}}]


def _system(capsule: str = "capsule v1") -> StructuredSystemPrompt:
    return StructuredSystemPrompt(
        sections=(
            CacheSection(name="runtime_prompt", content="You are Jenny."),
            CacheSection(name="task_capsule", content=capsule, cacheable=False),
        )
    )


def _history(turns: int) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for index in range(turns):
        rows.append({"role": "user", "content": f"question {index}"})
        rows.append({"role": "assistant", "content": f"answer {index}"})
    return rows


def _observe(meter: ps.PrefixStabilityMeter, **overrides: object) -> ps.PrefixObservation:
    kwargs: dict[str, object] = {
        "system_prompt": _system(),
        "tool_schemas": _TOOLS,
        "messages": _history(2),
    }
    kwargs.update(overrides)
    observation = meter.observe("session-1", **kwargs)  # type: ignore[arg-type]
    assert observation is not None
    return observation


def test_first_request_has_no_baseline() -> None:
    observation = _observe(ps.PrefixStabilityMeter())

    assert observation.divergence == ps.DIVERGENCE_FIRST
    assert observation.reusable_chars == 0
    assert observation.total_chars > 0
    assert observation.predicted_reuse_ratio == 0.0


def test_identical_request_reuses_everything() -> None:
    meter = ps.PrefixStabilityMeter()
    _observe(meter)

    observation = _observe(meter)

    assert observation.divergence == ps.DIVERGENCE_IDENTICAL
    assert observation.predicted_reuse_ratio == 1.0
    assert observation.first_changed == ""


def test_appended_turn_keeps_the_whole_previous_prefix() -> None:
    meter = ps.PrefixStabilityMeter()
    previous = _observe(meter)

    observation = _observe(meter, messages=_history(3))

    assert observation.divergence == ps.DIVERGENCE_APPEND
    assert observation.common_segments == previous.segment_count
    assert observation.reusable_chars == previous.total_chars
    assert 0 < observation.predicted_reuse_ratio < 1
    assert observation.changed_system_sections == ()
    assert observation.tools_changed is False


def test_changed_system_section_breaks_ahead_of_history() -> None:
    meter = ps.PrefixStabilityMeter()
    _observe(meter)

    observation = _observe(meter, system_prompt=_system("capsule v2"), messages=_history(3))

    assert observation.divergence == ps.DIVERGENCE_BREAK
    assert observation.first_changed == "system:task_capsule"
    assert observation.changed_system_sections == ("task_capsule",)
    # Tools and the static runtime prompt still match; the whole history does not count.
    assert observation.common_segments == 2


def test_repeated_section_names_compare_by_position() -> None:
    # The builder emits one "static" section per static block; an unchanged
    # prompt must not report "static" as changed.
    def repeated(date: str) -> StructuredSystemPrompt:
        return StructuredSystemPrompt(
            sections=(
                CacheSection(name="static", content="You are Jenny."),
                CacheSection(name="static", content="Bootstrap notes."),
                CacheSection(name="static", content=date),
            )
        )

    meter = ps.PrefixStabilityMeter()
    _observe(meter, system_prompt=repeated("Today is Monday."))

    unchanged = _observe(meter, system_prompt=repeated("Today is Monday."), messages=_history(3))
    changed = _observe(meter, system_prompt=repeated("Today is Tuesday."), messages=_history(3))

    assert unchanged.divergence == ps.DIVERGENCE_APPEND
    assert unchanged.changed_system_sections == ()
    assert changed.first_changed == "system:static"
    assert changed.changed_system_sections == ("static",)
    assert changed.common_segments == 3


def test_tool_list_change_breaks_at_the_top() -> None:
    meter = ps.PrefixStabilityMeter()
    _observe(meter)

    observation = _observe(meter, tool_schemas=[*_TOOLS, {"name": "write_file"}])

    assert observation.divergence == ps.DIVERGENCE_BREAK
    assert observation.first_changed == "tools"
    assert observation.tools_changed is True
    assert observation.reusable_chars == 0


def test_rewritten_history_row_is_located_by_index_and_role() -> None:
    meter = ps.PrefixStabilityMeter()
    _observe(meter)
    history = _history(3)
    history[1] = {"role": "assistant", "content": "answer 0, re-serialized"}

    observation = _observe(meter, messages=history)

    assert observation.divergence == ps.DIVERGENCE_BREAK
    assert observation.first_changed == "msg[1]:assistant"


def test_shorter_request_is_a_truncation_break() -> None:
    meter = ps.PrefixStabilityMeter()
    _observe(meter, messages=_history(3))

    observation = _observe(meter, messages=_history(2))

    assert observation.divergence == ps.DIVERGENCE_BREAK
    assert observation.first_changed == "truncated"


def test_tool_call_arguments_are_part_of_the_row_identity() -> None:
    call = {"id": "c1", "type": "function", "function": {"name": "read_file"}}
    first = [{"role": "assistant", "content": "", "tool_calls": [{**call, "arguments": '{"a":1}'}]}]
    second = [
        {"role": "assistant", "content": "", "tool_calls": [{**call, "arguments": '{"a": 1}'}]}
    ]
    meter = ps.PrefixStabilityMeter()
    _observe(meter, messages=first)

    observation = _observe(meter, messages=second)

    assert observation.first_changed == "msg[0]:assistant"


def test_layout_is_bounded_and_keeps_no_content() -> None:
    secret = "do-not-retain-this-text"
    layout = ps.request_layout(
        system_prompt="system " + secret,
        tool_schemas=None,
        messages=[{"role": "user", "content": secret}] * (ps._MAX_SEGMENTS + 50),
    )

    assert len(layout) == ps._MAX_SEGMENTS
    assert layout[-1].label == "msg[tail]"
    assert all(secret not in repr(segment) for segment in layout)


def test_sources_are_evicted_oldest_first() -> None:
    meter = ps.PrefixStabilityMeter(max_sources=2)
    for key in ("a", "b", "c"):
        meter.observe(key, system_prompt="s", tool_schemas=None, messages=[])

    again = meter.observe("a", system_prompt="s", tool_schemas=None, messages=[])

    assert again is not None and again.divergence == ps.DIVERGENCE_FIRST


def test_blank_source_key_is_not_tracked() -> None:
    assert (
        ps.PrefixStabilityMeter().observe(" ", system_prompt="s", tool_schemas=None, messages=[])
        is None
    )


def test_kill_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    assert ps.prefix_meter_enabled() is True
    monkeypatch.setenv("JENNY_ENABLE_PREFIX_METER", "0")
    assert ps.prefix_meter_enabled() is False
