"""Row 184 W3: ask Electron for a writing helper's worktree, and settle it afterwards.

Electron owns worktree creation and the root identity that builtin tools bind to
(``services/backend/helper-worktree-authority.js``). The sidecar sends
``runtime.operation`` with ``kind: "helper_worktree"`` on the parent's request; a
``create`` returns the worktree's root identity, a ``settle`` says whether it was kept.
``worktree_changes`` measures the worktree before the settle.
"""

from __future__ import annotations

import itertools
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.protocol import (
    API_VERSION,
    JSONRPC_VERSION,
    RUNTIME_OPERATION_HELPER_WORKTREE_KIND,
    RUNTIME_OPERATION_METHOD,
)
from sidecar.runtime.multiplexer import ApprovalResponseCancelledError
from sidecar.runtime.operation_admission import _closing, _rejection_error

_RPC_IDS = itertools.count(31_000_000)
# git worktree add on a large checkout can take a while; the turn's own cancel still applies.
_MAX_WAIT_SECONDS = 120.0
# A settle runs after the helper even when the turn was cancelled, so it ignores the
# turn's cancel and waits less: an unsettled worktree is only kept, never lost.
# Electron's worktree delete runs git under its own 30 s timeout.
_SETTLE_WAIT_SECONDS = 35.0
_RESULT_FIELDS = frozenset({"schema_version", "status", "operation_id", "error", "helper_worktree"})
_CREATED_FIELDS = frozenset(
    {"id", "branch", "base_ref", "root_path", "root_id", "device_id", "inode"}
)
_SETTLED_FIELDS = frozenset({"id", "kept", "reason"})
_MAX_TEXT = 4096


@dataclass(frozen=True, slots=True)
class HelperWorktree:
    id: str
    branch: str
    base_ref: str
    root_path: str
    root_id: str
    device_id: str | None
    inode: str | None


def _fail(message: str, *, retryable: bool = False) -> MCPError:
    return MCPError(code=CMP_TOOL_EXECUTION_FAILED, message=message, retryable=retryable)


