"""Drawing instructions: exactly one diagram language reaches the system prompt.

The flag ``sketch_blocks`` and the setting ``drawing_instructions`` pick one of three
texts (short sketch grammar, full sketch grammar, Mermaid line). Both production prompt
callers pass the same choice so a live turn, the context preview and an approval
resume agree.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.diagram_guidance import (
    DIAGRAM_GUIDANCE_VARIANTS,
    MERMAID_GUIDANCE,
    SKETCH_FULL_GUIDANCE,
    SKETCH_SHORT_GUIDANCE,
    diagram_guidance_kwargs,
    resolve_diagram_guidance,
)
from sidecar.ai.feature_flags import FEATURE_SKETCH_BLOCKS
from sidecar.ai.routing import tool_budget_filter as tool_budget_filter_module
from sidecar.runtime.chat_resume import _build_live_approval_system_prompt
from tests.sidecar.ai.routing.test_tool_budget_filter_probe_parity import (
    _filter_input,
    _FilterKernel,
    _RecordingContextBuilder,
)
from tests.sidecar.runtime.test_chat import _build_approval_plan_for_chat_tests

_TEXTS = {
    "mermaid": MERMAID_GUIDANCE,
    "sketch_short": SKETCH_SHORT_GUIDANCE,
    "sketch_full": SKETCH_FULL_GUIDANCE,
}
# The full grammar is the short grammar plus extra blocks, so the short text sits inside it:
# "the other two texts are absent" is checked with markers only one text carries, and the
# short text appearing once inside the full one is the single copy of it.
_MERMAID_MARKER = "put Mermaid code in a fenced code block tagged mermaid"
_SKETCH_MARKER = "write a fenced code block tagged sketch"
_FULL_ONLY_MARKER = "More blocks, each on its own lines inside the same sketch block:"


def _builder(tmp_path) -> ContextBuilder:
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True)
    return ContextBuilder(workspace)


def test_mermaid_text_is_the_line_the_prompt_always_carried() -> None:
    assert MERMAID_GUIDANCE == (
        "## Diagrams\n"
        "To show a diagram, put Mermaid code in a fenced code block tagged mermaid "
        "in your reply; the chat draws it as a chart."
    )


def test_sketch_texts_match_the_probed_grammar_files() -> None:
    assert len(SKETCH_SHORT_GUIDANCE) == 892
    assert len(SKETCH_FULL_GUIDANCE) == 4327
    for text in (SKETCH_SHORT_GUIDANCE, SKETCH_FULL_GUIDANCE):
        assert text.startswith("## Diagrams\nTo show a diagram, write a fenced code block")
        assert not text.endswith("\n")
    assert SKETCH_SHORT_GUIDANCE.splitlines()[-1] == "```"
    assert SKETCH_SHORT_GUIDANCE.splitlines()[-2] == "step Check: The API looks the user up | api db"
    # The full grammar is the short one plus the extra blocks, character for character.
    assert SKETCH_FULL_GUIDANCE.startswith(SKETCH_SHORT_GUIDANCE + "\n")
    assert SKETCH_FULL_GUIDANCE.splitlines()[0] == "## Diagrams"
    assert SKETCH_FULL_GUIDANCE.splitlines()[-1] == (
        '  In steps: "| m[Germany]" or "m[United-Kingdom]" circles a country, '
        '"m[berlin]" a place or route.'
    )


def test_variants_resolve_and_an_unknown_value_gives_the_mermaid_text() -> None:
    assert DIAGRAM_GUIDANCE_VARIANTS == ("mermaid", "sketch_short", "sketch_full")
    for variant, text in _TEXTS.items():
        assert resolve_diagram_guidance(variant) == text
    for unknown in ("", "bogus", None, 3):
        assert resolve_diagram_guidance(unknown) == MERMAID_GUIDANCE  # type: ignore[arg-type]


@pytest.mark.parametrize("variant", DIAGRAM_GUIDANCE_VARIANTS)
def test_built_prompt_carries_exactly_one_diagram_language(tmp_path, variant: str) -> None:
    builder = _builder(tmp_path)
    plain = builder.build_system_prompt("Base.", diagram_guidance=variant)
    cached = builder.build_system_prompt("Base.", cache_aware=True, diagram_guidance=variant)

    for prompt in (str(plain), cached.to_text()):
        assert prompt.count(_TEXTS[variant]) == 1
        assert prompt.count("## Diagrams") == 1
        assert prompt.count(_MERMAID_MARKER) == (1 if variant == "mermaid" else 0)
        assert prompt.count(_SKETCH_MARKER) == (0 if variant == "mermaid" else 1)
        assert prompt.count(_FULL_ONLY_MARKER) == (1 if variant == "sketch_full" else 0)


def test_default_keyword_is_todays_prompt(tmp_path) -> None:
    builder = _builder(tmp_path)

    assert builder.build_system_prompt("Base.") == builder.build_system_prompt(
        "Base.", diagram_guidance="mermaid"
    )
    assert str(builder.build_system_prompt("Base.")).count(MERMAID_GUIDANCE) == 1
    assert (
        builder.build_system_prompt("Base.", cache_aware=True).to_text()
        == builder.build_system_prompt(
            "Base.", cache_aware=True, diagram_guidance="mermaid"
        ).to_text()
    )


def _config(**fields: Any) -> SimpleNamespace:
    return SimpleNamespace(**fields)


@pytest.mark.parametrize(
    ("config", "expected"),
    [
        (_config(feature_flags={FEATURE_SKETCH_BLOCKS: False}, drawing_instructions="full"), "mermaid"),
        (_config(feature_flags={FEATURE_SKETCH_BLOCKS: False}, drawing_instructions="short"), "mermaid"),
        (_config(feature_flags={FEATURE_SKETCH_BLOCKS: True}, drawing_instructions="short"), "sketch_short"),
        (_config(feature_flags={FEATURE_SKETCH_BLOCKS: True}, drawing_instructions="full"), "sketch_full"),
        (_config(feature_flags={FEATURE_SKETCH_BLOCKS: True}, drawing_instructions="mermaid"), "mermaid"),
        (_config(feature_flags={}, drawing_instructions="full"), "sketch_full"),
        (_config(feature_flags={}, drawing_instructions="bogus"), "sketch_short"),
        (_config(feature_flags={}, drawing_instructions=None), "sketch_short"),
        (_config(feature_flags=None, drawing_instructions="short"), "sketch_short"),
        (_config(), "sketch_short"),
        (_config(feature_flags={FEATURE_SKETCH_BLOCKS: False}), "mermaid"),
    ],
)
def test_diagram_guidance_kwargs_picks_one_variant(config: SimpleNamespace, expected: str) -> None:
    assert diagram_guidance_kwargs(config) == {"diagram_guidance": expected}


def test_router_prompt_builder_passes_the_variant() -> None:
    kernel = _FilterKernel()
    builder = _RecordingContextBuilder()
    kernel._context_builder = builder
    kernel._config.drawing_instructions = "full"
    kernel._config.feature_flags = {FEATURE_SKETCH_BLOCKS: True}

    tool_budget_filter_module.build_system_prompt_for_statuses(_filter_input(kernel), ())
    assert builder.calls[-1]["diagram_guidance"] == "sketch_full"

    kernel._config.feature_flags = {FEATURE_SKETCH_BLOCKS: False}
    tool_budget_filter_module.build_system_prompt_for_statuses(_filter_input(kernel), ())
    assert builder.calls[-1]["diagram_guidance"] == "mermaid"


@pytest.mark.parametrize(
    ("setting", "flags", "expected"),
    [
        ("short", {}, "sketch_short"),
        ("full", {}, "sketch_full"),
        ("mermaid", {}, "mermaid"),
        ("full", {FEATURE_SKETCH_BLOCKS: False}, "mermaid"),
    ],
)
def test_approval_resume_prompt_passes_the_same_variant(
    setting: str, flags: dict[str, bool], expected: str
) -> None:
    captured: dict[str, object] = {}

    def _build_system_prompt(_base: str, **kwargs: object) -> str:
        captured.update(kwargs)
        return "rebuilt"

    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                system_prompt="Frozen",
                session_start_date="2026-04-13",
                engine_type="x",
                drawing_instructions=setting,
                feature_flags=flags,
            ),
            engine=SimpleNamespace(supports_tool_calling=True),
            router=SimpleNamespace(
                _context_builder=SimpleNamespace(build_system_prompt=_build_system_prompt)
            ),
        )
    )
    plan = _build_approval_plan_for_chat_tests(current_date="2026-07-18")

    _build_live_approval_system_prompt(
        plan, brain_container=brain_container, live_params={}, tool_statuses=()
    )

    assert captured["diagram_guidance"] == expected
