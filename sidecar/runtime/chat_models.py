"""Core data types and constants for chat runtime."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from sidecar.ai.memory.contracts import MemoryPolicy
from sidecar.runtime.continuation_context import (
    ContinuationContext,
    continuation_context_from_params,
)

if TYPE_CHECKING:
    from sidecar.ai.engines.vision_input import VisionImage
    from sidecar.runtime.chat_continuation_resume import HydratedBeforeToolDispatchResume
    from sidecar.runtime.execution_context import ExecutionContext

DISABLED_MEMORY_POLICY = MemoryPolicy(enabled=False, capture="off", recall=False)


@dataclass(frozen=True)
class ChatResponse:
    request_id: str
    result: dict[str, Any]
    notifications: list[dict[str, Any]]
    approval_request: dict[str, Any] | None
    approval_plan: Any | None = None
    post_settlement_callback: Callable[[], None] | None = None


@dataclass(frozen=True)
class ChatRequestContext:
    request_id: str
    trace_id: str | None
    session_id: str | None
    mode: str
    approvals_pre_granted: bool
    logical_turn_id: str | None = None
    continuation_context: ContinuationContext | None = None
    runtime_continuation_resume: HydratedBeforeToolDispatchResume | None = None
    execution_context: ExecutionContext | None = None
    inference_budget_required: bool = False
    runtime_children_enabled: bool = False
    memory_policy: MemoryPolicy | None = None
    reasoning_effort: str | None = None
    # Host-owned preferences captured per turn; never mutate live engine config.
    subagent_routing: dict[str, Any] | None = None
    session_start_date: str | None = None
    current_date: str | None = None
    plan_mode: bool = False
    # Plan Plus Propose mode: read-only, and propose_change records suggestions
    # Electron owns. ``suggested_changes_context`` carries the session's live
    # suggestions ({id, path, kind, old_string}) for the overlap rule.
    propose_mode: bool = False
    suggested_changes_context: tuple[dict[str, str], ...] = ()
    # Request-local safety boundary. Plan Mode is the user-facing preference;
    # sub-agents are also read-only without pretending to be in Plan Mode.
    read_only: bool = False
    plan_decision: str = ""
    plan_feedback: str = ""
    # True once an exit_plan_mode approval landed inside this request. The
    # approval is a tool result, never a user row, so mid-turn compaction uses
    # this to keep the pre-approval prompt from reading as a live request.
    plan_approved_in_turn: bool = False
    edited_plan: dict[str, Any] | None = None
    approved_plan: dict[str, Any] | None = None
    # Set when the user accepted a plan without building it: the tool loop
    # allows exactly one toolless reply, then ends the turn.
    final_toolless_reply: bool = False
    tool_preferences: dict[str, tuple[str, ...]] | None = None
    approval_mode: str = "prompt"
    session_offline_lockdown: bool = False
    sub_agent_tool_preferences_fail_closed: bool = False
    # Trusted handoff-only preparation turn (HandoffPreparation) or None.
    handoff_preparation: Any | None = None
    # The initialize-latched ``session_messages`` grant: gates offering ``session_message``.
    session_messages_enabled: bool = False
    workspace_root_present: bool = False
    workspace_instruction_present: bool = False
    debug_options: dict[str, Any] | None = None
    # Compact per-tool ledger for a hard-interrupted prior turn of this session,
    # computed Electron-side from the surviving turn-event journal partition and
    # forwarded verbatim-ish on ``chat.send``. ``None`` on every clean or
    # approval-paused turn. Rendered by the interrupted-turn-receipts overlay.
    interrupted_turn_receipts: dict[str, Any] | None = None
    # Electron's per-turn context overlays on the TYPED trusted channel
    # (``chat.send params.context_blocks``), already kind-checked and bounded by
    # ``normalize_context_blocks``. They cannot ride ``params.messages``: the
    # semantic gate rejects every system row on untrusted request history.
    # Entries are ``{"kind": str, "content": str}``.
    context_blocks: tuple[dict[str, str], ...] = ()
    skill_invocation: dict[str, str] | None = None
    vision_images: tuple[VisionImage, ...] = ()
    vision_anchor_text: str = ""
    vision_token_surcharge: int = 0
    session_tool_call_count: int = 0
    agent_id: str | None = None
    parent_agent_id: str | None = None
    agent_depth: int = 0
    agent_surface: str = "main"
    parent_approval_plan_hash: str = ""
    sub_agent_iteration_budget: int | None = None
    sub_agent_concurrency_budget: int | None = None
    # Internal child completion contract. Legacy hidden executors retain the
    # four-field JSON report; the public delegate facade requests plain text.
    sub_agent_report_mode: str = "structured"
    inference_performance: dict[str, Any] | None = None
    # Capability gate (desktop only), independent of the live-counter opt-in.
    # False suppresses both provider options and all performance notifications.
    # Fail closed: only the desktop chat path turns it on (hosted strips the capability).
    inference_performance_enabled: bool = False

    def performance_request_fields(self) -> dict[str, Any]:
        return {
            "inference_performance": self.inference_performance,
            "inference_performance_enabled": self.inference_performance_enabled,
        }

    def restrict_tool_contract(self, contract: Any) -> Any:
        """Apply the request's handoff posture to an assembled tool contract."""
        from sidecar.ai.tools.handoff_preparation import apply_handoff_preparation

        return apply_handoff_preparation(contract, self)

    def preparation_refusal(self, tool_name: str) -> str | None:
        """The blocked reason for ``tool_name`` in a handoff preparation turn, else None."""
        from sidecar.ai.tools.handoff_preparation import (
            PREPARATION_ONLY_REASON,
            refuses_in_preparation,
        )

        return PREPARATION_ONLY_REASON if refuses_in_preparation(self, tool_name) else None


