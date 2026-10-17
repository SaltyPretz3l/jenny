"""Closed request decoder for ``command.execute_proposal``.

The exact-command Run adapter runs ONE already-proposed ``run_command`` call. The
request is a closed record: every key is named here, every value is bounded, and
the command text is bound to the proposal by a digest the sidecar recomputes. All
checks that need no kernel state run here, before any effect.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any

from sidecar.ai.error_codes import CMP_CHAT_INVALID_PARAMS
from sidecar.protocol import API_VERSION
from sidecar.runtime.chat_models import ChatRequestError, logical_turn_id_from_params
from sidecar.runtime.continuation_context import (
    ContinuationContext,
    continuation_context_from_params,
)
from sidecar.runtime.execution_context import ExecutionContext, execution_context_from_params

COMMAND_PROPOSAL_VERSION = 1
SCHEMA_VERSION = 1
BACKENDS = frozenset({"native", "docker"})
SHELLS = frozenset({"cmd.exe", "/bin/sh"})
MAX_COMMAND_BYTES = 8 * 1024
MAX_PURPOSE_CHARS = 1024
MAX_CWD_CHARS = 4096
MAX_PROPOSAL_ID_CHARS = 128
MAX_TIMEOUT_SECONDS = 300
MAX_DOCKER_TIMEOUT_SECONDS = 120
MAX_EXPECTED_EXIT_CODES = 16
_TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
# Mirrors Electron's proposal validator: characters that render invisibly or reorder displayed
# text (C0 other than TAB/LF/CR, DEL, C1, bidi and zero-width format) are refused so the inspected
# command is exactly what runs.
_INVISIBLE_RE = re.compile(
    "[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e"
    "\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]"
)
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_TOP_KEYS = frozenset(
    {
        "accept_version",
        "api_version",
        "schema_version",
        "request_id",
        "trace_id",
        "session_id",
        "generation",
        "approval_mode",
        "safety_mode",
        "auto_approve_streak_cap",
        "plan_mode",
        "read_only",
        "turn_id",
        "operation_id",
        "proposal_id",
        "accepted_revision",
        "decision_id",
        "command_sha256",
        "tool_call_id",
        "execution_context",
        "runtime_operation_context",
        "binding",
        "input",
    }
)
_REQUIRED_KEYS = frozenset(
    {
        "accept_version",
        "schema_version",
        "request_id",
        "session_id",
        "turn_id",
        "operation_id",
        "proposal_id",
        "accepted_revision",
        "decision_id",
        "command_sha256",
        "tool_call_id",
        "execution_context",
        "binding",
        "input",
    }
)
_BINDING_KEYS = frozenset({"backend", "shell", "cwd", "root_revision"})
_INPUT_KEYS = frozenset({"command", "cwd", "timeout_seconds", "expected_exit_codes", "purpose"})


class CommandProposalRefusal(ValueError):
    """The request is refused before any effect; ``reason`` is a stable token."""

    def __init__(self, reason: str, message: str | None = None) -> None:
        super().__init__(message or reason)
        self.reason = reason


def refusal_error(
    request_id: str,
    trace_id: str | None,
    session_id: str | None,
    reason: str,
    *,
    code: str = CMP_CHAT_INVALID_PARAMS,
) -> ChatRequestError:
    """The pre-effect error response: a stable ``reason`` token, never a command."""
    return ChatRequestError(
        request_id=request_id,
        trace_id=trace_id,
        session_id=session_id,
        code=code,
        message=f"command.execute_proposal refused: {reason}",
        rpc_code=-32602,
        retryable=False,
        data={"reason": reason, "retryable": False},
    )


@dataclass(frozen=True, slots=True)
class CommandProposalRequest:
    request_id: str
    trace_id: str | None
    session_id: str
    generation: int | None
    approval_mode: str
    turn_id: str
    operation_id: str
    proposal_id: str
    accepted_revision: int
    decision_id: str
    command_sha256: str
    tool_call_id: str
    execution_context: ExecutionContext
    continuation_context: ContinuationContext | None
    backend: str
    shell: str
    cwd: str
    command: str
    timeout_seconds: int
    expected_exit_codes: tuple[int, ...]
    purpose: str

    def tool_arguments(self) -> dict[str, Any]:
        """The exact ``run_command`` arguments: nothing added, nothing dropped."""
        return {
            "command": self.command,
            "cwd": self.cwd,
            "timeout_seconds": self.timeout_seconds,
            "expected_exit_codes": list(self.expected_exit_codes),
            "purpose": self.purpose,
        }


def _int(value: Any, field: str, *, minimum: int, maximum: int | None = None) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < minimum
        or (maximum is not None and value > maximum)
    ):
        raise CommandProposalRefusal(f"field_{field}")
    return value


def _token(value: Any, field: str) -> str:
    if not isinstance(value, str) or _TOKEN_RE.fullmatch(value) is None:
        raise CommandProposalRefusal(f"field_{field}")
    return value


def _closed(value: Any, keys: frozenset[str], field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CommandProposalRefusal(f"field_{field}")
    if set(value) != keys:
        raise CommandProposalRefusal("unknown_key" if set(value) - keys else f"field_{field}")
    return value


def _input(raw: Any) -> tuple[str, str, int, tuple[int, ...], str]:
    data = _closed(raw, _INPUT_KEYS, "input")
    command = data["command"]
    if (
        not isinstance(command, str)
        or not command.strip()
        or "\x00" in command
        or _INVISIBLE_RE.search(command)
        or len(command.encode("utf-8", errors="strict")) > MAX_COMMAND_BYTES
    ):
        raise CommandProposalRefusal("field_command")
    cwd = data["cwd"]
    if (
        not isinstance(cwd, str)
        or not cwd
        or "\x00" in cwd
        or _INVISIBLE_RE.search(cwd)
        or len(cwd) > MAX_CWD_CHARS
    ):
        raise CommandProposalRefusal("field_cwd")
    timeout = _int(
        data["timeout_seconds"], "timeout_seconds", minimum=1, maximum=MAX_TIMEOUT_SECONDS
    )
    codes = data["expected_exit_codes"]
    if (
        not isinstance(codes, list)
        or not 1 <= len(codes) <= MAX_EXPECTED_EXIT_CODES
        or len(set(codes)) != len(codes)
    ):
        raise CommandProposalRefusal("field_expected_exit_codes")
    exit_codes = tuple(_int(item, "expected_exit_codes", minimum=0, maximum=255) for item in codes)
    purpose = data["purpose"]
    if (
        not isinstance(purpose, str)
        or not purpose.strip()
        or "\x00" in purpose
        or len(purpose) > MAX_PURPOSE_CHARS
    ):
        raise CommandProposalRefusal("field_purpose")
    return command, cwd, timeout, exit_codes, purpose


def parse_command_proposal_params(  # noqa: C901, PLR0912, PLR0915
    params: Any,
) -> CommandProposalRequest:
    """Decode and bind one request; raise :class:`CommandProposalRefusal` on any fault."""
    if not isinstance(params, dict):
        raise CommandProposalRefusal("params_not_object")
    unknown = set(params) - _TOP_KEYS
    if unknown:
        raise CommandProposalRefusal("unknown_key")
    missing = _REQUIRED_KEYS - set(params)
    if missing:
        raise CommandProposalRefusal("missing_key")
    if params.get("api_version", API_VERSION) != API_VERSION:
        raise CommandProposalRefusal("api_version_mismatch")
    if _int(params["schema_version"], "schema_version", minimum=1, maximum=1) != SCHEMA_VERSION:
        raise CommandProposalRefusal("field_schema_version")
    if params.get("plan_mode", False) is not False or params.get("read_only", False) is not False:
        raise CommandProposalRefusal("read_only_or_plan_mode")
    request_id = _token(params["request_id"], "request_id")
    session_id = _token(params["session_id"], "session_id")
    trace_id = params.get("trace_id")
    if trace_id is not None:
        trace_id = _token(trace_id, "trace_id")
    generation = params.get("generation")
    if generation is not None:
        generation = _int(generation, "generation", minimum=1)
    approval_mode = params.get("approval_mode", "prompt")
    if approval_mode not in {"prompt", "auto_run"}:
        raise CommandProposalRefusal("field_approval_mode")
    try:
        turn_id = logical_turn_id_from_params({"logical_turn_id": params["turn_id"]}, request_id)
    except ValueError as error:
        raise CommandProposalRefusal("field_turn_id") from error
    for field in ("operation_id", "decision_id"):
        if not isinstance(params[field], str) or _UUID_RE.fullmatch(params[field]) is None:
            raise CommandProposalRefusal(f"field_{field}")
    proposal_id = _token(params["proposal_id"], "proposal_id")
    if len(proposal_id) > MAX_PROPOSAL_ID_CHARS:
        raise CommandProposalRefusal("field_proposal_id")
    accepted_revision = _int(params["accepted_revision"], "accepted_revision", minimum=1)
    sha = params["command_sha256"]
    if not isinstance(sha, str) or _SHA256_RE.fullmatch(sha) is None:
        raise CommandProposalRefusal("field_command_sha256")
    tool_call_id = _token(params["tool_call_id"], "tool_call_id")

    binding = _closed(params["binding"], _BINDING_KEYS, "binding")
    backend, shell = binding["backend"], binding["shell"]
    if backend not in BACKENDS or shell not in SHELLS:
        raise CommandProposalRefusal("binding_backend_or_shell")
    command, cwd, timeout, exit_codes, purpose = _input(params["input"])
    if binding["cwd"] != cwd:
        raise CommandProposalRefusal("cwd_mismatch")
    if hashlib.sha256(command.encode("utf-8")).hexdigest() != sha:
        raise CommandProposalRefusal("hash_mismatch")
    if backend == "docker" and (timeout > MAX_DOCKER_TIMEOUT_SECONDS or shell != "/bin/sh"):
        raise CommandProposalRefusal("docker_binding_limits")

    try:
        execution = execution_context_from_params(
            {"execution_context": params["execution_context"]}
        )
    except ValueError as error:
        raise CommandProposalRefusal("execution_context_invalid") from error
    if execution is None:
        raise CommandProposalRefusal("execution_context_required")
    if execution.root_path is None:
        raise CommandProposalRefusal("execution_context_unrooted")
    if binding["root_revision"] != execution.root_revision:
        raise CommandProposalRefusal("root_revision_mismatch")

    continuation = None
    if params.get("runtime_operation_context") is not None:
        try:
            continuation = continuation_context_from_params(
                {"continuation_context": params["runtime_operation_context"]},
                request_id=request_id,
                session_id=session_id,
                execution_context=execution,
            )
        except ValueError as error:
            raise CommandProposalRefusal("runtime_operation_context_invalid") from error
        if continuation is None or continuation.turn_id != turn_id:
            raise CommandProposalRefusal("runtime_operation_context_invalid")
    return CommandProposalRequest(
        request_id=request_id,
        trace_id=trace_id,
        session_id=session_id,
        generation=generation,
        approval_mode=approval_mode,
        turn_id=turn_id,
        operation_id=params["operation_id"],
        proposal_id=proposal_id,
        accepted_revision=accepted_revision,
        decision_id=params["decision_id"],
        command_sha256=sha,
        tool_call_id=tool_call_id,
        execution_context=execution,
        continuation_context=continuation,
        backend=backend,
        shell=shell,
        cwd=cwd,
        command=command,
        timeout_seconds=timeout,
        expected_exit_codes=exit_codes,
        purpose=purpose,
    )


__all__ = [
    "BACKENDS",
    "COMMAND_PROPOSAL_VERSION",
    "CommandProposalRefusal",
    "CommandProposalRequest",
    "MAX_DOCKER_TIMEOUT_SECONDS",
    "SHELLS",
    "parse_command_proposal_params",
    "refusal_error",
]
