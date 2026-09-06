"""Typed internal events emitted by the tool loop.

The routing layer emits domain events; the runtime/chat layer serializes
them for JSON-RPC, headless NDJSON, or tests.  No transport-shaped dicts
belong in this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class LoopEvent:
    """Base class for typed loop events."""


@dataclass
class IterationStartEvent(LoopEvent):
    """Emitted *before* each model call so the UI shows progress immediately."""

    iteration: int
    max_iterations: int


@dataclass
class ThinkingEvent(LoopEvent):
    """Model extended-thinking delta."""

    thinking_id: str
    delta: str
    # Required: the protocol permits only CHAT_THINKING_KIND_REASONING /
    # CHAT_THINKING_KIND_STATUS — the old "thinking" default was an illegal
    # value no serializer validated and no caller relied on.
    kind: str
    persist: bool = False
    # Sidecar-resolved thinking budget for the generation, in characters.
    # Rides reasoning chat.thinking notifications so Electron can scale its
    # persisted-reasoning cap; None/non-positive is omitted from the wire.
    thinking_budget_chars: int | None = None


@dataclass
class PhaseStartedEvent(LoopEvent):
    """Semantic phase start within a streamed turn."""

    phase_id: str
    phase_kind: str
    iteration: int
    thinking_id: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    summary: str | None = None


@dataclass
class PhaseCompletedEvent(LoopEvent):
    """Semantic phase completion within a streamed turn."""

    phase_id: str
    phase_kind: str
    iteration: int
    thinking_id: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    summary: str | None = None


@dataclass
class ApprovalRequestedEvent(LoopEvent):
    """Tool approval request became the active turn blocker."""

    call_id: str
    tool_name: str | None = None
    summary: str | None = None
    approval_plan_hash: str | None = None


@dataclass
class ApprovalResolvedEvent(LoopEvent):
    """Tool approval request resolved, timed out, or was cancelled."""

    call_id: str
    approved: bool
    status: str
    tool_name: str | None = None
    approval_plan_hash: str | None = None


@dataclass
class ToolExecutingEvent(LoopEvent):
    """Emitted just before a tool is executed."""

    call_id: str
    tool_name: str
    arguments: dict[str, Any]


@dataclass
class ToolOutputChunkEvent(LoopEvent):
    """Live stdout/stderr batch from an in-flight tool call.

    EPHEMERAL: forwarded to the renderer as a live tail only — never
    journaled, never part of the canonical turn record. ``lines`` entries are
    ``{"stream": "stdout"|"stderr", "text": str}``; text was sanitized and
    bounded at the source (ToolOutputStreamer in the builtin server).
    """

    call_id: str
    tool_name: str
    sequence: int
    lines: tuple[dict[str, str], ...]
    # Snapshot of the current unterminated line (prompts, \r progress bars) —
    # rendered as a replaceable "current line", not appended scrollback.
    partial: str = ""
    emitted_lines: int = 0
    dropped_lines: int = 0
    elapsed_ms: int = 0


@dataclass
class ToolResultEvent(LoopEvent):
    """Emitted after a tool finishes execution."""

    call_id: str
    tool_name: str
    success: bool
    content: str
    tool_input: dict[str, Any]
    content_type: str = "text"
    ui_payload: dict[str, Any] | None = None
    generated_artifacts: tuple[dict[str, Any], ...] = ()
    error_code: str | None = None
    metadata: dict[str, Any] | None = None
    duration_ms: float | None = None
    # Admitted typed attachments. Live notifications carry the full
    # payloads; canonical turn events persist only safe refs (no bytes).
    trusted_attachments: tuple[dict[str, Any], ...] = ()


@dataclass
class TokenDeltaEvent(LoopEvent):
    """A text chunk from the engine during streaming generation."""

    delta: str
    token_index: int


@dataclass
class StreamResetEvent(LoopEvent):
    """Emitted when a retry/restart discards accumulated streamed text.

    Signals the renderer to clear any text streamed so far for this request
    so the retried iteration's output appears as a clean response.

    This is a *physical transport* event ("flush the buffer on retry").  It is
    intentionally distinct from the semantic phase-boundary events
    ``PhaseStartedEvent`` / ``PhaseCompletedEvent``, which signal reasoning vs.
    tool-use vs. text transitions.  Do not repurpose ``StreamResetEvent`` for
    phase signalling — the renderer reacts to each independently and the
    semantics must not be conflated.

    ``reason`` discriminates *why* the buffer is being reset so the Electron
    canonical-capture path can tell a benign ``"tool_continuation"`` reset (the
    model streamed visible preamble before a real tool call and the loop is
    continuing — already-persisted commentary/reasoning may be PRESERVED) from a
    garbage reset (``"provider_retry"`` / ``"nudge_retry"`` /
    ``"reflexive_retry"`` / ``"post_tool_restart"`` /
    ``"deterministic_replacement"`` — the discarded
    text is bad and must not survive). An empty/unknown reason is treated as
    discard.
    """

    reason: str = ""


@dataclass
class HeartbeatEvent(LoopEvent):
    """Emitted periodically during non-streaming engine calls to prove liveness."""

    elapsed_seconds: float


@dataclass
class FallbackTriggeredEvent(LoopEvent):
    """Emitted when the engine falls back to a different model."""

    original_model: str
    fallback_model: str
    reason: str


@dataclass
class StopEvent(LoopEvent):
    """Emitted when the loop stops for a policy reason.

    ``subcode`` carries an optional refinement of ``code`` for use by the
    backend's terminal-status mapping. Currently used by the semantic
    stuck-loop guardrail to flag aborts as ``"guardrail_aborted"`` so the
    rendered message can append a "stopped early" footer.
    """

    reason: str
    code: str  # CMP-LOOP-NNNN
    user_hint: str = ""
    subcode: str | None = None


@dataclass
class ContextCompactedEvent(LoopEvent):
    """Emitted when context compaction runs before a model call.

    Signals the renderer to display a neutral inline status indicator so the
    user knows the session history was compressed to fit the context window.
    """

    strategy: str  # "micro" | "full" | "narrowed" | "none"
    tokens_before: int
    tokens_after: int
    phase: str = "preflight"
    summary_status: str = "not_created"
    reason_code: str | None = None
    input_complete: bool = True
    dropped_messages: int = 0
    dropped_bytes: int = 0
    # Electron-only persistence input. Serialization intentionally excludes it
    # from canonical turn events and renderer forwarding.
    summary_message: dict[str, Any] | None = None
    # Electron-only, like summary_message.
    covered_through_tool_call_id: str | None = None


@dataclass
class ContextUsageEvent(LoopEvent):
    """Mid-turn "how full is the context window" snapshot for the composer ring.

    EPHEMERAL: forwarded to the renderer as a live meter reading only — never
    journaled, never part of the canonical turn record (``_turn_event_parts``
    must keep returning ``None`` for it). ``chat.done``'s usage block remains
    the terminal truth; these snapshots only keep the ring honest during a long
    agentic turn, when the terminal number is still a whole turn away.

    ``context_used_tokens`` is the same ``max(provider truth, sidecar
    estimate)`` figure ``attach_context_used_tokens`` publishes at terminal, so
    mid-turn and terminal readings are computed the same way. There is NO
    cross-iteration high-water mark: compaction legitimately lowers the number.
    """

    phase: str  # "preflight" | "iteration"
    iteration: int
    context_used_tokens: int
    context_used_source: str  # "provider" | "estimate"
    context_tokens_estimate: int
    last_request_input_tokens: int
    context_window: int
    compact_threshold_tokens: int
    model: str
    provider: str


@dataclass
class ToolCallDeltaEvent(LoopEvent):
    """Mid-stream argument fragment for a tool call (Phase 4).

    Emitted by the routing layer when an engine surfaces an incremental
    argument fragment via the provider stream normalizer. Provides
    granularity for diagnostics and UI progress; the actionable
    "ready-to-dispatch" event is :class:`ToolCallCompletedEvent`.
    """

    call_id: str
    tool_name: str | None
    arguments_delta: str
    sequence: int


@dataclass
class ToolCallCompletedEvent(LoopEvent):
    """A fully-parsed tool call ready to dispatch (Phase 4).

    Carries the parsed ``arguments`` dict. The routing layer downstream of
    this event is responsible for applying capability-gated dispatch (Phase
    5) and audit recording (Phase 6).
    """

    call_id: str
    tool_name: str
    arguments: dict[str, Any]
    sequence: int
