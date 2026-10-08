"""Text and structured transport helpers for the Codex CLI engine.

Everything here is pure: what Jenny tells the CLI (instructions, the flat
prompt, the output schema) and how it reads what comes back (agent messages,
the structured reply, CLI-owned tool events). Process handling stays in
``codex_cli``.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Sequence

from sidecar.ai.config import read_environment_value
from sidecar.ai.engines.base import EMPTY_ASSISTANT_CONTENT_PLACEHOLDER, EngineMessage
from sidecar.ai.tools.inband_parser import _gen_inband_call_id
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.ai.tools.tool_call_healing import is_healing_enabled, repair_json_payload

if TYPE_CHECKING:
    from sidecar.ai.engines.codex_cli import CodexCliProcessResult

logger = logging.getLogger(__name__)

_TOOL_EVENT_MARKERS = (
    "tool",
    "command",
    "exec",
    "shell",
    "file",
    "mcp",
    "browser",
    "web",
)
_AGENT_MESSAGE_TYPES = frozenset({"agent_message", "assistant_message"})
_TEXT_EVENT_MARKERS = ("agent_message", "assistant_message", "message")
_TEXT_FIELDS = ("message", "content", "text", "delta", "output_text")
_TOOL_EVENT_REJECTION_MESSAGE = (
    "Codex CLI attempted to use its own tool; Jenny tools are required"
)
# The CLI is only Jenny's text transport. Its native tool catalog does not
# contain Jenny tools; make the in-band bridge explicit at the documented
# developer-instruction layer without replacing Codex base instructions.
_JENNY_TRANSPORT_INSTRUCTIONS = (
    "You are the text-generation transport inside Jenny, not an autonomous Codex agent. Jenny "
    "owns the workspace, tools, execution and approvals. The System section of the input "
    "describes Jenny tools, which are available through a text protocol even though they are "
    "absent from your native Codex tool list. To request one, emit a literal "
    "<tool_call>{\"name\":\"TOOL_NAME\",\"arguments\":{...}}</tool_call> in your final assistant "
    "text, using the exact catalog name and arguments, then stop. Jenny will parse the request, "
    "enforce its permissions, execute it if approved, and provide the actual result on the next "
    "turn. Do not call any native Codex tools. Do not merely describe or simulate a tool call. "
    "Do not claim a tool is unavailable solely because it is not a native Codex tool. Never "
    "claim execution succeeded before receiving Jenny's tool result. Only request tools listed "
    "in the current Jenny catalog and honor its restrictions. The read-only sandbox you run in "
    "limits native Codex tools only: Jenny tools run outside it, so a Jenny file tool can write "
    "when Jenny and the user allow it. Never refuse a Jenny tool request because your own "
    "sandbox is read-only."
)
# Structured transport: `codex exec --output-schema` makes the final reply a
# JSON object, so every tool-capable turn states its tool requests in a field
# (an empty list is an explicit "none") instead of hoping the model writes the
# in-band tag. JENNY_ENABLE_CODEX_STRUCTURED_TOOLS=0 restores the text bridge.
_STRUCTURED_TOOLS_FLAG = "JENNY_ENABLE_CODEX_STRUCTURED_TOOLS"
_CMD_METACHARACTERS = frozenset('"<>%^&|!()')
# Free of quotes, angle brackets and other cmd.exe metacharacters on purpose:
# unlike the text-bridge instructions it must survive an npm batch shim.
_JENNY_STRUCTURED_TRANSPORT_INSTRUCTIONS = (
    "You are the text-generation transport inside Jenny, not an autonomous Codex agent. Jenny "
    "owns the workspace, tools, execution and approvals. The System section of the input "
    "describes Jenny tools. They are absent from your native Codex tool list and you reach "
    "them only through your final response. Your final response is a JSON object with two "
    "fields: message, the text shown to the user, and tool_calls, the list of Jenny tool "
    "requests for this turn. Each request has name, the exact catalog name, and "
    "arguments_json, the arguments object encoded as a JSON string. Where the System section "
    "tells you to write a tool_call tag, add an entry to tool_calls instead and keep tags out "
    "of message. Jenny parses the requests, enforces its permissions, runs the approved ones "
    "and returns the actual results on the next turn. An empty tool_calls list means you "
    "request nothing: if message says you will do something that needs a tool, the matching "
    "request must be in tool_calls of this same response. Do not call native Codex tools. Do "
    "not claim a tool is unavailable solely because it is not a native Codex tool. Never claim "
    "a result before receiving it from Jenny. Only request tools listed in the current Jenny "
    "catalog and honor its restrictions. The read-only sandbox you run in limits native Codex "
    "tools only: Jenny tools run outside it, so a Jenny file tool can write when Jenny and the "
    "user allow it. Never refuse a Jenny tool request because your own sandbox is read-only."
)
_BATCH_SHIM_WARNED: set[str] = set()
_MAX_EVENT_KINDS = 24
_MAX_DIAGNOSTIC_ENTRIES = 8
# Character-level fixes only: a repair that strips or closes structure can
# keep the first of several objects or a cut-off body, which is not the call.
_SAFE_ARGUMENT_REPAIRS = frozenset(
    {"ascii_quotes", "python_literals", "single_quotes", "trailing_comma"}
)


def _structured_tools_enabled() -> bool:
    return read_environment_value(_STRUCTURED_TOOLS_FLAG, "1") != "0"


def _catalog_tool_names(tools: list[dict[str, Any]] | None) -> list[str]:
    names = {
        str(tool.get("name") or tool.get("tool_id") or "").strip()
        for tool in tools or ()
        if isinstance(tool, dict)
    }
    return sorted(names - {""})


def _output_schema(tool_names: list[str]) -> dict[str, Any]:
    # Strict structured output: every property required, no extras. Tool
    # arguments differ per tool, so they travel as a JSON-encoded string.
    return {
        "type": "object",
        "properties": {
            "message": {"type": "string"},
            "tool_calls": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "enum": tool_names},
                        "arguments_json": {"type": "string"},
                    },
                    "required": ["name", "arguments_json"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["message", "tool_calls"],
        "additionalProperties": False,
    }


def _discard_output_schema(path: Path | None) -> None:
    if path is not None:
        with suppress(OSError):
            path.unlink()


def _output_schema_flag_rejected(result: CodexCliProcessResult) -> bool:
    # clap's wording for a flag this CLI version does not know.
    stderr = str(result.stderr or "")
    return result.exit_code != 0 and "unexpected argument" in stderr and "--output-schema" in stderr


def _escape_angle_brackets(text: str) -> str:
    return text.replace("<", "\\u003c").replace(">", "\\u003e")


def _structured_result(
    parts: list[str], tool_names: list[str], out: list[GenerationResult] | None = None
) -> GenerationResult | None:
    result = _read_structured_result(parts, tool_names)
    if result is not None and out is not None:
        out.append(result)
    return result


def _read_structured_result(parts: list[str], tool_names: list[str]) -> GenerationResult | None:
    """Read the schema object from the agent messages, or None if it is absent.

    Tool requests come only from ``tool_calls``; ``message`` is plain text and
    is never scanned for call syntax, so an empty list really requests nothing
    and a call cannot be made twice or renamed by its own arguments.
    """

    payload, preface = _schema_object(parts[-1:]), parts[:-1]
    if payload is None:
        payload, preface = _schema_object(["".join(parts)]), []
    if payload is None:
        return None
    message = payload.get("message")
    texts = [*preface, message if isinstance(message, str) else ""]
    content = "\n".join(text.strip() for text in texts if text.strip())
    calls: list[ToolCallRequest] = []
    failures: list[dict[str, Any]] = []
    for entry in payload["tool_calls"]:
        call, failure = _structured_call(entry, tool_names)
        if call is not None:
            calls.append(call)
        elif failure is not None and len(failures) < _MAX_DIAGNOSTIC_ENTRIES:
            failures.append(failure)
    # Content-free: the transport tells the loop which envelope to re-teach.
    diagnostics = {"transport": "structured", "entries": failures}
    if calls:
        return GenerationResult(
            content=content,
            tool_calls=tuple(calls),
            finish_reason="tool_calls",
            tool_call_parse_diagnostics=diagnostics,
        )
    # Same signal as a failed in-band candidate: the model gets its repair hint.
    return GenerationResult(
        content=content,
        finish_reason="stop",
        inband_tool_call_parse_failed=bool(failures),
        tool_call_parse_diagnostics=diagnostics,
    )


def _schema_object(texts: list[str]) -> dict[str, Any] | None:
    if not texts:
        return None
    try:
        payload = json.loads(texts[0])
    except ValueError:
        return None
    if isinstance(payload, dict) and isinstance(payload.get("tool_calls"), list):
        return payload
    return None


def _structured_call(
    entry: Any, tool_names: list[str]
) -> tuple[ToolCallRequest | None, dict[str, Any] | None]:
    """Return ``(call, None)`` for a usable entry or ``(None, diagnostic)``."""

    name = str(entry.get("name") or "").strip() if isinstance(entry, dict) else ""
    raw = entry.get("arguments_json") if isinstance(entry, dict) else None
    diagnostic: dict[str, Any] = {
        "tool": name if name in tool_names else "<unknown>",
        "arguments_length": len(raw) if isinstance(raw, str) else 0,
    }
    if name not in tool_names:
        return None, {**diagnostic, "reason": "unknown_tool"}
    arguments = _structured_call_arguments(raw)
    if arguments is None:
        return None, {**diagnostic, **_arguments_failure(raw)}
    return ToolCallRequest(
        tool_id=name, arguments=arguments, call_id=_gen_inband_call_id(name)
    ), None


def _decode_arguments_object(text: str) -> dict[str, Any] | None:
    # ``strict=False`` accepts raw control characters (a literal newline)
    # inside string values, the usual slip in large bodies.
    with suppress(ValueError):
        decoded = json.loads(text, strict=False)
        return decoded if isinstance(decoded, dict) else None
    # The net's own repair passes run only when the reliability net is on, and
    # only character-level fixes count here. Closing a cut-off string or object,
    # or isolating one object out of a truncated list, would run the call on
    # partial arguments (half a write_file body); a repair that leaves nothing
    # ({} from non-blank text) discarded them. Those stay malformed and the
    # model is asked to resend.
    if not is_healing_enabled():
        return None
    healed = repair_json_payload(text)
    if not _SAFE_ARGUMENT_REPAIRS.issuperset(healed.repairs):
        return None
    return healed.value or None


def _arguments_failure(raw: Any) -> dict[str, Any]:
    """Describe why ``arguments_json`` is unusable without echoing any of it."""

    if isinstance(raw, str):
        try:
            json.loads(raw, strict=False)
        except json.JSONDecodeError as error:
            return {"reason": "json_error", "error": error.msg, "pos": error.pos}
        except ValueError:
            # e.g. an integer past the digit limit: no position, fixed label.
            return {"reason": "json_error", "error": "invalid value"}
    return {"reason": "not_object"}


def _structured_call_arguments(raw: Any) -> dict[str, Any] | None:
    # Anything but a JSON object (bad JSON, a double-encoded string, null, a
    # list) is malformed; running the call with {} would hide the mistake.
    if isinstance(raw, str):
        return {} if not raw.strip() else _decode_arguments_object(raw)
    return raw if isinstance(raw, dict) else None


def _resolves_to_batch_shim(command: str) -> bool:
    if os.name != "nt":
        return False
    resolved = shutil.which(command) or command
    return Path(resolved).suffix.lower() in {".cmd", ".bat"}


def _warn_batch_shim_once(command: str) -> None:
    if command in _BATCH_SHIM_WARNED:
        return
    _BATCH_SHIM_WARNED.add(command)
    logger.warning(
        "Codex CLI resolves to a batch shim; Jenny's transport instructions are not passed.",
        extra={"event": "ai.engines.codex_cli.batch_shim_instructions_skipped"},
    )


def _assemble_prompt(
    *,
    prompt: str,
    system: str,
    messages: list[EngineMessage] | None,
    structured: bool = False,
) -> str:
    sections: list[str] = []
    if system.strip():
        sections.append(f"System:\n{system.strip()}")
    if messages:
        for message in messages:
            role = str(message.get("role") or "user").strip() or "user"
            content = _message_content_to_text(message.get("content"))
            if role == "assistant":
                content = _with_replayed_tool_calls(
                    content, message.get("tool_calls"), structured=structured
                )
            if content:
                sections.append(f"{role}:\n{content}")
    elif str(prompt or "").strip():
        sections.append(f"User:\n{str(prompt).strip()}")
    return "\n\n".join(sections)


def _with_replayed_tool_calls(content: str, raw_calls: Any, *, structured: bool = False) -> str:
    # The CLI sees one flat text prompt, so an assistant turn that called tools
    # is replayed in the form this turn must answer in (the schema object, or
    # Jenny's in-band tag); otherwise the following tool result has no visible
    # call and the "(no content)" backfill is imitated.
    if not isinstance(raw_calls, list) or not raw_calls:
        return content
    text = "" if content == EMPTY_ASSISTANT_CONTENT_PLACEHOLDER else content
    calls = [
        (name, _replayed_call_arguments(call.get("arguments")))
        for call in raw_calls
        if isinstance(call, dict)
        for name in [str(call.get("name") or call.get("tool_id") or "").strip()]
        if name
    ]
    if structured:
        return json.dumps(
            {
                "message": text,
                "tool_calls": [
                    {"name": name, "arguments_json": json.dumps(arguments, ensure_ascii=False)}
                    for name, arguments in calls
                ],
            },
            ensure_ascii=False,
        )
    parts = [text] if text else []
    for name, arguments in calls:
        # Escaped angle brackets keep an argument that itself contains a
        # tool_call tag from reading as a call the model never made.
        body = json.dumps({"name": name, "arguments": arguments}, ensure_ascii=False)
        parts.append(f"<tool_call>{_escape_angle_brackets(body)}</tool_call>")
    return "\n".join(parts)


def _replayed_call_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    if not isinstance(raw, dict):
        return {}
    # `_jenny_*` keys are runtime bookkeeping, not part of the model's call.
    return {key: value for key, value in raw.items() if not str(key).startswith("_jenny_")}


def _message_content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                value = item.get("text") or item.get("content")
                if isinstance(value, str) and value.strip():
                    parts.append(value.strip())
            elif isinstance(item, str) and item.strip():
                parts.append(item.strip())
        return "\n".join(parts)
    return "" if content is None else str(content).strip()


def _parse_jsonl_output(
    stdout: str, *, on_event: Callable[[dict[str, Any]], None] | None = None,
) -> str:
    return "".join(_agent_message_parts(stdout, on_event=on_event)).strip()


def _jsonl_event_counts(stdout: str) -> dict[str, int]:
    """Count the CLI's JSONL events by kind, for a stalled-turn diagnostic."""
    counts: dict[str, int] = {}
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        kind = str(event.get("type") or "unknown")
        item = event.get("item")
        if isinstance(item, dict) and item.get("type"):
            kind = f"{kind}:{item['type']}"
        kind = kind[:80]
        if kind in counts or len(counts) < _MAX_EVENT_KINDS:
            counts[kind] = counts.get(kind, 0) + 1
    return counts


