"""Core data types and constants for chat runtime."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from sidecar.ai.memory.contracts import MemoryPolicy

if TYPE_CHECKING:
    from sidecar.ai.engines.vision_input import VisionImage

DISABLED_MEMORY_POLICY = MemoryPolicy(enabled=False, include_response_style=False)


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
    memory_policy: MemoryPolicy | None = None
    reasoning_effort: str | None = None
    session_start_date: str | None = None
    current_date: str | None = None
    plan_mode: bool = False
    # Request-local safety boundary. Plan Mode is the user-facing preference;
    # sub-agents are also read-only without pretending to be in Plan Mode.
    read_only: bool = False
    plan_decision: str = ""
    plan_feedback: str = ""
    edited_plan: dict[str, Any] | None = None
    approved_plan: dict[str, Any] | None = None
    tool_preferences: dict[str, tuple[str, ...]] | None = None
    approval_mode: str = "prompt"
    session_offline_lockdown: bool = False
    sub_agent_tool_preferences_fail_closed: bool = False
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
