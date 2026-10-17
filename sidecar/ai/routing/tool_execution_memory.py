"""The model-facing ``memory`` tool: sidecar-owned and run in-process.

Trusted inputs only. The project comes from the request's execution context
(else its memory policy), the session from the dispatch, the scope from the
argument enum; nothing from the model chooses a project. ``update`` and
``forget`` need an id this session has seen in a recall, list or write result,
and carry the revision it was seen at. Store refusals and conflicts are
successful results with one plain sentence; only infrastructure failures raise.
Memory text never reaches a log or an audit record.
"""

from __future__ import annotations

import hashlib
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.memory.contracts import (
    GENERAL_PROJECT_ID,
    MAX_LESSON_TEXT_CHARS,
    MEMORY_KINDS,
    require_project_id,
)
from sidecar.ai.memory.service import MemoryService, approved_memory_api, pending_memory_api
from sidecar.ai.routing import tool_execution_results as _results
from sidecar.ai.routing import tool_observation as _tool_observation
from sidecar.ai.routing.harness_helpers import MAX_RESPONSE_CHARS
from sidecar.exceptions import MemoryStoreError
from sidecar.runtime.tool_execution_support import (
    ToolCallRequest,
    ToolExecutionFailure,
    sanitize_tool_output,
)

if TYPE_CHECKING:
    from sidecar.runtime.tool_execution_support import ToolExecutionOutcome

