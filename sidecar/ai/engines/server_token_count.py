"""Server-side exact prompt token counts for OpenAI-compatible local servers.

The context budget asks an engine for the true size of a request before it
trusts a chars/4 guess (row 66, ``context_count.resolve_token_scale``). Two
servers answer cheaply:

* **llama-server**: ``POST /apply-template`` renders the chat template, then
  ``POST /tokenize`` counts the rendered prompt. Both live at the server root,
  not under ``/v1``.
* **NInfer** (0.9.1): ``POST /v1/responses/input_tokens`` takes the request as
  Responses input items. The shape is unverified until the owner's W0 probe.

NInfer also serves a llama-server style ``/props``, so a successful props probe
does not prove llama-server: the llama route is tried first when props
answered, and falls through to the NInfer route when it is missing.

Every helper fails open: any transport error, non-200, malformed body or
non-positive count is ``None``. ``ServerTokenCounter`` remembers a route the
server does not have (404/405/501, or a reply it cannot read) until the next
load, so such a server costs one round trip per load; a timeout or server error
only rests the route for ``_TRANSIENT_COOLDOWN_SECONDS``. Server replies are
untrusted: only an integer count is read, and no message content reaches a log
line or an exception.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from typing import Any

from sidecar.ai.context.context_rows import CONTEXT_ROLE, render_context_entries
from sidecar.ai.engines.local_server_props import props_base_url
from sidecar.runtime.local_engine.messages import demote_non_leading_system_messages
from sidecar.runtime.vllm_engine_support import _build_messages, _build_tools_payload

logger = logging.getLogger(__name__)

SERVER_KIND_LLAMA = "llama-server"
SERVER_KIND_NINFER = "ninfer"
_COUNT_TIMEOUT_SECONDS = 2.0
_HTTP_OK = 200
_INSTRUCTION_JOINER = "\n\n"
_IMAGE_PART_TYPES = frozenset({"image_url", "input_image", "image"})
# Statuses that mean the server has no such route (as opposed to a passing failure).
_ROUTE_MISSING_STATUSES = frozenset({404, 405, 501})
_TRANSIENT_COOLDOWN_SECONDS = 60.0

# Called with True when the route is missing, False for a passing failure.
FailureSink = Callable[[bool], None] | None


def _countable_rows(messages: list[Any]) -> list[Any]:
    """Router rows as the real request renders them: ``context`` rows (linked
    chats, handoffs) become their user entries and non-leading system rows are
    demoted, the way ``routing.engine_messages`` prepares a generation."""
    rows: list[Any] = []
    for message in demote_non_leading_system_messages(list(messages)):
        role = str(message.get("role", "")).strip().lower() if isinstance(message, dict) else ""
        if role == CONTEXT_ROLE:
            rows.extend(render_context_entries(message))
        else:
            rows.append(message)
    return rows


def build_count_payload(
    *, model: str | None, messages: list[Any], tools: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """The chat-completions body the engine would send, minus generation fields.

    Reuses the engine's own message and tool conversion, so the server counts
    exactly the prompt a real request would carry. ``None`` for no messages.
    """
    if not messages:
        return None
    payload: dict[str, Any] = {
        "model": model,
        "messages": _build_messages(prompt="", system="", messages=_countable_rows(messages)),
    }
    tool_defs = _build_tools_payload(tools)
    if tool_defs:
        payload["tools"] = tool_defs
    return payload


def payload_has_image(payload: dict[str, Any]) -> bool:
    """True when any message carries an image part (the ladder budgets those)."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return False
    return any(
        isinstance(block, dict) and block.get("type") in _IMAGE_PART_TYPES
        for message in messages
        if isinstance(message, dict) and isinstance(message.get("content"), list)
        for block in message["content"]
    )


def _positive_count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _fail(on_failure: FailureSink, *, missing: bool) -> None:
    if on_failure is not None:
        on_failure(missing)


