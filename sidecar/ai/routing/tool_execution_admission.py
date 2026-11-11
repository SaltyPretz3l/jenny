"""Pre-dispatch admission helpers for ``tool_execution``.

The call-shape check, the policy pre-filter wrapper, descriptor-argument
validation and the refusal outcomes ``execute_tool`` returns before anything is
dispatched, plus the approval predicates ``approval_if_needed`` consults. The hub
(``tool_execution``) re-exports the names its consumers and tests import.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from sidecar.ai.routing.route_policy_runtime import increment_counter_for_kernel
from sidecar.ai.tools import assembly as _tools_assembly
from sidecar.ai.tools import schema_examples as _tools_schema_examples
from sidecar.ai.tools import tool_actions as _tool_actions
from sidecar.ai.tools.policy import (
    ToolPolicyFilterContext,
    ToolPolicyFilterResult,
    assert_valid_tool_call,  # noqa: F401  (re-exported for tool_execution)
)
from sidecar.ai.tools.policy import filter_tool_calls_by_policy as _filter_tool_calls_by_policy
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.tool_execution_support import (
    CMP_LOOP_TOOL_INPUT_VALIDATION,
    ToolCallRequest,
    ToolExecutionFailure,
    validate_descriptor_arguments,
    validation_detail,
)

if TYPE_CHECKING:
    from sidecar.runtime.tool_execution_support import ToolExecutionOutcome

# The hub's logger: these records keep the ``sidecar.ai.routing.tool_execution`` name.
logger = logging.getLogger("sidecar.ai.routing.tool_execution")
ALWAYS_ASK_DESTRUCTIVE_TOOLS = frozenset({"delete_file", "move_file", "worktree_delete"})


def runs_python(tool_name: str, arguments: dict[str, Any]) -> bool:
    """python_execute, or a run_temp_script that launches a Python interpreter."""
    # temp_script._validated_language accepts only exact SCRIPT_INTERPRETERS keys
    # (omitted = cmd/sh), and "python" is the only key mapped to a Python
    # interpreter; test_tool_execution_security pins that. Not imported here:
    # this module stays within its import fan-out budget.
    return tool_name == "python_execute" or (
        tool_name == "run_temp_script" and arguments.get("language") == "python"
    )


def blocked_outcome(
    outcome_type: Any, call: ToolCallRequest, reason: str | None, tool_input: dict[str, object]
) -> ToolExecutionOutcome:
    return outcome_type(
        tool_name=call.tool_id,
        output=_tools_assembly.blocked_tool_message(call.tool_id, reason),
        success=False, tool_input=tool_input,
        error_code=_tools_assembly.blocked_tool_error_code(reason),
        metadata=_tools_assembly.blocked_tool_metadata(reason), call_id=call.call_id,
    )


def descriptor_validation_outcome(  # noqa: PLR0913 - keyword-only
    *,
    kernel: Any,
    call: ToolCallRequest,
    descriptor: Any | None,
    visible_tool_arguments: dict[str, object],
    request_id: str,
    outcome_type: Any,
) -> ToolExecutionOutcome | None:
    if descriptor is None or (
        call.coerced and not _tool_actions.effective_side_effecting(descriptor, call.arguments)
    ):
        return None
    try:
        validate_descriptor_arguments(call.tool_id, visible_tool_arguments, descriptor)
    except ToolExecutionFailure as error:
        repair_hints = _tools_schema_examples.tool_schema_repair_hints(
            _tools_assembly.model_facing_parameters(descriptor)
        )
        message = validation_detail(error.message).strip()
        sentence = message if not message or message.endswith((".", "!", "?")) else f"{message}."
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.tool_call_input_validation_failed",
            message=f"Rejected tool call with invalid arguments: {call.tool_id}",
            status="failure",
            data={
                "tool": call.tool_id,
                "validation_error": error.message,
                "code": CMP_LOOP_TOOL_INPUT_VALIDATION,
                "request_id": request_id,
            },
        )
        increment_counter_for_kernel(kernel, "validation_failure")
        return outcome_type(
            tool_name=call.tool_id,
            output=(
                f"Tool '{call.tool_id}' rejected malformed arguments: "
                f"{sentence}{_tools_schema_examples.tool_schema_hint_text(repair_hints)}"
            ),
            success=False,
            tool_input=visible_tool_arguments,
            error_code=CMP_LOOP_TOOL_INPUT_VALIDATION,
            metadata={
                "validation_error": error.message,
                "required_keys": repair_hints["required_keys"],
                "minimal_valid_arguments": repair_hints["minimal_valid_arguments"],
            },
            call_id=call.call_id,
        )
    return None


def filter_tool_calls_by_policy(  # noqa: PLR0913 - router-facing signature
    kernel: Any,
    calls: tuple[ToolCallRequest, ...],
    *,
    mode: str,
    mode_allows_side_effecting: bool,
    resolution_context: Any | None,
    tool_contract: Any | None = None,
    plan_mode: bool = False,
    read_only: bool = False,
    request_disabled_tools: frozenset[str] = frozenset(),
    policy_snapshot: Any | None = None,
) -> ToolPolicyFilterResult:
    return _filter_tool_calls_by_policy(
        kernel,
        calls,
        ToolPolicyFilterContext(
            mode=mode,
            mode_allows_side_effecting=mode_allows_side_effecting,
            resolution_context=resolution_context,
            tool_contract=tool_contract,
            plan_mode=plan_mode,
            read_only=read_only,
            request_disabled_tools=request_disabled_tools,
            policy_snapshot=policy_snapshot,
        ),
    )
