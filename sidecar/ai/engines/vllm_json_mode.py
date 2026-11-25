"""JSON-mode resilience for the vLLM-family engines (row 200).

A server that prompts for JSON and validates afterwards (Strata) answers a miss with an
HTTP 502 or an in-band ``structured_output_failed`` error frame. One miss retries the
request once as plain text; three in a row turn JSON mode off for the server. A server
that rejects ``response_format`` outright (NInfer's 400) turns it off at once.
``_VLLMGenerationMixin`` inherits ``_JsonModeMixin``; the streaming methods wear
``_retry_json_mode_once``.
"""

from __future__ import annotations

import functools
import inspect
from collections.abc import Callable, Generator
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypeVar, cast

from sidecar.ai.engines.engine_events import (
    ENGINE_EVENT_INFERENCE_PERFORMANCE,
    ENGINE_EVENT_PREFILL,
    EngineEvent,
)
from sidecar.ai.engines.vllm_engine_completion import _is_response_format_rejection
from sidecar.ai.engines.vllm_tool_stream import _raise_if_cancelled
from sidecar.ai.tools.models import StreamingEvent

_HTTP_BAD_GATEWAY = 502
_STRUCTURED_OUTPUT_FAILED = "structured_output_failed"
# Consecutive JSON-mode requests that failed server-side validation before JSON mode is
# turned off for the server (a lone miss is a per-request failure, not a capability answer).
_JSON_MODE_FAILURE_LIMIT = 3


def _is_structured_output_failure(error: object) -> bool:
    """True for a server's structured-output validation failure on one JSON-mode request.

    A server that prompts for JSON and validates afterwards answers a miss with an HTTP 502
    (an exception here) or, on a stream, an in-band error frame or its text. Both name
    ``structured_output_failed``; nothing else qualifies, and untrusted input never raises.
    """
    try:
        if isinstance(error, BaseException):
            if getattr(error, "status_code", None) != _HTTP_BAD_GATEWAY:
                return False
            text = f"{getattr(error, 'body', '')} {error}"
        else:
            text = str(error)
        return _STRUCTURED_OUTPUT_FAILED in text
    except Exception:  # noqa: BLE001 - a hostile body or frame is simply not a match.
        return False


@dataclass
class _JsonModeProbe:
    """What one streaming attempt says about JSON mode (request-local, never shared)."""

    frame_failed: bool = False  # an in-band error frame named the validation failure
    inband_error: str = ""  # the attempt's terminal in-band error text, as the tool path keeps it

    @property
    def failed(self) -> bool:
        return self.frame_failed or _is_structured_output_failure(self.inband_error)

    def note_frame(self, chunk: dict[str, Any]) -> None:
        """Recognise an in-band error frame (bare or ``object: "error"``) without consuming it."""
        if chunk.get("choices"):
            return
        error = chunk.get("error")
        if not error and str(chunk.get("object") or "") == "error":
            error = chunk.get("message")
        if error and _is_structured_output_failure(error):
            self.frame_failed = True


def _is_visible_output(item: Any) -> bool:
    """True when ``item`` already showed the consumer content, reasoning or a tool call."""
    if isinstance(item, EngineEvent):
        return item.kind not in {ENGINE_EVENT_PREFILL, ENGINE_EVENT_INFERENCE_PERFORMANCE}
    if isinstance(item, StreamingEvent):
        return item.kind != "done"
    return True


_AttemptT = TypeVar("_AttemptT", bound=Callable[..., Generator[Any, None, Any]])


def _retry_json_mode_once(attempt: _AttemptT) -> _AttemptT:
    """Rerun a streaming request once without ``response_format`` after a JSON-mode miss.

    A server that validates JSON after the fact ends a failed JSON-mode stream on an in-band
    structured-output error. When that attempt showed the consumer nothing, its terminal
    ``done`` is held back and the same request runs again as plain text. ``attempt`` takes a
    trailing ``_probe`` keyword that this wrapper supplies; callers never pass it.
    """
    signature = inspect.signature(attempt)

    @functools.wraps(attempt)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Generator[Any, None, Any]:
        bound = signature.bind(self, *args, **kwargs)
        carried = self._json_mode_requested(bound.arguments.get("response_format"))
        probe = bound.arguments["_probe"] = _JsonModeProbe()
        first = attempt(*bound.args, **bound.kwargs)
        held: Any = None
        shown = False
        try:
            while True:
                try:
                    item = next(first)
                except StopIteration as stop:
                    result = stop.value
                    break
                if isinstance(item, StreamingEvent) and item.kind == "done":
                    held = item
                else:
                    shown = shown or _is_visible_output(item)
                    yield item
        finally:
            first.close()
        self._note_json_mode_outcome(carried=carried, failed=probe.failed)
        shown = shown or bool(getattr(result, "content", "") or getattr(result, "tool_calls", ()))
        if carried and probe.failed and not shown:
            _raise_if_cancelled(bound.arguments.get("cancel_handle"))
            bound.arguments.update(response_format=None, _probe=_JsonModeProbe())
            return (yield from attempt(*bound.args, **bound.kwargs))
        if held is not None:
            yield held
        return result

    return cast(_AttemptT, wrapper)


class _JsonModeMixin:
    """The non-streaming retry and the consecutive-failure latch (per engine)."""

    # Consecutive JSON-mode requests that ended on a structured-output failure.
    _json_mode_failures: int = 0

    if TYPE_CHECKING:
        # Provided by the host engine (``_VLLMCompletionMixin``); stubs for mypy only.
        def _post_completion(self, payload: dict[str, Any], *, cancel_handle: Any) -> Any: ...

        def _disable_json_response_format(self) -> None: ...

    def _post_completion_json_mode_aware(
        self, payload: dict[str, Any], *, cancel_handle: Any
    ) -> Any:
        """Post once; retry once without ``response_format`` when the server declined it.

        A 400 capability answer turns JSON mode off for the server at once. A structured-output
        validation failure (502) is only counted toward the consecutive-failure latch.
        """
        carried = "response_format" in payload
        try:
            body = self._post_completion(payload, cancel_handle=cancel_handle)
        except Exception as error:  # noqa: BLE001 - narrowed below
            if not carried:
                raise
            if _is_response_format_rejection(error):
                self._disable_json_response_format()
            elif _is_structured_output_failure(error):
                self._note_json_mode_outcome(carried=True, failed=True)
            else:
                raise
            payload.pop("response_format", None)
            return self._post_completion(payload, cancel_handle=cancel_handle)
        self._note_json_mode_outcome(carried=carried, failed=False)
        return body

    def _note_json_mode_outcome(self, *, carried: bool, failed: bool) -> None:
        """Count consecutive structured-output failures; the third turns JSON mode off.

        A request that carried ``response_format`` and finished without the failure resets
        the count; a request without it leaves the count alone.
        """
        if not carried:
            return
        if not failed:
            self._json_mode_failures = 0
            return
        self._json_mode_failures += 1
        if self._json_mode_failures >= _JSON_MODE_FAILURE_LIMIT:
            self._disable_json_response_format()
