"""Knowledge scope rules must reach the actual assembled request prompt."""
from __future__ import annotations

import pytest

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.builder_shared import RuntimeToolStatus


@pytest.mark.parametrize("native", [False, True])
@pytest.mark.parametrize("defer", [False, True])
def test_knowledge_guidance_survives_request_assembly(tmp_path, native, defer):
    prompt = str(ContextBuilder(tmp_path).build_system_prompt(
        "Base prompt", tool_statuses=[RuntimeToolStatus(
            name="knowledge_search", display_name="Knowledge", available=True)],
        native_tool_schemas=native, defer_turn_context=defer,
        include_skills=False, include_bootstrap=False))
    assert "make one corrected call" in prompt
    assert "expected_source_hash" in prompt
    assert "omit root" in prompt


@pytest.mark.parametrize("statuses", [[], [RuntimeToolStatus(
    name="knowledge_search", display_name="Knowledge", available=False)],
    [RuntimeToolStatus(name="read_file", display_name="Read", available=True)]])
def test_knowledge_guidance_does_not_pollute_unrelated_requests(tmp_path, statuses):
    prompt = str(ContextBuilder(tmp_path).build_system_prompt(
        "Base prompt", tool_statuses=statuses, include_skills=False, include_bootstrap=False))
    assert "## Knowledge Scope" not in prompt
