"""Finite, deterministic interpreter for Stage-4B declarative workflows."""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final

from sidecar.ai.plugins.runtime_registry import (
    PluginCommandResolution,
    PluginDeclarativeContribution,
)

MAX_NODE_OUTPUT_BYTES: Final[int] = 16 * 1024
MAX_WORKFLOW_OUTPUT_BYTES: Final[int] = 64 * 1024
NON_RETRYABLE_CODES: Final[frozenset[str]] = frozenset({
    "denied", "cancelled", "timeout", "stale_authority", "eligibility_failed",
})
_PLACEHOLDER_RE: Final[re.Pattern[str]] = re.compile(r"\{\{([a-z][a-z0-9_]*)\}\}")


@dataclass(frozen=True, slots=True)
class WorkflowNodeOutcome:
    ok: bool
    output: str = ""
    code: str = "none"
    retryable: bool = False


@dataclass(frozen=True, slots=True)
class WorkflowResult:
    ok: bool
    output: str
    node_states: tuple[tuple[str, str], ...]
    code: str = "none"


@dataclass(frozen=True, slots=True)
class WorkflowExecutionContext:
    prompt_runner: Callable[[str, int], WorkflowNodeOutcome]
    tool_runner: Callable[[str, dict[str, object], str, int], WorkflowNodeOutcome]
    emit_status: Callable[[str, str], None] | None = None
    is_cancelled: Callable[[], bool] | None = None
    monotonic: Callable[[], float] = time.monotonic


def _trim_utf8(value: str, limit: int) -> str:
    encoded = value.encode("utf-8")
    return value if len(encoded) <= limit else encoded[:limit].decode("utf-8", errors="ignore")


def _content_map(resolution: PluginCommandResolution) -> dict[str, PluginDeclarativeContribution]:
    return {
        item.contribution_id: item
        for item in resolution.generation.declarative
        if item.publisher_id == resolution.command.publisher_id
        and item.plugin_id == resolution.command.plugin_id
    }


def _setting_values(resolution: PluginCommandResolution) -> dict[tuple[str, str], object]:
    values: dict[tuple[str, str], object] = {}
    for state in resolution.generation.settings:
        if (
            state.publisher_id == resolution.command.publisher_id
            and state.plugin_id == resolution.command.plugin_id
        ):
            for key, _value_type, value in state.values:
                values[(state.contribution_id, key)] = value
    return values


def _binding_value(
    raw: Mapping[str, Any], *, inputs: Mapping[str, object],
    settings: Mapping[tuple[str, str], object], outputs: Mapping[str, str],
) -> object:
    source = raw.get("source")
    if source in {"literal_string", "literal_integer", "literal_boolean"}:
        return raw["value"]
    if source == "invocation_input":
        return inputs[raw["key"]]
    if source == "setting":
        return settings[(raw["settings_contribution_id"], raw["key"])]
    if source == "node_output":
        return outputs[raw["node_id"]]
    raise KeyError("binding source unavailable")


def _substitute(template: str, values: Mapping[str, object]) -> str:
    def replace(match: re.Match[str]) -> str:
        value = values.get(match.group(1), match.group(0))
        if not isinstance(value, str):
            raise TypeError("prompt binding requires a string")
        return value

    return _PLACEHOLDER_RE.sub(replace, template)


def _ordered_graph(
    workflow: Mapping[str, Any],
) -> tuple[dict[str, Mapping[str, Any]], dict[str, list[str]], list[str]]:
    nodes = {str(node["node_id"]): node for node in workflow["nodes"]}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    indegree = {node_id: 0 for node_id in nodes}
    for edge in workflow["edges"]:
        outgoing[edge["from_node_id"]].append(edge["to_node_id"])
        indegree[edge["to_node_id"]] += 1
    ready = sorted(
        (node_id for node_id, count in indegree.items() if count == 0),
        key=lambda item: item.encode("utf-8"),
    )
    order: list[str] = []
    while ready:
        node_id = ready.pop(0)
        order.append(node_id)
        for target in sorted(outgoing[node_id], key=lambda item: item.encode("utf-8")):
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
                ready.sort(key=lambda item: item.encode("utf-8"))
    return nodes, outgoing, order


def _node_arguments(
    node: Mapping[str, Any], *, inputs: Mapping[str, object],
    settings: Mapping[tuple[str, str], object], outputs: Mapping[str, str],
) -> dict[str, object]:
    return {
        binding["target"]: _binding_value(
            binding["value"], inputs=inputs, settings=settings, outputs=outputs,
        )
        for binding in node["bindings"]
    }


