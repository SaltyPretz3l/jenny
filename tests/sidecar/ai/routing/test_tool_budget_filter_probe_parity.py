from __future__ import annotations

import logging
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context import token_budget as token_budget_module
from sidecar.ai.context.compaction import CompactionResult
from sidecar.ai.context.token_budget import (
    BudgetTracker,
    CharEstimationBackend,
    TokenBudget,
)
from sidecar.ai.routing import tool_budget_filter as tool_budget_filter_module
from sidecar.ai.routing.chat_decision import (
    _BudgetPreflightContext,
    _CompactionInput,
    _terminal_compaction_result,
)
from sidecar.ai.routing.tool_budget_filter import (
    ToolBudgetFilterInput,
    ToolBudgetFilterResult,
    _budget_pressure_for_tool_filter,
    apply_budget_aware_tool_filter,
)
from sidecar.ai.tools.assembly import AssembledToolContract, AssembledToolEntry
from sidecar.ai.tools.catalog import CanonicalToolAvailability, CanonicalToolDescriptor
from sidecar.ai.tools.tool_search import ToolResolutionContext
from sidecar.runtime.chat_models import ChatRequestContext


class _Config:
    tools_enabled = True
    engine_type = "chatgpt"
    model = "probe-model"
    system_prompt = "s" * 36_000
    system_prompt_profile = "auto"
    assistant_name = "Jenny"
    tools_workspace_manifest_enabled = False
    tools_task_capsule_enabled = False
    context_length = 32_768
    max_tokens = 8_192
    token_budget_reserved_for_summary = None
    token_budget_tool_overhead = None
    token_budget_warning_ratio = None
    token_budget_auto_compact_ratio = None
    token_budget_auto_compact_ratio_by_model = None


class _Engine:
    def get_model_context_length(self) -> int:
        return 32_768

    def get_model_max_output_tokens(self) -> int:
        return 8_192


class _ContextBuilder:
    def build_system_prompt(self, prompt: str, **_kwargs: Any) -> str:
        return prompt

    def build_skills_system_message(self, **_kwargs: Any) -> str:
        return ""

    def insert_runtime_system_messages(
        self,
        messages: list[dict[str, object]],
        runtime_messages: list[str],
    ) -> list[dict[str, object]]:
        return [
            *messages,
            *(
                {"role": "system", "content": content.strip()}
                for content in runtime_messages
                if content.strip()
            ),
        ]


def _tool_contract(
    hidden_names: frozenset[str] = frozenset(),
    *,
    tool_count: int = 24,
    include_plan_artifact: bool = False,
) -> AssembledToolContract:
    entries = []
    for index in range(tool_count):
        name = f"tool_{index:02d}"
        descriptor = CanonicalToolDescriptor(
            name=name,
            description=f"Tool {index}",
            input_schema={"type": "object", "properties": {}},
            side_effecting=False,
            read_only=True,
        )
        entries.append(
            AssembledToolEntry(
                descriptor=descriptor,
                available=True,
                prompt_schema=(
                    None
                    if name in hidden_names
                    else {
                        "name": name,
                        "description": descriptor.description,
                        "parameters": descriptor.input_schema,
                    }
                ),
            )
        )
    if include_plan_artifact:
        descriptor = CanonicalToolDescriptor(
            name="create_artifact",
            description="Create one inert Plan Mode document.",
            input_schema={"type": "object", "properties": {}},
            side_effecting=True,
            read_only=False,
            tool_family="artifact",
            availability=CanonicalToolAvailability(plan_mode_artifact_write=True),
        )
        entries.append(
            AssembledToolEntry(
                descriptor=descriptor,
                available=True,
                prompt_schema=(
                    None
                    if descriptor.name in hidden_names
                    else {
                        "name": descriptor.name,
                        "description": descriptor.description,
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "artifact_kind": {"type": "string", "enum": ["document"]},
                                "content": {"type": "string", "maxLength": 512 * 1024},
                            },
                            "required": ["artifact_kind", "content"],
                            "additionalProperties": False,
                        },
                    }
                ),
            )
        )
    return AssembledToolContract(tuple(entries))