def _text(value: Any, *, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value or len(value) > _MAX_TEXT:
        raise _fail("helper worktree response is malformed")
    return value


def _created(payload: Any) -> HelperWorktree:
    if not isinstance(payload, dict) or set(payload) != _CREATED_FIELDS:
        raise _fail("helper worktree response is malformed")
    return HelperWorktree(
        id=_text(payload["id"]) or "",
        branch=_text(payload["branch"]) or "",
        base_ref=payload["base_ref"] if isinstance(payload["base_ref"], str) else "",
        root_path=_text(payload["root_path"]) or "",
        root_id=_text(payload["root_id"]) or "",
        device_id=_text(payload["device_id"], optional=True),
        inode=_text(payload["inode"], optional=True),
    )


def _settled(payload: Any) -> bool:
    if (
        not isinstance(payload, dict)
        or not {"id", "kept"} <= set(payload) <= _SETTLED_FIELDS
        or not isinstance(payload["kept"], bool)
    ):
        raise _fail("helper worktree response is malformed")
    return payload["kept"]


def request_helper_worktree(  # noqa: PLR0913 - one wire request, explicit fields.
    *,
    request_id: str,
    session_id: str,
    authority_revision: str,
    operation_id: str,
    action: str,
    write_message: Callable[[dict[str, Any]], None] | None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    cancel_handle: Any = None,
    name: str | None = None,
    helper_worktree_id: str | None = None,
    keep: bool | None = None,
) -> HelperWorktree | bool:
    """``create`` returns the issued worktree; ``settle`` returns whether it was kept."""

    if not callable(write_message) or not callable(response_reader_factory):
        raise _fail("runtime operation authority bridge is unavailable")
    params: dict[str, Any] = _action_fields(action, name, helper_worktree_id, keep)
    params.update({
        "schema_version": 1,
        "kind": RUNTIME_OPERATION_HELPER_WORKTREE_KIND,
        "request_id": request_id,
        "session_id": session_id,
        "authority_revision": authority_revision,
        "operation_id": operation_id,
        "action": action,
        "api_version": API_VERSION,
    })
    rpc_id = next(_RPC_IDS)
    message = {
        "jsonrpc": JSONRPC_VERSION,
        "api_version": API_VERSION,
        "id": rpc_id,
        "method": RUNTIME_OPERATION_METHOD,
        "params": params,
    }
    json.dumps(message)  # a non-serializable field is a programming error: raise here.
    if action == "settle":
        cancel_handle = None
    reader = response_reader_factory(rpc_id, cancel_handle=cancel_handle)
    with _closing(reader):
        write_message(message)
        response = _await_response(
            reader, rpc_id, cancel_handle,
            _SETTLE_WAIT_SECONDS if action == "settle" else _MAX_WAIT_SECONDS,
        )
    if isinstance(response.get("error"), dict):
        raise _rejection_error(response["error"].get("data"))
    result = response.get("result")
    if (
        not isinstance(result, dict)
        or set(result) - _RESULT_FIELDS
        or result.get("schema_version") != 1
        or result.get("operation_id") != operation_id
        or result.get("status") not in {"granted", "rejected"}
    ):
        raise _fail("helper worktree response is malformed")
    if result["status"] == "rejected":
        raise _rejection_error(result.get("error"))
    payload = result.get("helper_worktree")
    return _created(payload) if action == "create" else _settled(payload)


def _action_fields(
    action: str, name: str | None, helper_worktree_id: str | None, keep: bool | None,
) -> dict[str, Any]:
    if action == "create":
        return {} if name is None else {"name": name}
    if action == "settle" and helper_worktree_id and isinstance(keep, bool):
        return {"helper_worktree_id": helper_worktree_id, "keep": keep}
    raise _fail("helper worktree request is invalid")


def _await_response(
    reader: Any, rpc_id: int, cancel_handle: Any, wait_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + wait_seconds
    while True:
        if cancel_handle is not None and getattr(cancel_handle, "cancelled", False):
            raise _fail("helper worktree request was cancelled", retryable=True)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _fail("helper worktree request timed out", retryable=True)
        try:
            response = reader(remaining)
        except (TimeoutError, ApprovalResponseCancelledError) as error:
            raise _fail("helper worktree request did not complete", retryable=True) from error
        if isinstance(response, dict) and response.get("id") == rpc_id:
            return response


def worktree_changes(root: str, start: str | None) -> dict[str, int] | None:
    """Files changed (untracked included), lines and commits since ``start``; None if unreadable."""
    from sidecar.ai.tools.builtins.git_ops import _parse_shortstat

    try:
        status = _git(root, ["status", "--porcelain", "--untracked-files=all"])
        base = start or "HEAD"
        stat = _parse_shortstat(_git(root, ["diff", "--shortstat", base]))
        ahead = _git(root, ["rev-list", "--count", f"{base}..HEAD"]) if start else ""
        commits = int(ahead.strip() or 0)
    except Exception:  # noqa: BLE001 - unreadable: the worktree is kept, never removed.
        return None
    files = len([line for line in status.splitlines() if line.strip()])
    return {
        "files_changed": max(files, stat.files_changed if stat else 0),
        "insertions": stat.lines_added if stat else 0,
        "deletions": stat.lines_removed if stat else 0,
        "commits": commits,
    }


def worktree_head(root: str) -> str | None:
    try:
        return _git(root, ["rev-parse", "HEAD"]).strip() or None
    except Exception:  # noqa: BLE001 - no start point: commits are not counted.
        return None


def _git(root: str, arguments: list[str]) -> str:
    """Git inside the issued worktree, validated and pinned to it like the git tools; the C
    locale keeps ``--shortstat`` wording parseable."""
    from sidecar.ai.tools.builtins.git_ops import _run_git_output
    from sidecar.ai.tools.workspace import WorkspaceGuard

    return _run_git_output(
        arguments, cwd=Path(root), workspace=WorkspaceGuard(root), env_overrides={"LC_ALL": "C"},
    ).stdout


__all__ = ["HelperWorktree", "request_helper_worktree", "worktree_changes", "worktree_head"]