TOOL_NAME = "memory"
MAX_OBSERVED_IDS_PER_SESSION = 200
MAX_OBSERVED_SESSIONS = 64
MAX_PINNED_OPERATIONS = 256
# A page of maximal rows (text plus the `[id N] (kind, scope) ` prefix and the
# cursor line) must fit MAX_RESPONSE_CHARS: a truncated page would drop rows the
# observed-revision map had already admitted. 31 on the current limits.
_LIST_ROW_OVERHEAD_CHARS = 96
_LIST_PAGE_RESERVE_CHARS = 512
_LIST_ROW_BUDGET_CHARS = MAX_LESSON_TEXT_CHARS + _LIST_ROW_OVERHEAD_CHARS
LIST_PAGE_SIZE = min(50, (MAX_RESPONSE_CHARS - _LIST_PAGE_RESERVE_CHARS) // _LIST_ROW_BUDGET_CHARS)
DEFAULT_RECALL_LIMIT = 5
MAX_RECALL_LIMIT = 8
TEXT_PREVIEW_CHARS = 80
WRITE_ACTIONS = frozenset({"remember", "update", "forget"})
READ_ACTIONS = frozenset({"recall", "list"})
SCOPES = ("project", "global", "chat")
_OPERATION_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_ATTACH_LOCK = threading.Lock()

_REFUSALS = {
    "paused": "Saving memories is paused for this chat; the user can still use /remember.",
    "unobserved": (
        "That memory id has not come up in this conversation. "
        "Look it up with recall or list first."
    ),
    "approval_required": (
        "Changing or forgetting memories needs the user's approval right now; "
        "ask them to do it on the Memory page."
    ),
    "approval_unavailable": (
        "Saving needs the user's approval, but the approval list is unavailable; "
        "nothing was saved."
    ),
    "not_queued": (
        "Nothing was queued: it is already remembered or waiting, "
        "or the user asked Jenny to forget it."
    ),
    "suppressed": (
        "The user asked Jenny to forget that, so it was not saved. This is deliberate, "
        "not an error: do not retry. The user can save it again with /remember."
    ),
    "protected": "The user edited that memory themselves, so Jenny cannot change or forget it.",
    "not_found": "That memory id is not an active memory.",
    "project_archived": "This project's memories are archived, so nothing was changed.",
    "session_purged": "This chat was deleted, so nothing was saved.",
    "already_remembered": "Another memory already says that, so nothing was changed.",
    "operation_mismatch": (
        "This tool call already changed a different memory; nothing more was done."
    ),
    "operation_expired": "This tool call is too old to repeat; nothing was done.",
    "always_on_full": "The always-on memories are full, so nothing was saved.",
    "capacity": "Memory is full; forget something first.",
    "subagent": "Sub-agents cannot use Jenny's memory.",
    "offline_lockdown": "Jenny's memory is off while this chat is in offline lockdown.",
    "unavailable": "Jenny's memory is unavailable right now.",
    "scope_unavailable": (
        "Jenny's memory is unavailable because this request has no chat or project."
    ),
}
# ``approval_required`` for a remember: the shared sentence speaks of
# changing or forgetting, which let a small model report the memory as saved.
_ASK_REMEMBER_REFUSAL = (
    "Not saved or queued: while the user approves new memories, only project or global "
    "memories that are not always-on can wait for approval. Tell the user it was not saved, "
    "and offer to queue it as a project or global memory instead."
)


class ObservedRevisions:
    """Bounded per-session map of memory ids the model has seen, with revisions.

    Sessions and ids are evicted least-recently-recorded first. Operation pins
    keep a replayed ``update``/``forget`` call on the revision it first used.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: OrderedDict[str, OrderedDict[int, tuple[int, str]]] = OrderedDict()
        self._pins: OrderedDict[str, tuple[int, str]] = OrderedDict()

    def record(self, session_id: str, memory_id: int, revision: int, project_id: str) -> None:
        with self._lock:
            ids = self._sessions.get(session_id)
            if ids is None:
                ids = OrderedDict()
                self._sessions[session_id] = ids
            self._sessions.move_to_end(session_id)
            while len(self._sessions) > MAX_OBSERVED_SESSIONS:
                self._sessions.popitem(last=False)
            ids.pop(memory_id, None)
            ids[memory_id] = (int(revision), str(project_id))
            while len(ids) > MAX_OBSERVED_IDS_PER_SESSION:
                ids.popitem(last=False)

    def lookup(self, session_id: str, memory_id: int) -> tuple[int, str] | None:
        with self._lock:
            ids = self._sessions.get(session_id)
            return None if ids is None else ids.get(memory_id)

    def pinned(self, operation_id: str, current: tuple[int, str]) -> tuple[int, str]:
        """Return the revision an operation first used, pinning ``current`` if new."""

        with self._lock:
            pin = self._pins.get(operation_id)
            if pin is None:
                pin = current
                self._pins[operation_id] = pin
                while len(self._pins) > MAX_PINNED_OPERATIONS:
                    self._pins.popitem(last=False)
            return pin


@dataclass(frozen=True)
class _Request:
    action: str
    arguments: dict[str, object]
    session_id: str
    project_id: str
    operation_id: str
    turn_id: str
    store: Any
    backend: Any
    capture: str
    observed: ObservedRevisions


@dataclass(frozen=True)
class _Result:
    output: str
    status: str
    success: bool = True
    reason: str | None = None
    memory: Any = None
    duplicate: bool = False
    undoable: bool = False
    operation_id: str | None = None
    committed: bool = False
    preview: str = ""
    scope: str | None = None
    kind: str | None = None


def observed_revisions(kernel: Any) -> ObservedRevisions:
    with _ATTACH_LOCK:
        observed = getattr(kernel, "_memory_observed_revisions", None)
        if not isinstance(observed, ObservedRevisions):
            observed = ObservedRevisions()
            kernel._memory_observed_revisions = observed
        return observed


def memory_operation_id(session_id: str, call_id: str, turn_id: str = "") -> str:
    """``tool:<session>:<turn>:<call>``: a provider reuses call ids every turn."""
    parts = [session_id, turn_id, call_id] if turn_id else [session_id, call_id]
    candidate = "tool:" + ":".join(parts)
    if _OPERATION_ID_RE.fullmatch(candidate):
        return candidate
    digest = hashlib.sha256("\0".join(parts).encode()).hexdigest()[:48]
    return f"tool:{digest}"


def _refused(
    reason: str, *, success: bool = True, sentence: str = "", **fields: Any
) -> _Result:
    sentence = sentence or _REFUSALS.get(reason, f"Nothing was changed ({reason}).")
    return _Result(output=sentence, status="refused", success=success, reason=reason, **fields)


def _invalid(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_EXECUTION_FAILED, message=message, retryable=False)


def _scope_label(memory: Any) -> str:
    if getattr(memory, "scope_session_id", ""):
        return "chat"
    return "global" if getattr(memory, "project_id", "") == GENERAL_PROJECT_ID else "project"


def _trusted_project(context: Any) -> str | None:
    for source in (getattr(context, "execution_context", None),
                   getattr(context, "memory_policy", None)):
        try:
            return require_project_id(getattr(source, "project_id", None))
        except ValueError:
            continue
    return None


def _context_refusal(kernel: Any, context: Any, session_id: str) -> _Result | None:
    if context is None or not session_id or _trusted_project(context) is None:
        return _refused("scope_unavailable", success=False)
    surface = str(getattr(context, "agent_surface", "main") or "main")
    if surface != "main" or int(getattr(context, "agent_depth", 0) or 0) > 0:
        return _refused("subagent", success=False)
    if getattr(context, "session_offline_lockdown", False) is True:
        return _refused("offline_lockdown", success=False)
    store = getattr(kernel, "_memory_store", None)
    if store is None or getattr(store, "available", False) is not True:
        return _refused("unavailable", success=False)
    return None


def _text_argument(arguments: dict[str, object], action: str) -> str:
    text = arguments.get("text")
    if not isinstance(text, str) or not text.strip():
        raise _invalid(f"memory {action} needs a non-empty 'text'")
    return text.strip()


def _id_argument(arguments: dict[str, object], action: str) -> int:
    value = arguments.get("id")
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise _invalid(f"memory {action} needs the integer 'id' from a recall or list result")
    return value


def _choice_argument(arguments: dict[str, object], key: str, allowed: tuple[str, ...],
                     default: str) -> str:
    value = arguments.get(key, default)
    if value not in allowed:
        raise _invalid(f"memory '{key}' must be one of {', '.join(allowed)}")
    return str(value)


def _record_rows(request: _Request, rows: list[Any]) -> None:
    for row in rows:
        request.observed.record(request.session_id, row.id, row.revision, row.project_id)


def _row_line(row: Any) -> str:
    return f"[id {row.id}] ({row.lesson_kind}, {_scope_label(row)}) {row.lesson_text}"


def _saved_output(action: str, memory: Any, duplicate: bool) -> str:
    if duplicate:
        return f"Already remembered [id {memory.id}]: {memory.lesson_text}"
    if action == "remember":
        return (
            f"Remembered [id {memory.id}, {memory.lesson_kind}, {_scope_label(memory)}]: "
            f"{memory.lesson_text}"
        )
    if action == "update":
        return f"Updated [id {memory.id}, revision {memory.revision}]: {memory.lesson_text}"
    return f"Forgot [id {memory.id}]."


def _write_result(request: _Request, result: Any) -> _Result:
    memory = result.memory
    if memory is not None:
        request.observed.record(request.session_id, memory.id, memory.revision, memory.project_id)
    preview = str(getattr(memory, "lesson_text", "") or "")
    if result.status == "saved" and memory is not None:
        committed = not result.duplicate
        return _Result(
            output=_saved_output(request.action, memory, result.duplicate), status="saved",
            memory=memory, duplicate=result.duplicate, undoable=result.undoable,
            operation_id=result.operation_id if committed else None, committed=committed,
            preview=preview,
        )
    if result.status == "conflict" and memory is not None:
        output = (
            f"Memory id {memory.id} changed since you last saw it; it is now revision "
            f"{memory.revision}: {memory.lesson_text}. Check it before changing it again."
        )
        return _Result(output=output, status="conflict", reason=result.reason, memory=memory)
    refused = _refused(str(result.reason or "refused"), memory=memory)
    if result.always_on_lines:
        lines = "\n".join(f"- {line}" for line in result.always_on_lines)
        refused = _Result(
            output=f"{refused.output} Current always-on memories:\n{lines}",
            status="refused", reason=refused.reason, memory=memory,
        )
    return refused


def _queue_for_approval(request: _Request, text: str, kind: str, project_id: str,
                        scope: str) -> _Result:
    queue = getattr(pending_memory_api(request.backend), "queue_candidate", None)
    if not callable(queue):
        return _refused("approval_unavailable", scope=scope, kind=kind, preview=text)
    queued = queue(
        project_id=project_id, session_id=request.session_id,
        source_request_id=request.operation_id, text=text, kind=kind, origin="jenny",
    )
    if not queued:
        return _refused("not_queued", scope=scope, kind=kind, preview=text)
    return _Result(
        output=f"Waiting for the user's approval: {text}", status="pending_approval",
        operation_id=request.operation_id, preview=text, scope=scope, kind=kind,
    )


def _remember(request: _Request) -> _Result:
    arguments = request.arguments
    text = _text_argument(arguments, "remember")
    kind = _choice_argument(arguments, "kind", MEMORY_KINDS, "fact")
    scope = _choice_argument(arguments, "scope", SCOPES, "project")
    always_on = arguments.get("always_on") is True
    if always_on and scope == "chat":
        raise _invalid("memory 'always_on' needs project or global scope")
    if request.capture == "off":
        return _refused("paused", scope=scope, kind=kind)
    project_id = GENERAL_PROJECT_ID if scope == "global" else request.project_id
    if request.capture == "ask":
        # A pending row carries project and text only: chat scope and always_on
        # cannot wait for approval (W1); the user can /remember them directly.
        if scope == "chat" or always_on:
            return _refused(
                "approval_required", sentence=_ASK_REMEMBER_REFUSAL, scope=scope, kind=kind
            )
        return _queue_for_approval(request, text, kind, project_id, scope)
    result = request.store.remember(
        operation_id=request.operation_id, project_id=project_id, text=text, kind=kind,
        origin="jenny", session_id=request.session_id,
        scope_session_id=request.session_id if scope == "chat" else "",
        always_on=always_on,
        source_message_ids=(request.turn_id,) if request.turn_id else (),
    )
    return _write_result(request, result)


def _change(request: _Request) -> _Result:
    """``update`` or ``forget`` an observed id at the revision it was seen."""

    arguments = request.arguments
    memory_id = _id_argument(arguments, request.action)
    text = _text_argument(arguments, "update") if request.action == "update" else None
    if request.capture == "off":
        return _refused("paused")
    if request.capture == "ask":
        return _refused("approval_required")
    seen = request.observed.lookup(request.session_id, memory_id)
    if seen is None:
        return _refused("unobserved")
    revision, project_id = request.observed.pinned(request.operation_id, seen)
    if project_id not in (request.project_id, GENERAL_PROJECT_ID):
        # Observed under another project (the chat moved since): read it again.
        return _refused("unobserved")
    common = {
        "operation_id": request.operation_id, "project_id": project_id,
        "memory_id": memory_id, "expected_revision": revision, "origin": "jenny",
    }
    if request.action == "forget":
        return _write_result(request, request.store.forget(**common))
    changes: dict[str, Any] = {"text": text}
    if "kind" in arguments:
        changes["kind"] = _choice_argument(arguments, "kind", MEMORY_KINDS, "fact")
    if isinstance(arguments.get("always_on"), bool):
        changes["always_on"] = arguments["always_on"]
    return _write_result(request, request.store.update(**common, **changes))


def _rows_output(rows: list[Any], next_cursor: str | None) -> str:
    lines = [_row_line(row) for row in rows]
    if next_cursor:
        lines.append(f"(more: cursor={next_cursor})")
    return "\n".join(lines) if lines else "No memories match."


def _recall(request: _Request) -> _Result:
    query = request.arguments.get("query")
    if not isinstance(query, str) or not query.strip():
        raise _invalid("memory recall needs a non-empty 'query'")
    limit = request.arguments.get("limit", DEFAULT_RECALL_LIMIT)
    if isinstance(limit, bool) or not isinstance(limit, int):
        limit = DEFAULT_RECALL_LIMIT
    # The service fuses the lexical rows with the vector leg while hybrid
    # recall is on (row 58 W4); otherwise this is the store's lexical recall.
    recall = (
        request.backend.recall
        if isinstance(request.backend, MemoryService)
        else request.store.recall_memories
    )
    rows = recall(
        query.strip(), limit=max(1, min(limit, MAX_RECALL_LIMIT)),
        project_id=request.project_id, include_general=True,
        scope_session_id=request.session_id,
    )
    _record_rows(request, rows)
    return _Result(output=_rows_output(rows, None), status="ok")


def _list(request: _Request) -> _Result:
    cursor = request.arguments.get("cursor")
    rows, next_cursor = request.store.list_active(
        project_id=request.project_id, scope_session_id=request.session_id,
        include_general=True, cursor=cursor if isinstance(cursor, str) and cursor else None,
        limit=LIST_PAGE_SIZE,
    )
    _record_rows(request, rows)
    return _Result(output=_rows_output(rows, next_cursor), status="ok")


_ACTIONS = {
    "remember": _remember,
    "update": _change,
    "forget": _change,
    "recall": _recall,
    "list": _list,
}


def _metadata(action: str, result: _Result) -> dict[str, object]:
    memory = result.memory
    metadata: dict[str, object] = {
        "result_kind": "memory",
        "action": action,
        "status": result.status,
        "duplicate": result.duplicate,
        "undoable": result.undoable,
        "effects": "committed" if result.committed else "none",
    }
    scope = _scope_label(memory) if memory is not None else result.scope
    kind = getattr(memory, "lesson_kind", None) if memory is not None else result.kind
    optional: dict[str, object | None] = {
        "memory_id": getattr(memory, "id", None),
        "revision": getattr(memory, "revision", None),
        "operation_id": result.operation_id,
        "scope": scope,
        "kind": kind,
        "reason": result.reason,
        "text_preview": result.preview[:TEXT_PREVIEW_CHARS] if action in WRITE_ACTIONS else "",
    }
    metadata.update({key: value for key, value in optional.items() if value not in (None, "")})
    return metadata


def _build_request(  # noqa: PLR0913 - every field is a trusted input.
    *, kernel: Any, call: ToolCallRequest, tool_arguments: dict[str, object],
    session_id: str, context: Any, runtime: Any | None,
) -> _Request:
    action = str(tool_arguments.get("action") or "")
    policy = getattr(context, "memory_policy", None)
    capture = str(getattr(policy, "capture", "off") or "off") if policy is not None else "off"
    return _Request(
        action=action, arguments=tool_arguments, session_id=session_id,
        project_id=str(_trusted_project(context)),
        operation_id=memory_operation_id(
            session_id, str(call.call_id or ""), str(getattr(runtime, "logical_turn_id", "") or "")
        ),
        turn_id=str(getattr(runtime, "logical_turn_id", "") or ""),
        store=approved_memory_api(kernel._memory_store), backend=kernel._memory_store,
        capture=capture, observed=observed_revisions(kernel),
    )


def _run(request: _Request) -> _Result:
    try:
        return _ACTIONS[request.action](request)
    except MemoryStoreError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message=f"memory {request.action} failed ({error.code})",
            retryable=bool(error.retryable),
        ) from error


def _execute_memory_tool(  # noqa: PLR0913 - the uniform synthetic-handler signature.
    *,
    kernel: Any,
    call: ToolCallRequest,
    tool_arguments: dict[str, object],
    visible_tool_arguments: dict[str, object],
    request_id: str,
    session_id: str | None,
    audit_metadata: dict[str, object] | None,
    runtime: Any | None,
    outcome_type: Any,
) -> ToolExecutionOutcome:
    action = str(tool_arguments.get("action") or "")
    if action not in _ACTIONS:
        raise _invalid("memory 'action' must be one of remember, update, forget, recall, list")
    context = getattr(runtime, "request_context", None)
    session = str(session_id or getattr(runtime, "session_id", "") or "")
    result = _context_refusal(kernel, context, session)
    if result is None:
        result = _run(_build_request(
            kernel=kernel, call=call, tool_arguments=tool_arguments, session_id=session,
            context=context, runtime=runtime,
        ))
    error_code = None if result.success else CMP_TOOL_EXECUTION_FAILED
    if runtime is not None:
        runtime.audit(
            _tool_observation.KIND_TOOL_EXECUTION_OBSERVED
            if result.success
            else _tool_observation.KIND_TOOL_EXECUTION_FAILED,
            tool_call_id=str(call.call_id or ""),
            tool_name=TOOL_NAME,
            error_code=error_code,
            summary=f"tool_execution_observed memory {action} {result.status}",
        )
    return outcome_type(
        tool_name=TOOL_NAME,
        output=sanitize_tool_output(result.output, max_chars=MAX_RESPONSE_CHARS,
                                    tool_name=TOOL_NAME),
        success=result.success,
        tool_input=visible_tool_arguments,
        error_code=error_code,
        metadata=_results.merge_result_metadata(_metadata(action, result), audit_metadata),
        call_id=call.call_id,
    )


__all__ = [
    "LIST_PAGE_SIZE",
    "MAX_OBSERVED_IDS_PER_SESSION",
    "MAX_OBSERVED_SESSIONS",
    "ObservedRevisions",
    "memory_operation_id",
    "observed_revisions",
]
