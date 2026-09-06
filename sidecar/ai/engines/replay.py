# ruff: noqa: PLC0415, PLR0913
"""Deterministic replay engine for agentic GUI testing.

Streams a scripted sequence of reasoning deltas, text deltas, and tool calls
with configurable inter-event delays so automated GUI drivers (Playwright,
CDP agents, CI) can exercise the real Electron + renderer streaming pipeline
end-to-end without model inference. The tool calls it emits run through the
real sidecar tool loop, so ``tool.executing`` / ``tool.result`` notifications
and approval gating behave exactly as they do with a live model.

Engine type: ``replay``. The script is selected via
``RuntimeConfig.replay_script_path`` (JSON, see ``DEFAULT_SCRIPT`` for the
shape) and falls back to a built-in scenario that streams reasoning, calls
``mermaid_generate`` when that tool is offered, and follows up after the tool
result. Which script entry plays is derived statelessly from the message
history (count of user/tool messages), so replays stay deterministic across
multi-turn sessions and tool-loop continuations without request-local state
leaking across turns.
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Generator, List, Optional

from sidecar.ai.tools.plan_artifact_policy import strip_plan_artifact_write_arg

from .base import BaseEngine, EngineMessage

if TYPE_CHECKING:
    from ..tools.models import GenerationResult
    from .response_format import ResponseFormat

logger = logging.getLogger(__name__)

DEFAULT_REPLAY_DELAY_MS = 40.0
_MAX_REPLAY_DELAY_MS = 10_000.0
_REASONING_CHUNK_CHARS = 24

_DEFAULT_MERMAID_SOURCE = (
    "flowchart TD\n"
    "  A[Agent sends prompt] --> B[Replay engine streams]\n"
    "  B --> C{Tool loop}\n"
    "  C -->|mermaid_generate| D[Inline chart]\n"
    "  D --> E[Timeline settles]"
)

DEFAULT_SCRIPT: Dict[str, Any] = {
    "version": 1,
    "calls": [
        {
            "reasoning": (
                "Planning this turn: stream a short reply first, call the "
                "mermaid tool to exercise the combined tool card, then "
                "summarize once the result lands."
            ),
            "text": "Sure - let me sketch that flow as a quick chart.",
            "tool_calls": [
                {
                    "tool_id": "mermaid_generate",
                    "arguments": {
                        "prompt": _DEFAULT_MERMAID_SOURCE,
                        "diagram_type": "flowchart",
                        "title": "Replay smoke flow",
                    },
                }
            ],
        },
        {
            "text": (
                "Here's the chart. This deterministic replay turn exercised "
                "streaming deltas, the tool loop, and the settled timeline "
                "without any model inference."
            ),
        },
    ],
}


def _iter_text_chunks(text: str) -> Generator[str, None, None]:
    """Yield chunks that reassemble byte-for-byte and preserve raw whitespace/newlines."""
    for chunk in re.split(r"(\s+)", text):
        if chunk:
            yield chunk


def _normalize_script(candidate: Any) -> Dict[str, Any] | None:
    if not isinstance(candidate, dict):
        return None
    calls = candidate.get("calls")
    if not isinstance(calls, list) or not calls:
        return None
    if not all(isinstance(call, dict) for call in calls):
        return None
    return candidate


class ReplayEngine(BaseEngine):
    """Scripted engine that replays a fixture event sequence with delays."""

    def __init__(
        self,
        script_path: str | None = None,
        delay_ms: float | None = None,
    ) -> None:
        self.model_name: str | None = None
        self._script = self._load_script(script_path)
        resolved_delay = delay_ms
        if resolved_delay is None:
            script_delay = self._script.get("delay_ms")
            if isinstance(script_delay, (int, float)):
                resolved_delay = float(script_delay)
        if resolved_delay is None:
            resolved_delay = DEFAULT_REPLAY_DELAY_MS
        self._delay_seconds = (
            min(max(float(resolved_delay), 0.0), _MAX_REPLAY_DELAY_MS) / 1000.0
        )

    @staticmethod
    def _load_script(script_path: str | None) -> Dict[str, Any]:
        token = str(script_path or "").strip()
        if not token:
            return DEFAULT_SCRIPT
        try:
            payload = json.loads(Path(token).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.warning(
                "ReplayEngine: failed to read replay script; using the built-in "
                "default scenario (error_type=%s)",
                type(exc).__name__,
            )
            return DEFAULT_SCRIPT
        script = _normalize_script(payload)
        if script is None:
            logger.warning(
                "ReplayEngine: replay script is malformed (expected an object "
                "with a non-empty 'calls' list); using the built-in default"
            )
            return DEFAULT_SCRIPT
        return script

    @property
    def supports_tool_calling(self) -> bool:
        return True

    def get_model_context_length(self) -> int:
        # A real, deterministic context window: without one the token-budget
        # layer cannot size the conversation and fails the very first turn
        # with "Conversation too long to continue".
        return 32_768

    def get_model_max_output_tokens(self) -> int:
        return 4_096

    def load_model(self, model_path: str) -> None:
        self.model_name = str(model_path or "replay-default").strip() or "replay-default"
        logger.info("ReplayEngine: ready (model=%s)", self.model_name)

    def unload_model(self, _name: str | None = None) -> None:
        self.model_name = None

    # ------------------------------------------------------------------
    # Script resolution
    # ------------------------------------------------------------------

    @staticmethod
    def _call_index(messages: Optional[List[EngineMessage]], call_count: int) -> int:
        """Derive which script call plays purely from the message history.

        Each user message and each tool-result message advances the script by
        one model call, which mirrors how the chat loop actually re-invokes
        the engine. Statelessness keeps replays deterministic and honors the
        no-request-state-across-turns sidecar contract.
        """
        if call_count <= 0:
            return 0
        if not messages:
            return 0
        relevant = sum(
            1
            for message in messages
            if str(message.get("role", "")).strip().lower() in ("user", "tool")
        )
        return max(relevant - 1, 0) % call_count

    def _resolve_call(self, messages: Optional[List[EngineMessage]]) -> Dict[str, Any]:
        calls = self._script["calls"]
        call = calls[self._call_index(messages, len(calls))]
        if len(calls) == 1 and self._last_role(messages) == "tool" and call.get("tool_calls"):
            # A single-call script with a tool call would re-issue the tool
            # forever on the post-result invocation; strip it so the loop
            # terminates with the scripted text instead.
            return {key: value for key, value in call.items() if key != "tool_calls"}
        return call

    @staticmethod
    def _last_role(messages: Optional[List[EngineMessage]]) -> str:
        if not messages:
            return ""
        return str(messages[-1].get("role", "")).strip().lower()

    @staticmethod
    def _offered_tool_ids(tools: Optional[List[Dict[str, Any]]]) -> set[str]:
        offered: set[str] = set()
        for tool in tools or []:
            if not isinstance(tool, dict):
                continue
            name = tool.get("name") or tool.get("tool_id")
            if not name and isinstance(tool.get("function"), dict):
                name = tool["function"].get("name")
            token = str(name or "").strip()
            if token:
                offered.add(token)
        return offered

    def _scripted_tool_requests(
        self,
        call: Dict[str, Any],
        tools: Optional[List[Dict[str, Any]]],
        call_index: int,
    ) -> tuple:
        from ..tools.models import ToolCallRequest, ensure_tool_call_id

        offered = self._offered_tool_ids(tools)
        requests = []
        for position, entry in enumerate(call.get("tool_calls") or []):
            if not isinstance(entry, dict):
                continue
            tool_id = str(entry.get("tool_id") or entry.get("name") or "").strip()
            if not tool_id or tool_id not in offered:
                continue
            arguments = entry.get("arguments")
            requests.append(
                ToolCallRequest(
                    tool_id=tool_id,
                    arguments=strip_plan_artifact_write_arg(arguments),
                    call_id=ensure_tool_call_id(
                        "",
                        provider="replay",
                        tool_name=tool_id,
                        request_id=f"replay-call-{call_index}",
                        position=position,
                    ),
                )
            )
        return tuple(requests)

    # ------------------------------------------------------------------
    # Streaming
    # ------------------------------------------------------------------

    def _pause(
        self,
        cancel_handle: Any = None,
        wall_clock_deadline: float | None = None,
    ) -> None:
        delay_seconds = self._delay_seconds
        if wall_clock_deadline is not None:
            delay_seconds = min(
                delay_seconds,
                max(0.0, float(wall_clock_deadline) - time.monotonic()),
            )
        if delay_seconds <= 0:
            return
        wait = getattr(cancel_handle, "wait", None)
        if callable(wait):
            # Returns early when cancelled; the runtime's raise_if_cancelled
            # tears the stream down on the next chunk boundary.
            wait(delay_seconds)
            return
        time.sleep(delay_seconds)

    def _build_result(
        self,
        call: Dict[str, Any],
        tool_requests: tuple,
    ) -> "GenerationResult":
        from ..tools.models import GenerationResult, GenerationUsage

        text = str(call.get("text") or "")
        reasoning = str(call.get("reasoning") or "")
        output_tokens = max(len(text.split()) + len(reasoning.split()), 1)
        return GenerationResult(
            content=text,
            tool_calls=tool_requests,
            finish_reason="tool_calls" if tool_requests else "stop",
            usage=GenerationUsage(
                input_tokens=32,
                output_tokens=output_tokens,
                total_tokens=32 + output_tokens,
                provider="replay",
                model=str(self.model_name or "replay-default"),
                last_request_input_tokens=32,
            ),
            thinking_text=reasoning,
        )

    def stream_with_tools(
        self,
        prompt: str,
        tools: List[Dict[str, Any]],
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
        cancel_handle: Any = None,
        wall_clock_deadline: float | None = None,
    ) -> Generator[Any, None, "GenerationResult"]:
        from ..tools.models import ThinkingDelta

        _ = (prompt, max_tokens, temperature, reasoning_effort, prompt_cache_enabled, system)
        call_index = self._call_index(messages, len(self._script["calls"]))
        call = self._resolve_call(messages)
        reasoning = str(call.get("reasoning") or "")
        text = str(call.get("text") or "")
        tool_requests = self._scripted_tool_requests(call, tools, call_index)
        # Deterministic-test engine: always record what was offered vs what
        # the script wanted, so a skipped scripted tool call is diagnosable
        # from the sidecar log alone.
        logger.info(
            "ReplayEngine: call_index=%s offered_tools=%s scripted_tool_calls=%s emitted=%s",
            call_index,
            sorted(self._offered_tool_ids(tools)),
            [
                str(entry.get("tool_id") or entry.get("name") or "")
                for entry in call.get("tool_calls") or []
            ],
            [request.tool_id for request in tool_requests],
        )

        if response_format is not None and getattr(response_format, "is_json", False):
            yield json.dumps({"response": text})
            return self._build_result({"text": json.dumps({"response": text})}, ())

        for start in range(0, len(reasoning), _REASONING_CHUNK_CHARS):
            yield ThinkingDelta(text=reasoning[start:start + _REASONING_CHUNK_CHARS])
            self._pause(cancel_handle, wall_clock_deadline)
        if reasoning:
            yield ThinkingDelta(text="", is_complete=True)
        for chunk in _iter_text_chunks(text):
            yield chunk
            if not chunk.isspace():
                self._pause(cancel_handle, wall_clock_deadline)
        return self._build_result(call, tool_requests)

    def stream(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
        cancel_handle: Any = None,
    ) -> Generator[str, None, None]:
        call = self._resolve_call(messages)
        text = str(call.get("text") or "")
        logger.info(
            "ReplayEngine: stream() invoked (json=%s)",
            bool(response_format is not None and getattr(response_format, "is_json", False)),
        )
        if response_format is not None and getattr(response_format, "is_json", False):
            yield json.dumps({"response": text})
            return
        for chunk in _iter_text_chunks(text):
            yield chunk
            if not chunk.isspace():
                self._pause(cancel_handle)

    # ------------------------------------------------------------------
    # Non-streaming
    # ------------------------------------------------------------------

    def generate(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
    ) -> str:
        _ = (prompt, max_tokens, temperature, reasoning_effort, prompt_cache_enabled, system)
        call = self._resolve_call(messages)
        text = str(call.get("text") or "")
        json_mode = bool(response_format is not None and getattr(response_format, "is_json", False))
        logger.info(
            "ReplayEngine: generate() invoked (json=%s, system_head=%r)",
            json_mode,
            str(system or (messages or [{}])[0].get("content", ""))[:120],
        )
        if json_mode:
            return json.dumps({"response": text})
        return text

    def generate_with_tools(
        self,
        prompt: str,
        tools: List[Dict[str, Any]],
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Optional[List[EngineMessage]] = None,
        response_format: Optional["ResponseFormat"] = None,
    ) -> "GenerationResult":
        _ = (prompt, max_tokens, temperature, reasoning_effort, prompt_cache_enabled, system)
        call_index = self._call_index(messages, len(self._script["calls"]))
        call = self._resolve_call(messages)
        if response_format is not None and getattr(response_format, "is_json", False):
            text = json.dumps({"response": str(call.get("text") or "")})
            return self._build_result({"text": text}, ())
        return self._build_result(call, self._scripted_tool_requests(call, tools, call_index))