_INCIDENT_TOOL_NAMES = (
    "delete_file",
    "tool_search",
    "check_background_job",
    "check_monitor",
    "operation_status",
    "monitor",
    "read_file",
    "grep_search",
    "edit_file",
    "write_file",
    "glob_files",
    "list_dir",
    "workspace_manifest_read",
    "move_file",
    "run_command",
    "git_status",
    "web_search",
)


def _incident_tool_contract(
    hidden_names: frozenset[str] = frozenset(),
) -> AssembledToolContract:
    entries = []
    for name in _INCIDENT_TOOL_NAMES:
        filesystem = name in {
            "read_file",
            "grep_search",
            "edit_file",
            "write_file",
            "glob_files",
            "list_dir",
            "workspace_manifest_read",
            "delete_file",
            "move_file",
        }
        descriptor = CanonicalToolDescriptor(
            name=name,
            description=f"Test descriptor for {name}",
            input_schema={"type": "object", "properties": {}},
            side_effecting=name
            in {"edit_file", "write_file", "delete_file", "move_file", "run_command"},
            read_only=name
            not in {"edit_file", "write_file", "delete_file", "move_file", "run_command"},
            tool_family="filesystem" if filesystem else None,
        )
        entries.append(
            AssembledToolEntry(
                descriptor=descriptor,
                available=True,
                prompt_schema=(
                    None
                    if name in hidden_names
                    else {
                        "name": name,
                        "description": descriptor.description,
                        "parameters": descriptor.input_schema,
                    }
                ),
            )
        )
    return AssembledToolContract(tuple(entries))


class _FilterKernel:
    def __init__(self, *, tool_count: int = 24, include_plan_artifact: bool = False) -> None:
        self._config = _Config()
        self._engine = _Engine()
        self._context_builder = _ContextBuilder()
        self._tool_count = tool_count
        self._include_plan_artifact = include_plan_artifact

    def _assemble_tool_contract(
        self,
        *,
        request_context: ChatRequestContext,
        resolution_context: ToolResolutionContext,
    ) -> AssembledToolContract:
        del request_context
        return _tool_contract(
            resolution_context.budget_filtered_names,
            tool_count=self._tool_count,
            include_plan_artifact=self._include_plan_artifact,
        )


class _IncidentFilterKernel(_FilterKernel):
    def _assemble_tool_contract(
        self,
        *,
        request_context: ChatRequestContext,
        resolution_context: ToolResolutionContext,
    ) -> AssembledToolContract:
        del request_context
        return _incident_tool_contract(resolution_context.budget_filtered_names)


def _filter_input(
    kernel: _FilterKernel,
    *,
    plan_mode: bool = False,
    tool_preferences: dict[str, tuple[str, ...]] | None = None,
) -> ToolBudgetFilterInput:
    request_context = ChatRequestContext(
        request_id="req-probe",
        trace_id=None,
        session_id="session-probe",
        mode="chat",
        approvals_pre_granted=True,
        plan_mode=plan_mode,
        read_only=plan_mode,
        tool_preferences=tool_preferences,
    )
    return ToolBudgetFilterInput(
        kernel=kernel,
        feature_flags={"token_budget": True},
        request_context=request_context,
        tool_resolution_context=ToolResolutionContext(deferred_names=frozenset()),
        semantic_history=[],
        runtime_overlay_messages=["r" * 2_000],
        context_block_messages=[{"role": "system", "content": "c" * 2_000}],
        learned_lessons=None,
        prompt_cache_enabled=False,
        pinned_current_date="2026-08-29",
        latest_user_content="hello",
        request_id="req-probe",
        session_id="session-probe",
        tool_search_enabled=True,
    )


