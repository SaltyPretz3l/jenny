from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from sidecar.ai.mode_policy import MODE_ASSIST
from sidecar.ai.routing.tool_execution_snapshots import freeze_effective_execution_inputs
from sidecar.ai.tools.assembly import ToolAssemblyContext, assemble_tool_contract
from sidecar.ai.tools.catalog import (
    MANAGED_SIDECAR_SURFACE,
    CanonicalToolAvailability,
    CanonicalToolDescriptor,
    tool_manifest_path,
)
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.plan_artifact_policy import (
    MAX_PLAN_ARTIFACT_BYTES,
    PLAN_ARTIFACT_WRITE_ARG,
    is_plan_artifact_write_eligible,
    is_safe_plan_document,
    strip_plan_artifact_write_arg,
)


def _document(**overrides: object) -> dict[str, object]:
    arguments: dict[str, object] = {
        "artifact_kind": "document",
        "title": "Plan",
        "content": "# Plan\n",
        "file_name": "plan.md",
        "language": "markdown",
        "extension": ".md",
    }
    arguments.update(overrides)
    return arguments


@pytest.mark.parametrize(
    ("language", "file_name", "extension"),
    [
        ("markdown", "plan.md", ".md"),
        ("plain text", "notes.txt", ".txt"),
        ("mermaid", "flow.mmd", ".mmd"),
        ("json", "data.json", ".json"),
        ("yml", "data.yml", ".yml"),
        ("csv", "data.csv", ".csv"),
    ],
)
def test_safe_plan_document_accepts_consistent_inert_classifiers(
    language: str,
    file_name: str,
    extension: str,
) -> None:
    assert is_safe_plan_document(
        _document(language=language, file_name=file_name, extension=extension)
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"artifact_kind": "script"},
        {"language": "html", "file_name": "payload.html", "extension": ".html"},
        {"language": "svg", "file_name": "payload.svg", "extension": ".svg"},
        {"language": "javascript", "file_name": "payload.js", "extension": ".js"},
        {"language": "json", "file_name": "plan.md", "extension": ".md"},
        {"content": "x" * (MAX_PLAN_ARTIFACT_BYTES + 1)},
        {"content": "😀" * ((MAX_PLAN_ARTIFACT_BYTES // 4) + 1)},
    ],
)
def test_safe_plan_document_rejects_executable_conflicting_or_oversized_inputs(
    overrides: dict[str, object],
) -> None:
    assert not is_safe_plan_document(_document(**overrides))


def test_reserved_capability_is_stripped_without_mutating_input() -> None:
    forged = {"title": "Plan", PLAN_ARTIFACT_WRITE_ARG: True}

    sanitized = strip_plan_artifact_write_arg(forged)

    assert PLAN_ARTIFACT_WRITE_ARG not in sanitized
    assert forged[PLAN_ARTIFACT_WRITE_ARG] is True


def test_manifest_capability_is_owned_only_by_first_party_artifact_tools() -> None:
    payload = json.loads(tool_manifest_path().read_text(encoding="utf-8"))
    flagged = {
        entry["name"]
        for entry in payload["tools"]
        if entry.get("availability", {}).get("plan_mode_artifact_write") is True
    }

    assert flagged == {"create_artifact", "mermaid_generate"}


def test_plan_mode_exposes_only_the_narrowed_create_artifact_schema() -> None:
    descriptor = CanonicalToolDescriptor(
        name="create_artifact",
        description="full artifact tool",
        input_schema={
            "type": "object",
            "properties": {
                "artifact_kind": {"enum": ["document", "script"]},
                "content": {"type": "string"},
            },
        },
        side_effecting=True,
        read_only=False,
        tool_family="artifact",
        surfaces=(MANAGED_SIDECAR_SURFACE,),
        availability=CanonicalToolAvailability(plan_mode_artifact_write=True),
        runtime_registered=True,
    )
    contract = assemble_tool_contract(
        (descriptor,),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={"tools_enabled": True},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            plan_mode=True,
            read_only=True,
            workspace_root_present=True,
        ),
    )

    entry = contract.entry("create_artifact")
    assert entry is not None and entry.available is True
    parameters = entry.prompt_schema["parameters"]
    assert parameters["properties"]["artifact_kind"]["enum"] == ["document"]
    assert set(parameters["properties"]["extension"]["enum"]) == {
        ".md", ".markdown", ".txt", ".mmd", ".mermaid", ".json", ".yaml", ".yml", ".csv"
    }
    assert {"Markdown", "plain text", "Mermaid", "JSON", "YAML", "CSV"}.issubset(
        parameters["properties"]["language"]["enum"]
    )
    assert parameters["additionalProperties"] is False