def _run_node(
    node: Mapping[str, Any], *, arguments: dict[str, object],
    contents: Mapping[str, PluginDeclarativeContribution],
    context: WorkflowExecutionContext, workflow_deadline: float,
) -> WorkflowNodeOutcome:
    outcome = WorkflowNodeOutcome(False, code="node_failed")
    for attempt in range(1, node["max_attempts"] + 1):
        remaining_ms = int(max(0.0, workflow_deadline - context.monotonic()) * 1000)
        if remaining_ms <= 0:
            return WorkflowNodeOutcome(False, code="timeout")
        timeout_ms = min(int(node["timeout_ms"]), remaining_ms)
        if node["type"] == "prompt":
            prompt = contents.get(str(node["target_contribution_id"]))
            if prompt is None or prompt.kind != "prompt":
                outcome = WorkflowNodeOutcome(False, code="prompt_unavailable")
            else:
                try:
                    rendered = _substitute(str(prompt.payload["template"]), arguments)
                except TypeError:
                    outcome = WorkflowNodeOutcome(False, code="binding_type_mismatch")
                else:
                    outcome = context.prompt_runner(rendered, timeout_ms)
        else:
            outcome = context.tool_runner(
                str(node["tool_id"]), arguments, str(node["node_id"]),
                timeout_ms,
            )
        if context.monotonic() >= workflow_deadline:
            return WorkflowNodeOutcome(False, code="timeout")
        should_stop = (
            outcome.ok or not outcome.retryable or outcome.code in NON_RETRYABLE_CODES
            or attempt == node["max_attempts"]
        )
        if should_stop:
            break
    return outcome


def _failure(
    states: dict[str, str], order: list[str], node_id: str, code: str,
) -> WorkflowResult:
    states[node_id] = "failed"
    for later in order[order.index(node_id) + 1:]:
        states[later] = "skipped"
    return WorkflowResult(False, "", tuple(states.items()), code)


def execute_workflow(
    resolution: PluginCommandResolution,
    context: WorkflowExecutionContext,
) -> WorkflowResult:
    """Execute a precompiled workflow with no expressions, branching, or loops."""

    workflow = resolution.target.payload
    nodes, outgoing, order = _ordered_graph(workflow)

    contents = _content_map(resolution)
    inputs = {key: value for key, _value_type, value in resolution.inputs}
    settings = _setting_values(resolution)
    outputs: dict[str, str] = {}
    states = {node_id: "pending" for node_id in order}
    started = context.monotonic()
    workflow_deadline = started + (workflow["total_timeout_ms"] / 1000)
    total_bytes = 0
    terminal_id = next(node_id for node_id in order if not outgoing[node_id])
    for node_id in order:
        if context.is_cancelled is not None and context.is_cancelled():
            states[node_id] = "cancelled"
            return WorkflowResult(False, "", tuple(states.items()), "cancelled")
        if (context.monotonic() - started) * 1000 >= workflow["total_timeout_ms"]:
            states[node_id] = "timeout"
            return WorkflowResult(False, "", tuple(states.items()), "timeout")
        node = nodes[node_id]
        try:
            arguments = _node_arguments(
                node, inputs=inputs, settings=settings, outputs=outputs,
            )
        except (KeyError, TypeError):
            return _failure(states, order, node_id, "binding_unavailable")
        states[node_id] = "running"
        if context.emit_status is not None:
            context.emit_status(node_id, "running")
        outcome = _run_node(
            node, arguments=arguments, contents=contents, context=context,
            workflow_deadline=workflow_deadline,
        )
        if not outcome.ok:
            return _failure(states, order, node_id, outcome.code)
        normalized = _trim_utf8(str(outcome.output), MAX_NODE_OUTPUT_BYTES)
        total_bytes += len(normalized.encode("utf-8"))
        if total_bytes > MAX_WORKFLOW_OUTPUT_BYTES:
            return _failure(states, order, node_id, "output_budget_exceeded")
        outputs[node_id] = normalized
        states[node_id] = "completed"
        if context.emit_status is not None:
            context.emit_status(node_id, "completed")
    return WorkflowResult(True, outputs.get(terminal_id, ""), tuple(states.items()))


def render_prompt_command(resolution: PluginCommandResolution) -> str:
    values = {key: value for key, _value_type, value in resolution.inputs}
    return _substitute(str(resolution.target.payload["template"]), values)