def _post_json(
    client: Any, url: str, body: dict[str, Any], on_failure: FailureSink = None
) -> dict[str, Any] | None:
    """One bounded POST; a JSON object body on 200, else ``None``. Never raises."""
    try:
        response = client.post(url, json=body, timeout=_COUNT_TIMEOUT_SECONDS)
    except Exception:  # noqa: BLE001 - a count is best-effort and must never fail a turn.
        _fail(on_failure, missing=False)
        return None
    if response.status_code != _HTTP_OK:
        _fail(on_failure, missing=response.status_code in _ROUTE_MISSING_STATUSES)
        return None
    try:
        parsed = json.loads(response.content)
    except Exception:  # noqa: BLE001 - an unreadable reply is a route we cannot use.
        parsed = None
    if not isinstance(parsed, dict):
        _fail(on_failure, missing=True)
        return None
    return parsed


def count_llama_server(
    client: Any, base_url: str, payload: dict[str, Any], on_failure: FailureSink = None
) -> int | None:
    """``/apply-template`` then ``/tokenize`` at the server root."""
    root = props_base_url(base_url)
    body: dict[str, Any] = {"messages": payload.get("messages")}
    if payload.get("tools"):
        body["tools"] = payload["tools"]
    rendered = _post_json(client, f"{root}/apply-template", body, on_failure)
    if rendered is None:
        return None
    prompt = rendered.get("prompt")
    if not isinstance(prompt, str) or not prompt:
        _fail(on_failure, missing=True)
        return None
    tokenized = _post_json(client, f"{root}/tokenize", {"content": prompt}, on_failure)
    if tokenized is None:
        return None
    tokens = tokenized.get("tokens")
    count = _positive_count(len(tokens)) if isinstance(tokens, list) else None
    if count is None:
        _fail(on_failure, missing=True)
    return count


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        part["text"]
        for part in content
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    )


def _message_item(role: str, text: str) -> dict[str, Any]:
    kind = "output_text" if role == "assistant" else "input_text"
    return {"type": "message", "role": role, "content": [{"type": kind, "text": text}]}


