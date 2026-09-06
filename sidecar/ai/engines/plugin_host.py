"""Fixed-protocol proxy for a generation-bound privileged plugin engine."""

from __future__ import annotations

import uuid
from collections.abc import Callable, Generator, Iterable
from contextvars import ContextVar
from typing import Any, Literal

from sidecar.ai.engines.base import BaseEngine, EngineMessage
from sidecar.ai.engines.http_utils import raise_if_cancelled, register_cancel_callback
from sidecar.ai.engines.plugin_host_stream import plugin_host_failure, validate_frame
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.tools.models import (
    GenerationResult,
    StreamChunk,
    ThinkingDelta,
    ToolCallRequest,
)

HostInvoke = Callable[[dict[str, Any]], Iterable[dict[str, Any]]]
_BOUND_INVOKE: ContextVar[HostInvoke | None] = ContextVar("plugin_host_invoke", default=None)


class _PluginHostTransportBinding:
    def __init__(self, invoke: HostInvoke) -> None:
        self._invoke = invoke
        self._token: Any = None

    def __enter__(self) -> None:
        self._token = _BOUND_INVOKE.set(self._invoke)

    def __exit__(
        self, _exc_type: object, _exc: object, _traceback: object
    ) -> Literal[False]:
        if self._token is not None:
            _BOUND_INVOKE.reset(self._token)
            self._token = None
        return False


def bind_plugin_host_transport(invoke: HostInvoke) -> _PluginHostTransportBinding:
    return _PluginHostTransportBinding(invoke)


class PluginHostEngine(BaseEngine):
    """Request-local stream adapter; privileged bytes never load in Python."""

    def __init__(
        self,
        binding: dict[str, Any] | None,
        invoke: HostInvoke | None,
        authority_check: Callable[[], bool] | None = None,
    ) -> None:
        self._binding = dict(binding or {})
        self._invoke = invoke
        self._authority_check = authority_check or (lambda: False)
        self.model_name = ""

    @property
    def supports_tool_calling(self) -> bool:
        return True

    def load_model(self, model_path: str) -> None:
        self.model_name = str(model_path or self._binding.get("adapter_id") or "plugin-host")

    def _frames(
        self, payload: dict[str, Any], cancel_handle: Any = None
    ) -> Iterable[dict[str, Any]]:
        invoke = self._invoke or _BOUND_INVOKE.get()
        if not self._binding or invoke is None or not self._authority_check():
            raise plugin_host_failure("Plugin engine authority is unavailable.")
        stream_id = uuid.uuid4().hex
        operation = "start"
        sequence = 0
        terminal = False
        cancel_request = {
            "operation": "cancel",
            "requestId": stream_id,
            "binding": self._binding,
            "authority": self._binding.get("authority"),
        }

        def cancel_host() -> None:
            try:
                tuple(invoke(cancel_request))
            except Exception:  # noqa: BLE001 - cancellation remains fail-closed.
                pass

        unregister_cancel = register_cancel_callback(cancel_handle, cancel_host)
        try:
            while not terminal:
                raise_if_cancelled(
                    cancel_handle,
                    make_error=lambda: plugin_host_failure("Plugin engine cancelled."),
                )
                request = {
                    "operation": operation,
                    "requestId": stream_id,
                    "binding": self._binding,
                    "authority": self._binding.get("authority"),
                }
                request["input" if operation == "start" else "sequence"] = (
                    payload if operation == "start" else sequence - 1
                )
                batch = tuple(invoke(request))
                raise_if_cancelled(
                    cancel_handle,
                    make_error=lambda: plugin_host_failure("Plugin engine cancelled."),
                )
                if not batch:
                    raise plugin_host_failure("Plugin engine returned no frames.")
                for raw_frame in batch:
                    try:
                        frame = validate_frame(raw_frame, sequence)
                    except ValueError as error:
                        raise plugin_host_failure("Plugin engine frame was rejected.") from error
                    sequence += 1
                    terminal = frame["kind"] in {"done", "error"}
                    yield frame
                operation = "stream_ack"
        finally:
            unregister_cancel()
            try:
                tuple(invoke({
                    "operation": "close",
                    "requestId": stream_id,
                    "binding": self._binding,
                    "authority": self._binding.get("authority"),
                    "payload": {},
                }))
            except Exception:  # noqa: BLE001 - close is best-effort after terminal failure.
                pass

    def _stream_payload(
        self, payload: dict[str, Any], cancel_handle: Any = None
    ) -> Generator[StreamChunk, None, None]:
        for frame in self._frames(payload, cancel_handle):
            kind = frame["kind"]
            if kind == "text":
                yield str(frame.get("text") or "")
            elif kind == "thinking":
                yield ThinkingDelta(text=str(frame.get("text") or ""))
            elif kind == "tool_call":
                yield ToolCallRequest(
                    tool_id=str(frame.get("tool_id") or ""),
                    arguments=dict(frame.get("arguments") or {}),
                    call_id=str(frame.get("call_id") or ""),
                )
            elif kind == "done":
                return
            elif kind == "error":
                raise plugin_host_failure("Plugin engine failed.")
        raise plugin_host_failure("Plugin engine terminal frame was missing.")

    def stream(  # noqa: PLR0913 - BaseEngine transport contract.
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
        cancel_handle: Any = None,
    ) -> Generator[StreamChunk, None, None]:
        _ = (reasoning_effort, prompt_cache_enabled, response_format)
        yield from self._stream_payload({
            "prompt": prompt,
            "messages": messages or [],
            "system": system,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }, cancel_handle)

    def generate(  # noqa: PLR0913 - BaseEngine transport contract.
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
    ) -> str:
        return "".join(item for item in self.stream(
            prompt, max_tokens, temperature, reasoning_effort, prompt_cache_enabled,
            system, messages, response_format,
        ) if isinstance(item, str))

    def generate_with_tools(  # noqa: PLR0913 - BaseEngine transport contract.
        self,
        prompt: str,
        tools: list[dict[str, Any]],
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
    ) -> GenerationResult:
        stream = self.stream_with_tools(
            prompt, tools, max_tokens, temperature, reasoning_effort,
            prompt_cache_enabled, system, messages, response_format,
        )
        try:
            while True:
                next(stream)
        except StopIteration as stopped:
            return stopped.value

    def stream_with_tools(  # noqa: PLR0913 - BaseEngine transport contract.
        self,
        prompt: str,
        tools: list[dict[str, Any]],
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
        cancel_handle: Any = None,
        wall_clock_deadline: float | None = None,
    ) -> Generator[StreamChunk, None, GenerationResult]:
        _ = (reasoning_effort, prompt_cache_enabled, response_format, wall_clock_deadline)
        content: list[str] = []
        calls: list[ToolCallRequest] = []
        thinking: list[str] = []
        for item in self._stream_payload({
            "prompt": prompt,
            "messages": messages or [],
            "system": system,
            "tools": tools,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }, cancel_handle):
            if isinstance(item, str):
                content.append(item)
                yield item
            elif isinstance(item, ThinkingDelta):
                thinking.append(item.text)
                yield item
            elif isinstance(item, ToolCallRequest):
                calls.append(item)
        return GenerationResult(
            content="".join(content),
            tool_calls=tuple(calls),
            thinking_text="".join(thinking),
            finish_reason="tool_calls" if calls else "stop",
        )

    def unload_model(self, _name: str | None = None) -> None:
        self.model_name = ""


__all__ = ["PluginHostEngine", "bind_plugin_host_transport"]