def _agent_message_parts(
    stdout: str, *, on_event: Callable[[dict[str, Any]], None] | None = None,
) -> list[str]:
    parts: list[str] = []
    saw_json = False
    for raw_line in str(stdout or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        saw_json = True
        if not isinstance(event, dict):
            continue
        if on_event is not None:
            on_event(event)
        _reject_cli_tool_event(event)
        text = _extract_text(event)
        if text:
            parts.append(text)
    if parts:
        return parts
    if saw_json:
        raise RuntimeError("Codex CLI JSONL output did not contain an assistant message")
    return [str(stdout or "")]


def _reject_cli_tool_event(event: dict[str, Any]) -> None:
    if _cli_tool_event_marker(event):
        raise RuntimeError(_TOOL_EVENT_REJECTION_MESSAGE)


def _cli_tool_event_marker(event: dict[str, Any]) -> str:
    """Return the marker that makes ``event`` a CLI-owned tool event, or ""."""

    tokens = [
        str(event.get("type") or ""),
        str(event.get("name") or ""),
        str(event.get("tool") or ""),
        str(event.get("tool_name") or ""),
        str(event.get("subtype") or ""),
        str(event.get("event") or ""),
    ]
    item = event.get("item")
    if isinstance(item, dict):
        tokens.extend(
            [
                str(item.get("type") or ""),
                str(item.get("name") or ""),
                str(item.get("tool") or ""),
                str(item.get("tool_name") or ""),
                str(item.get("subtype") or ""),
                str(item.get("command") or ""),
            ]
        )
    normalized = " ".join(token.lower() for token in tokens if token)
    for marker in _TOOL_EVENT_MARKERS:
        if marker in normalized:
            return marker
    return ""


def _extract_text(event: dict[str, Any]) -> str:
    event_type = str(event.get("type") or "").strip().lower()
    item = event.get("item")
    if isinstance(item, dict):
        item_type = str(item.get("type") or "").strip().lower()
        if item_type in _AGENT_MESSAGE_TYPES:
            return _first_text_value(item, ("message", "content", "text"))
        return ""
    if event_type and not _is_text_event_type(event_type):
        return ""
    text = _first_text_value(event, _TEXT_FIELDS)
    if text:
        return text
    response = event.get("response")
    return _first_text_value(response, ("output_text",)) if isinstance(response, dict) else ""


def _is_text_event_type(event_type: str) -> bool:
    return any(marker in event_type for marker in _TEXT_EVENT_MARKERS) or event_type.startswith(
        "response"
    )


def _first_text_value(source: dict[str, Any], keys: Sequence[str]) -> str:
    for key in keys:
        value = source.get(key)
        if isinstance(value, str) and value:
            return value
    return ""