def _function_call_items(raw_calls: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for call in raw_calls if isinstance(raw_calls, list) else ():
        function = call.get("function") if isinstance(call, dict) else None
        if not isinstance(function, dict):
            continue
        name, call_id = function.get("name"), call.get("id")
        if not isinstance(name, str) or not name or not isinstance(call_id, str) or not call_id:
            continue
        arguments = function.get("arguments")
        items.append(
            {
                "type": "function_call",
                "name": name,
                "arguments": arguments if isinstance(arguments, str) else "{}",
                "call_id": call_id,
            }
        )
    return items


def chat_messages_to_responses(messages: list[Any]) -> tuple[str, list[dict[str, Any]]]:
    """Map chat-completions messages onto ``(instructions, input items)``.

    The leading system run becomes ``instructions``. A later system row stays in
    place as a user message, and a function call or output without its pair is
    dropped, as the ChatGPT serializer does (``chatgpt_subscription_request``).
    That serializer reads router-shaped rows, so it cannot take wire messages.
    """
    rows = [m for m in messages if isinstance(m, dict)]
    lead = 0
    while lead < len(rows) and rows[lead].get("role") == "system":
        lead += 1
    texts = [_text_of(row.get("content")) for row in rows[:lead]]
    instructions = _INSTRUCTION_JOINER.join(t for t in texts if t.strip())
    items: list[dict[str, Any]] = []
    for row in rows[lead:]:
        role, text = row.get("role"), _text_of(row.get("content"))
        if role in {"system", "user"}:
            if text:
                items.append(_message_item("user", text))
        elif role == "assistant":
            if text:
                items.append(_message_item("assistant", text))
            items.extend(_function_call_items(row.get("tool_calls")))
        elif role == "tool" and isinstance(row.get("tool_call_id"), str) and row["tool_call_id"]:
            items.append(
                {"type": "function_call_output", "call_id": row["tool_call_id"], "output": text}
            )
    calls = {i["call_id"] for i in items if i["type"] == "function_call"}
    outputs = {i["call_id"] for i in items if i["type"] == "function_call_output"}
    paired = calls & outputs
    items = [
        i
        for i in items
        if i["type"] not in {"function_call", "function_call_output"} or i["call_id"] in paired
    ]
    return instructions, items


def _responses_tools(tools: Any) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for tool in tools if isinstance(tools, list) else ():
        function = tool.get("function") if isinstance(tool, dict) else None
        if not isinstance(function, dict) or not isinstance(function.get("name"), str):
            continue
        converted.append(
            {
                "type": "function",
                "name": function["name"],
                "description": function.get("description") or "",
                "strict": False,
                "parameters": function.get("parameters") or {},
            }
        )
    return converted


def count_ninfer(
    client: Any, base_url: str, payload: dict[str, Any], on_failure: FailureSink = None
) -> int | None:
    """``/v1/responses/input_tokens`` with the request as Responses input items."""
    model = payload.get("model")
    messages = payload.get("messages")
    if not isinstance(model, str) or not model or not isinstance(messages, list):
        return None
    instructions, items = chat_messages_to_responses(messages)
    body: dict[str, Any] = {"model": model, "input": items}
    if instructions:
        body["instructions"] = instructions
    tools = _responses_tools(payload.get("tools"))
    if tools:
        body["tools"] = tools
    url = f"{props_base_url(base_url)}/v1/responses/input_tokens"
    reply = _post_json(client, url, body, on_failure)
    if reply is None:
        return None
    count = _positive_count(reply.get("input_tokens"))
    if count is None and isinstance(reply.get("usage"), dict):
        count = _positive_count(reply["usage"].get("input_tokens"))
    if count is None:
        _fail(on_failure, missing=True)
    return count


_COUNTERS = {SERVER_KIND_LLAMA: count_llama_server, SERVER_KIND_NINFER: count_ninfer}


class ServerTokenCounter:
    """Per-engine count routes: a missing route is skipped until the next load,
    a passing failure (timeout, server error) rests it for a short cooldown."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._missing: set[str] = set()
        self._resting_until: dict[str, float] = {}
        self._clock = clock

    def reset(self) -> None:
        """Forget every route outcome (the engine's next model load or unload)."""
        self._missing.clear()
        self._resting_until.clear()

    def _available(self, kind: str) -> bool:
        return kind not in self._missing and self._clock() >= self._resting_until.get(kind, 0.0)

    def count(
        self, client: Any, base_url: str, payload: dict[str, Any], *, llama_props: bool
    ) -> int | None:
        """The server's token count of ``payload`` or ``None``. Never raises."""
        try:
            if payload_has_image(payload):
                return None
            kinds = [SERVER_KIND_NINFER]
            if llama_props:
                kinds.insert(0, SERVER_KIND_LLAMA)
            for kind in kinds:
                if not self._available(kind):
                    continue
                failures: list[bool] = []
                started = time.perf_counter()
                tokens = _COUNTERS[kind](client, base_url, payload, failures.append)
                elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
                if tokens is not None:
                    logger.debug(
                        "Server token count succeeded.",
                        extra={
                            "event": "ai.engines.server_token_count.counted",
                            "server_kind": kind,
                            "tokens": tokens,
                            "elapsed_ms": elapsed_ms,
                        },
                    )
                    return tokens
                missing = all(failures) if failures else True
                if missing:
                    self._missing.add(kind)
                else:
                    self._resting_until[kind] = self._clock() + _TRANSIENT_COOLDOWN_SECONDS
                logger.debug(
                    "Server token count route failed.",
                    extra={
                        "event": "ai.engines.server_token_count.route_disabled",
                        "server_kind": kind,
                        "route_missing": missing,
                        "elapsed_ms": elapsed_ms,
                    },
                )
                if not missing:
                    # A slow or failing server: do not stack another route's timeout
                    # onto the turn start.
                    return None
        except Exception:  # noqa: BLE001 - a count is best-effort and must never fail a turn.
            return None
        return None


__all__ = [
    "SERVER_KIND_LLAMA",
    "SERVER_KIND_NINFER",
    "ServerTokenCounter",
    "build_count_payload",
    "chat_messages_to_responses",
    "count_llama_server",
    "count_ninfer",
    "payload_has_image",
]
