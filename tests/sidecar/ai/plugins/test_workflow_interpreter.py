from __future__ import annotations

from sidecar.ai.plugins.runtime_registry import (
    PluginCommandResolution,
    PluginDeclarativeContribution,
    PluginRuntimeAuthority,
    PluginRuntimeGeneration,
    PluginSettingsRecord,
)
from sidecar.ai.plugins.workflow_interpreter import (
    MAX_NODE_OUTPUT_BYTES,
    WorkflowExecutionContext,
    WorkflowNodeOutcome,
    execute_workflow,
    render_prompt_command,
)


def _contribution(contribution_id: str, kind: str, payload: dict[str, object]):
    return PluginDeclarativeContribution(
        publisher_id="jenny-official",
        plugin_id="starter",
        contribution_id=contribution_id,
        kind=kind,
        content_digest=(contribution_id[0] * 64),
        payload={"kind": kind, **payload},
    )


def _resolution(*, max_attempts: int = 1) -> PluginCommandResolution:
    prompt = _contribution(
        "prompt-main", "prompt",
        {"template": "Summarize {{subject}}", "placeholders": ["subject"]},
    )
    workflow = _contribution("workflow-main", "workflow", {
        "entry_node_id": "start",
        "nodes": [
            {
                "type": "tool", "node_id": "start", "tool_id": "read_file",
                "bindings": [{
                    "target": "path",
                    "value": {
                        "source": "setting", "settings_contribution_id": "settings-main",
                        "key": "path",
                    },
                }],
                "max_attempts": max_attempts, "timeout_ms": 1000,
            },
            {
                "type": "prompt", "node_id": "finish",
                "target_contribution_id": "prompt-main",
                "bindings": [{
                    "target": "subject",
                    "value": {"source": "node_output", "node_id": "start"},
                }],
                "max_attempts": 1, "timeout_ms": 1000,
            },
        ],
        "edges": [{"from_node_id": "start", "to_node_id": "finish"}],
        "total_timeout_ms": 5000,
    })
    command = _contribution("command-main", "command", {
        "target_kind": "workflow", "target_contribution_id": "workflow-main",
        "inputs": [],
    })
    authority = PluginRuntimeAuthority(1, "a" * 64, 1, "gen-current")
    generation = PluginRuntimeGeneration(
        authority=authority,
        sidecar_plugin_generation="sidecar-current",
        contributions=(),
        declarative=(prompt, workflow, command),
        settings=(PluginSettingsRecord(
            publisher_id="jenny-official", plugin_id="starter",
            contribution_id="settings-main", schema_digest="d" * 64,
            revision=1, values=(("path", "string", "README.md"),),
        ),),
    )
    return PluginCommandResolution(generation, command, workflow, ())


def test_workflow_runs_in_deterministic_order_with_explicit_bindings() -> None:
    calls: list[tuple[str, object]] = []
    statuses: list[tuple[str, str]] = []

    result = execute_workflow(
        _resolution(),
        WorkflowExecutionContext(
            tool_runner=lambda tool, arguments, _node, _timeout: (
                calls.append((tool, arguments)),
                WorkflowNodeOutcome(True, output="file text"),
            )[1],
            prompt_runner=lambda prompt, _timeout: (
                calls.append(("prompt", prompt)),
                WorkflowNodeOutcome(True, output="summary"),
            )[1],
            emit_status=lambda node, state: statuses.append((node, state)),
        ),
    )

    assert result.ok is True
    assert result.output == "summary"
    assert calls == [
        ("read_file", {"path": "README.md"}),
        ("prompt", "Summarize file text"),
    ]
    assert result.node_states == (("start", "completed"), ("finish", "completed"))
    assert statuses == [
        ("start", "running"), ("start", "completed"),
        ("finish", "running"), ("finish", "completed"),
    ]


def test_workflow_retries_only_structured_retryable_failures() -> None:
    attempts = 0

    def retrying_tool(*_args: object) -> WorkflowNodeOutcome:
        nonlocal attempts
        attempts += 1
        return (
            WorkflowNodeOutcome(False, code="CMP-TOOL-0008", retryable=True)
            if attempts == 1
            else WorkflowNodeOutcome(True, output="recovered")
        )

    result = execute_workflow(
        _resolution(max_attempts=2),
        WorkflowExecutionContext(
            tool_runner=retrying_tool,
            prompt_runner=lambda _prompt, _timeout: WorkflowNodeOutcome(True, output="done"),
        ),
    )
    assert result.ok is True
    assert attempts == 2

    denied_attempts: list[int] = []
    denied = execute_workflow(
        _resolution(max_attempts=2),
        WorkflowExecutionContext(
            tool_runner=lambda *_args: (
                denied_attempts.append(1),
                WorkflowNodeOutcome(False, code="denied", retryable=True),
            )[1],
            prompt_runner=lambda _prompt, _timeout: WorkflowNodeOutcome(True, output="unused"),
        ),
    )
    assert denied.ok is False
    assert denied.code == "denied"
    assert len(denied_attempts) == 1
    assert denied.node_states == (("start", "failed"), ("finish", "skipped"))


def test_workflow_cancellation_and_output_bounds_fail_closed() -> None:
    cancelled = execute_workflow(
        _resolution(),
        WorkflowExecutionContext(
            tool_runner=lambda *_args: WorkflowNodeOutcome(True, output="unused"),
            prompt_runner=lambda _prompt, _timeout: WorkflowNodeOutcome(True, output="unused"),
            is_cancelled=lambda: True,
        ),
    )
    assert cancelled.code == "cancelled"

    bounded = execute_workflow(
        _resolution(),
        WorkflowExecutionContext(
            tool_runner=lambda *_args: WorkflowNodeOutcome(
                True, output="x" * (MAX_NODE_OUTPUT_BYTES + 100)
            ),
            prompt_runner=lambda prompt, _timeout: WorkflowNodeOutcome(True, output=prompt),
        ),
    )
    assert bounded.ok is True
    assert len(bounded.output.encode("utf-8")) <= MAX_NODE_OUTPUT_BYTES


def test_prompt_command_substitution_is_single_pass() -> None:
    prompt = _contribution(
        "prompt-main", "prompt",
        {"template": "{{first}} / {{second}}", "placeholders": ["first", "second"]},
    )
    command = _contribution("command-main", "command", {
        "target_kind": "prompt", "target_contribution_id": "prompt-main", "inputs": [],
    })
    generation = PluginRuntimeGeneration(
        PluginRuntimeAuthority(1, "a" * 64, 1, "gen-current"), "sidecar", (),
        declarative=(prompt, command),
    )
    resolution = PluginCommandResolution(
        generation, command, prompt,
        (("first", "string", "{{second}}"), ("second", "string", "done")),
    )
    assert render_prompt_command(resolution) == "{{second}} / done"
