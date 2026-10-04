"""TR-010: the ``## Executable Tools`` digest lists names only when native schemas carry the rest.

Native-schema engines already receive every tool's description and parameters
in the provider ``tools`` payload, so repeating them in the system prompt cost
~2.9k tokens per request on a 42-tool Bonsai 2 run. Prompt-based (in-band)
engines receive no schemas, so they keep the full digest.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.builder_shared import RuntimeToolStatus
from sidecar.ai.routing import tool_budget_filter as tool_budget_filter_module
from sidecar.ai.tools.catalog import manifest_descriptors
from sidecar.runtime.chat_resume import _build_live_approval_system_prompt
from tests.sidecar.ai.routing.test_tool_budget_filter_probe_parity import (
    _filter_input,
    _FilterKernel,
    _RecordingContextBuilder,
)
from tests.sidecar.runtime.test_chat import _build_approval_plan_for_chat_tests

_KNOWN_TOOLS = ("read_file", "grep_search", "list_dir")


def _manifest_status(name: str, **overrides: Any) -> RuntimeToolStatus:
    descriptor = next(item for item in manifest_descriptors() if item.name == name)
    fields: dict[str, Any] = {
        "name": descriptor.name,
        "display_name": descriptor.name,
        "available": True,
        "description": descriptor.description,
        "input_schema": descriptor.input_schema,
    }
    fields.update(overrides)
    return RuntimeToolStatus(**fields)


def _statuses() -> list[RuntimeToolStatus]:
    return [_manifest_status(name) for name in _KNOWN_TOOLS]


def _tools_block(prompt: str) -> str:
    start = prompt.index("## Executable Tools")
    end = prompt.find("\n\n## ", start)
    return prompt[start:] if end < 0 else prompt[start:end]


def _prompt(**kwargs: Any) -> str:
    return str(
        ContextBuilder(workspace_root=None).build_system_prompt(
            "Base prompt.",
            tool_statuses=_statuses(),
            include_skills=False,
            include_bootstrap=False,
            **kwargs,
        )
    )


def test_native_schema_path_renders_names_only() -> None:
    block = _tools_block(_prompt(native_tool_schemas=True))
    read_file_description = _manifest_status("read_file").description.strip()

    assert read_file_description
    assert read_file_description not in block
    assert "Example arguments" not in block
    assert "Available now: read_file, grep_search, list_dir" in block
    assert "come with the tool schemas" in block
    # Non-schema guidance in the section survives the trim.
    assert "Skills are guidance only." in block
    assert "not shell commands" in block
    assert "Any tool not listed as available in this block is unavailable" in block


def test_prompt_based_path_keeps_full_descriptions() -> None:
    for kwargs in ({}, {"native_tool_schemas": False}):
        block = _tools_block(_prompt(**kwargs))
        assert _manifest_status("read_file").description.strip() in block
        assert "Example arguments" in block
        assert "- `read_file`" in block


def test_native_schema_path_keeps_blocked_preconditions() -> None:
    statuses = [
        _manifest_status("read_file"),
        _manifest_status("grep_search", applicable=False, unmet_preconditions=("git_repo",)),
    ]
    block = ContextBuilder._render_executable_tools(statuses, native_tool_schemas=True)

    assert "Available now: read_file\n" in block
    assert "Available, but will fail until fixed:" in block
    assert "- `grep_search`" in block and "Fix:" in block


_NOT_LOADED_PREFIX = (
    "Not loaded this turn (call `tool_search` with `select:<name>` to load, then call it): "
)
_WIDENED_TRAILER = (
    "Any tool not listed in this block as available or not loaded is unavailable for this request."
)


def _deferred_statuses() -> list[RuntimeToolStatus]:
    # MQ-013: a budget-deferred task_board must stay discoverable from the digest.
    deferred = {"available": False, "reason": "model/runtime does not expose this turn"}
    return [
        _manifest_status("read_file"),
        _manifest_status("task_board", deferred=True, **deferred),
        _manifest_status("edit_file", deferred=True, **deferred),
        _manifest_status("python_execute", available=False, reason="config disabled"),
        RuntimeToolStatus(name="tool_search", display_name="Tool Search", available=True),
    ]


def test_names_only_digest_lists_not_loaded_tools_and_widens_trailer() -> None:
    block = ContextBuilder._render_executable_tools(
        _deferred_statuses(), native_tool_schemas=True
    )

    assert "Available now: read_file, tool_search\n" in block
    assert f"{_NOT_LOADED_PREFIX}edit_file, task_board\n{_WIDENED_TRAILER}" in block
    assert block.endswith(_WIDENED_TRAILER)
    assert "python_execute" not in block


def test_full_digest_lists_not_loaded_tools_and_widens_trailer() -> None:
    block = ContextBuilder._render_executable_tools(_deferred_statuses())

    assert "- `read_file`" in block and "Example arguments" in block
    assert "- `task_board`" not in block
    assert block.endswith(f"{_NOT_LOADED_PREFIX}edit_file, task_board\n{_WIDENED_TRAILER}")


class _Engine:
    def __init__(self, supports_tool_calling: Any) -> None:
        self.supports_tool_calling = supports_tool_calling

    def get_model_context_length(self) -> int:
        return 32_768


@pytest.mark.parametrize(("supports", "expected"), [(True, True), (False, False), (None, False)])
def test_router_prompt_follows_engine_native_tool_support(supports: Any, expected: bool) -> None:
    kernel = _FilterKernel()
    kernel._engine = _Engine(supports)
    builder = _RecordingContextBuilder()
    kernel._context_builder = builder

    tool_budget_filter_module.build_system_prompt_for_statuses(_filter_input(kernel), ())

    assert builder.calls[-1]["native_tool_schemas"] is expected


@pytest.mark.parametrize(("supports", "expected"), [(True, True), (False, False)])
def test_approval_resume_prompt_follows_engine_native_tool_support(
    supports: bool, expected: bool
) -> None:
    captured: dict[str, object] = {}

    def _build_system_prompt(_base: str, **kwargs: object) -> str:
        captured.update(kwargs)
        return "rebuilt"

    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                system_prompt="Frozen", session_start_date="2026-04-13", engine_type="x"
            ),
            engine=_Engine(supports),
            router=SimpleNamespace(
                _context_builder=SimpleNamespace(build_system_prompt=_build_system_prompt)
            ),
        )
    )
    plan = _build_approval_plan_for_chat_tests(current_date="2026-07-18")

    _build_live_approval_system_prompt(
        plan, brain_container=brain_container, live_params={}, tool_statuses=()
    )

    assert captured["native_tool_schemas"] is expected