def test_probe_counts_runtime_overlays_and_context_blocks_before_filtering(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        token_budget_module,
        "_create_best_backend",
        lambda _config: CharEstimationBackend(),
    )
    kernel = _FilterKernel()
    context = _filter_input(kernel)
    contract = _tool_contract()
    unfiltered = ToolBudgetFilterResult(
        contract,
        list(contract.prompt_schemas),
        contract.status_entries,
    )

    old_probe = _budget_pressure_for_tool_filter(
        replace(context, runtime_overlay_messages=[], context_block_messages=[]),
        unfiltered,
    )
    parity_probe = _budget_pressure_for_tool_filter(context, unfiltered)
    result = apply_budget_aware_tool_filter(
        context,
        tool_contract=contract,
        tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )

    assert old_probe.status is not None
    assert old_probe.status.level == "ok"
    assert parity_probe.status is not None
    assert parity_probe.status.level == "warning"
    assert len(result.tool_payload) == 12
    assert context.tool_resolution_context is not None
    assert len(context.tool_resolution_context.budget_filtered_names) == 12


def test_plan_artifact_schema_uses_the_same_32768_token_budget_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        token_budget_module,
        "_create_best_backend",
        lambda _config: CharEstimationBackend(),
    )
    kernel = _FilterKernel(tool_count=24, include_plan_artifact=True)
    context = _filter_input(
        kernel,
        plan_mode=True,
        tool_preferences={"enabled_tools": ("create_artifact",)},
    )
    contract = _tool_contract(tool_count=24, include_plan_artifact=True)
    unfiltered = ToolBudgetFilterResult(
        contract,
        list(contract.prompt_schemas),
        contract.status_entries,
    )

    probe = _budget_pressure_for_tool_filter(context, unfiltered)
    result = apply_budget_aware_tool_filter(
        context,
        tool_contract=contract,
        tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )

    assert probe.status is not None
    assert probe.status.level == "warning"
    assert len(result.tool_payload) == 12
    artifact_schema = next(
        schema for schema in result.tool_payload if schema["name"] == "create_artifact"
    )
    assert artifact_schema == contract.entry("create_artifact").prompt_schema
    assert context.tool_resolution_context is not None
    assert len(context.tool_resolution_context.budget_filtered_names) == 13


def _force_budget_pressure(monkeypatch: pytest.MonkeyPatch, level: str = "error") -> None:
    monkeypatch.setattr(
        tool_budget_filter_module,
        "_budget_pressure_for_tool_filter",
        lambda _context, _result: SimpleNamespace(
            status=SimpleNamespace(level=level, tokens_used=31_000, utilization_pct=97.0),
            system_prompt="system",
        ),
    )


def _incident_filter_input(
    *,
    has_active_background_jobs: bool = False,
) -> ToolBudgetFilterInput:
    kernel = _IncidentFilterKernel()
    base = _filter_input(kernel)
    approved_plan = {
        "title": "Finish the file implementation",
        "steps": ["Read jumpdodge.html", "Edit the power-up implementation"],
        "verification": "Parse the JavaScript file",
    }
    return replace(
        base,
        request_context=replace(base.request_context, approved_plan=approved_plan),
        latest_user_content="proceed",
        semantic_history=[
            {"role": "user", "content": "Implement the approved file-edit plan."},
            {
                "role": "tool",
                "name": "check_background_job",
                "content": "job not found",
                "is_error": True,
                "error_code": "CMP-TOOL-0016",
            },
            {"role": "tool", "name": "edit_file", "content": "updated"},
        ],
        has_active_background_jobs=has_active_background_jobs,
    )


def test_error_pressure_keeps_file_tools_and_retires_inactive_status_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _force_budget_pressure(monkeypatch)
    context = _incident_filter_input()
    contract = _incident_tool_contract()

    result = apply_budget_aware_tool_filter(
        context,
        tool_contract=contract,
        tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )

    metadata = context.tool_resolution_context.budget_filter_metadata
    assert metadata["kept_names"] == [
        "tool_search",
        "read_file",
        "grep_search",
        "edit_file",
        "write_file",
    ]
    assert len(result.tool_payload) == 5
    assert {
        "check_background_job",
        "check_monitor",
        "operation_status",
    }.issubset(context.tool_resolution_context.budget_filtered_names)