def test_plan_capability_requires_mode_descriptor_and_safe_payload() -> None:
    descriptor = CanonicalToolDescriptor(
        name="create_artifact",
        description="artifact",
        input_schema={"type": "object", "properties": {}},
        side_effecting=True,
        read_only=False,
        availability=CanonicalToolAvailability(plan_mode_artifact_write=True),
    )

    assert is_plan_artifact_write_eligible(
        descriptor,
        "create_artifact",
        _document(),
        plan_mode=True,
        read_only=True,
    )
    assert not is_plan_artifact_write_eligible(
        descriptor,
        "create_artifact",
        _document(language="html", file_name="x.html", extension=".html"),
        plan_mode=True,
        read_only=True,
    )
    assert not is_plan_artifact_write_eligible(
        descriptor,
        "create_artifact",
        _document(),
        plan_mode=False,
        read_only=True,
    )


def test_freeze_injects_capability_only_into_effective_and_context_fingerprints() -> None:
    descriptor = CanonicalToolDescriptor(
        name="create_artifact",
        description="artifact",
        input_schema={"type": "object", "properties": {}},
        side_effecting=True,
        read_only=False,
        availability=CanonicalToolAvailability(plan_mode_artifact_write=True),
    )
    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root=None),
        _mcp_client=SimpleNamespace(
            tool_descriptor=lambda _name: SimpleNamespace(name="create_artifact")
        ),
    )
    tool_contract = SimpleNamespace(
        entry=lambda _name: SimpleNamespace(descriptor=descriptor)
    )
    call = ToolCallRequest(
        tool_id="create_artifact",
        call_id="plan-artifact",
        arguments={**_document(), PLAN_ARTIFACT_WRITE_ARG: True},
    )

    frozen = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id="session",
        read_snapshot_cache={},
        tool_contract=tool_contract,
        plan_mode=True,
        read_only=True,
    )

    assert PLAN_ARTIFACT_WRITE_ARG not in frozen.visible_tool_arguments
    assert frozen.effective_tool_arguments[PLAN_ARTIFACT_WRITE_ARG] is True
    assert PLAN_ARTIFACT_WRITE_ARG in frozen.injected_arg_keys
    assert frozen.execution_context_payload["plan_artifact_write"] is True


def test_unrelated_frozen_inputs_ignore_plan_mode_and_forged_capability() -> None:
    descriptor = CanonicalToolDescriptor(
        name="read_file",
        description="read",
        input_schema={"type": "object", "properties": {}},
        side_effecting=False,
        read_only=True,
    )
    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root=None),
        _mcp_client=SimpleNamespace(
            tool_descriptor=lambda _name: SimpleNamespace(name="create_artifact")
        ),
    )
    tool_contract = SimpleNamespace(
        entry=lambda _name: SimpleNamespace(descriptor=descriptor)
    )
    call = ToolCallRequest(
        tool_id="read_file",
        call_id="unrelated",
        arguments={"path": "README.md", PLAN_ARTIFACT_WRITE_ARG: True},
    )

    plan_frozen = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id="session",
        read_snapshot_cache={},
        tool_contract=tool_contract,
        plan_mode=True,
        read_only=True,
    )
    normal_frozen = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id="session",
        read_snapshot_cache={},
        tool_contract=tool_contract,
        plan_mode=False,
        read_only=False,
    )

    assert PLAN_ARTIFACT_WRITE_ARG not in plan_frozen.effective_tool_arguments
    assert plan_frozen.effective_args_fingerprint == normal_frozen.effective_args_fingerprint
    assert plan_frozen.execution_context_payload == normal_frozen.execution_context_payload


def test_approved_artifact_reuses_frozen_capability_across_live_mode_toggle() -> None:
    descriptor = CanonicalToolDescriptor(
        name="create_artifact",
        description="artifact",
        input_schema={"type": "object", "properties": {}},
        side_effecting=True,
        read_only=False,
        availability=CanonicalToolAvailability(plan_mode_artifact_write=True),
    )
    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root=None),
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="create_artifact",
        call_id="approved-plan-artifact",
        arguments=_document(),
    )

    before_approval = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id="session",
        read_snapshot_cache={},
        plan_mode=True,
        read_only=True,
    )
    after_live_toggle = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id="session",
        read_snapshot_cache={},
        plan_mode=False,
        read_only=False,
        trusted_plan_artifact_write=True,
    )

    assert before_approval.effective_args_fingerprint == after_live_toggle.effective_args_fingerprint
    assert before_approval.execution_context_payload == after_live_toggle.execution_context_payload
    assert after_live_toggle.effective_tool_arguments[PLAN_ARTIFACT_WRITE_ARG] is True