_LOGICAL_TURN_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def inference_performance_enabled_for_config(config: Any) -> bool:
    """Match the desktop-only initialize capability without an eager import edge."""
    from sidecar.ai.host_policy import host_policy_is_enforced

    return not host_policy_is_enforced(config)


def inference_performance_from_params(params: Any) -> dict[str, Any] | None:
    """W1 is closed and optional: malformed telemetry never invalidates a turn."""
    if not isinstance(params, dict):
        return None
    value = params.get("inference_performance")
    if not isinstance(value, dict) or set(value) != {"live", "provider_kind"}:
        return None
    if type(value["live"]) is not bool or value["provider_kind"] not in (
        "ninfer", "llama-server", "ollama", "other",
    ):
        return None
    return {"live": value["live"], "provider_kind": value["provider_kind"]}


def logical_turn_id_from_params(params: dict[str, Any], request_id: str) -> str:
    """Return the app-owned logical turn identity, preserving legacy streams."""

    if "logical_turn_id" not in params:
        return request_id
    value = params.get("logical_turn_id")
    if not isinstance(value, str) or _LOGICAL_TURN_ID_RE.fullmatch(value) is None:
        raise ValueError("logical_turn_id is not a canonical runtime identifier")
    return value


def continuation_identity_from_params(
    params: dict[str, Any], *, request_id: str, session_id: str | None,
    execution_context: ExecutionContext | None,
) -> tuple[str, ContinuationContext | None]:
    """Bind optional continuation identity to the enclosing chat request."""

    logical_turn_id = logical_turn_id_from_params(params, request_id)
    continuation_context = continuation_context_from_params(
        params, request_id=request_id, session_id=session_id,
        execution_context=execution_context,
    )
    if continuation_context is not None and continuation_context.turn_id != logical_turn_id:
        raise ValueError("continuation logical_turn_id mismatch")
    return logical_turn_id, continuation_context


class ChatRequestError(Exception):
    def __init__(
        self,
        *,
        request_id: str,
        trace_id: str | None,
        session_id: str | None,
        code: str,
        message: str,
        rpc_code: int,
        retryable: bool,
        data: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.request_id = request_id
        self.trace_id = trace_id
        self.session_id = session_id
        self.code = code
        self.message = message
        self.rpc_code = rpc_code
        self.retryable = retryable
        self.data = data


def merge_error_data(target: dict[str, Any], data: dict[str, Any] | None) -> None:
    """Merge ChatRequestError.data into a payload dict, skipping existing keys and None values."""
    if not data:
        return
    for key, value in data.items():
        if key in target or value is None:
            continue
        target[key] = value


@dataclass
class TerminalChatStateError(Exception):
    status: str
    message: str
    terminal_subcode: str | None = None

    def __str__(self) -> str:
        return self.message


TOKEN_PIECE_RE = re.compile(r"'s|'t|'re|'ve|'m|'ll|'d|[A-Za-z]{1,12}|[0-9]{1,4}|[^\s\w]+|\s+")