def test_error_pressure_keeps_repair_tools_without_file_keyword(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _force_budget_pressure(monkeypatch)
    context = _incident_filter_input()
    context = replace(
        context,
        request_context=replace(context.request_context, approved_plan=None),
        latest_user_content="the start button does not currently work!",
        semantic_history=[],
    )
    contract = _incident_tool_contract()

    apply_budget_aware_tool_filter(
        context,
        tool_contract=contract,
        tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )

    kept = context.tool_resolution_context.budget_filter_metadata["kept_names"]
    assert "read_file" in kept
    assert "edit_file" in kept
    assert "delete_file" not in kept


def test_filesystem_priority_does_not_widen_web_gate_or_other_contracts() -> None:
    incident_names = tool_budget_filter_module._budget_relevant_family_names(  # noqa: SLF001
        "the start button does not currently work!", _incident_tool_contract()
    )

    assert "read_file" in incident_names
    assert "web_search" not in incident_names
    assert tool_budget_filter_module._budget_relevant_family_names(  # noqa: SLF001
        "the start button does not currently work!", _tool_contract()
    ) == ()


def test_active_background_job_keeps_only_its_status_tool_under_error_pressure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _force_budget_pressure(monkeypatch)
    context = _incident_filter_input(has_active_background_jobs=True)
    contract = _incident_tool_contract()

    apply_budget_aware_tool_filter(
        context,
        tool_contract=contract,
        tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )

    assert context.tool_resolution_context.budget_filter_metadata["kept_names"] == [
        "tool_search",
        "check_background_job",
        "read_file",
        "grep_search",
        "edit_file",
    ]
    assert "check_monitor" in context.tool_resolution_context.budget_filtered_names
    assert "operation_status" in context.tool_resolution_context.budget_filtered_names


class _TerminalKernel:
    def __init__(self) -> None:
        self._context_builder = _ContextBuilder()

    def _context_tokens_estimate(self, messages: list[dict[str, object]]) -> int:
        return len(messages)


def _terminal_inputs(
    content: str,
) -> tuple[_BudgetPreflightContext, _CompactionInput, CompactionResult]:
    budget = TokenBudget(context_window=8_192, max_output_tokens=2_048)
    tracker = BudgetTracker(
        budget=budget,
        num_tools=24,
        backend=CharEstimationBackend(),
    )
    messages = [{"role": "user", "content": content}]
    context = _BudgetPreflightContext(
        kernel=_TerminalKernel(),
        feature_flags={},
        tool_payload=[{"parameters": {}}] * 24,
        prompt_cache_enabled=False,
        request_id="req-terminal",
        session_id="session-terminal",
        system_prompt_text="system",
        runtime=None,
        cache_break_detector=None,
        cache_source_key="cache-key",
        reasoning_effort=None,
        input_complete=True,
    )
    compaction = _CompactionInput(
        working_messages=messages,
        runtime_system_messages=[],
        budget=budget,
        budget_tracker=tracker,
        num_tools=24,
        status=object(),
    )
    result = CompactionResult(
        messages=messages,
        strategy="none",
        tokens_before=0,
        tokens_after=0,
        error="Context budget exhausted.",
    )
    return context, compaction, result


def test_compaction_soft_overrun_proceeds_below_physical_limit(
    caplog: pytest.LogCaptureFixture,
) -> None:
    context, compaction, compaction_result = _terminal_inputs("x" * 20_000)

    with caplog.at_level(logging.WARNING, logger="sidecar.ai.routing.chat_decision"):
        result = _terminal_compaction_result(context, compaction, compaction_result)

    assert result.terminal_decision is None
    records = [
        record
        for record in caplog.records
        if getattr(record, "event", None) == "ai.router.compaction_soft_overrun_proceeding"
    ]
    assert len(records) == 1
    assert records[0].data == {
        "tokens_used": 5_004,
        "hard_limit": 6_144,
        "num_tools": 24,
    }


def test_compaction_terminal_is_preserved_at_physical_limit() -> None:
    context, compaction, compaction_result = _terminal_inputs("x" * 25_000)

    result = _terminal_compaction_result(context, compaction, compaction_result)

    assert result.terminal_decision is not None
    assert result.terminal_decision.terminal_error_code == "CMP-CTX-0002"
