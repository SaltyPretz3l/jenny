"""Strict internal boundary for one checkpoint-restored first tool input."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping, NoReturn

from sidecar.ai.routing.tool_execution_snapshots import split_visible_execution_arguments
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.approval_plan import (
    SIDECAR_INJECTED_ARG_KEYS,
    FrozenExecutionInputs,
    stable_hash,
)

MAX_RESTORED_TOOL_INPUT_BYTES = 1024 * 1024
_MIN_RESTORED_TOOL_INPUT_BYTES = 2

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_TOOL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_FROZEN_KEYS = frozenset({
    "call_id", "effective_args_fingerprint", "effective_tool_arguments",
    "execution_context_payload", "injected_arg_keys", "tool_name",
    "visible_tool_arguments",
})
_CONTEXT_KEYS = frozenset({
    "session_id", "logical_turn_id", "authority_revision", "project_id", "root_id",
    "root_revision",
    "_jenny_turn_id", "_jenny_tool_call_id", "_jenny_change_set_id", "read_only",
    "plan_artifact_write", "expected_read_snapshot",
})
_REQUIRED_SCOPE_KEYS = frozenset({
    "session_id", "logical_turn_id", "authority_revision", "project_id", "root_id",
    "root_revision",
})
_ATTRIBUTION_KEYS = (
    "_jenny_turn_id", "_jenny_tool_call_id", "_jenny_change_set_id",
)


class RestoredToolInputError(ValueError):
    """The saved first input is malformed, foreign, or stale."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _fail(code: str) -> NoReturn:
    raise RestoredToolInputError(code)


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("duplicate_restored_tool_input_key")
        result[key] = value
    return result


def _canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as error:
        raise RestoredToolInputError("invalid_restored_tool_input_json") from error


def _decode(body: bytes, digest: str) -> dict[str, Any]:
    if (
        not isinstance(body, bytes)
        or not _MIN_RESTORED_TOOL_INPUT_BYTES <= len(body) <= MAX_RESTORED_TOOL_INPUT_BYTES
        or not isinstance(digest, str)
        or _SHA256.fullmatch(digest) is None
        or hashlib.sha256(body).hexdigest() != digest
    ):
        _fail("invalid_restored_tool_input_bytes")
    try:
        value = json.loads(
            body.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda _value: _fail("invalid_restored_tool_input_number"),
        )
        canonical = _canonical_json(value)
    except RestoredToolInputError:
        raise
    except (
        UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, OverflowError,
    ) as error:
        raise RestoredToolInputError("invalid_restored_tool_input_json") from error
    if canonical != body or not isinstance(value, dict) or set(value) != _FROZEN_KEYS:
        _fail("invalid_restored_tool_input_shape")
    return value


def _frozen(value: Mapping[str, Any]) -> FrozenExecutionInputs:
    visible = value["visible_tool_arguments"]
    effective = value["effective_tool_arguments"]
    injected = value["injected_arg_keys"]
    context = value["execution_context_payload"]
    fingerprint = value["effective_args_fingerprint"]
    injected_set = (
        set(injected)
        if isinstance(injected, list) and all(isinstance(key, str) for key in injected)
        else set()
    )
    if (
        not isinstance(value["call_id"], str)
        or _ID.fullmatch(value["call_id"]) is None
        or not isinstance(value["tool_name"], str)
        or _TOOL_ID.fullmatch(value["tool_name"]) is None
        or not isinstance(visible, dict)
        or not isinstance(effective, dict)
        or not isinstance(injected, list)
        or any(not isinstance(key, str) for key in injected)
        or len(set(injected)) != len(injected)
        or injected != sorted(injected)
        or not injected_set.issubset(SIDECAR_INJECTED_ARG_KEYS)
        or set(effective) != set(visible).union(injected_set)
        or _canonical_json({key: effective[key] for key in visible})
        != _canonical_json(visible)
        or not isinstance(context, dict)
        or set(context).difference(_CONTEXT_KEYS)
        or not _REQUIRED_SCOPE_KEYS.issubset(context)
        or any(
            not isinstance(context[key], str) or _ID.fullmatch(context[key]) is None
            for key in ("session_id", "logical_turn_id", "authority_revision", "project_id")
        )
        or (
            context["root_id"] is not None
            and (
                not isinstance(context["root_id"], str)
                or _ID.fullmatch(context["root_id"]) is None
            )
        )
        or isinstance(context["root_revision"], bool)
        or not isinstance(context["root_revision"], int)
        or context["root_revision"] < 0
        or any(
            key in context
            and (
                not isinstance(context[key], str)
                or _ID.fullmatch(context[key]) is None
            )
            for key in _ATTRIBUTION_KEYS
        )
        or not isinstance(fingerprint, str)
        or _SHA256.fullmatch(fingerprint) is None
        or stable_hash(effective) != fingerprint
    ):
        _fail("invalid_restored_tool_input")
    return FrozenExecutionInputs(
        call_id=value["call_id"],
        tool_name=value["tool_name"],
        visible_tool_arguments=visible,
        effective_tool_arguments=effective,
        injected_arg_keys=tuple(injected),
        effective_args_fingerprint=fingerprint,
        execution_context_payload=context,
    )


@dataclass(frozen=True, slots=True)
class RestoredToolInputs:
    """Exact source bytes plus strict binding for one resumed first call."""

    canonical_bytes: bytes
    source_sha256: str

    def __post_init__(self) -> None:
        _frozen(_decode(self.canonical_bytes, self.source_sha256))

    @classmethod
    def from_canonical_bytes(cls, body: bytes, sha256: str) -> RestoredToolInputs:
        return cls(canonical_bytes=body, source_sha256=sha256)

    def source_frozen_inputs(self) -> FrozenExecutionInputs:
        """Return a fresh parsed source value without exposing mutable aliases."""

        return _frozen(_decode(self.canonical_bytes, self.source_sha256))

    def bind_for_attempt(  # noqa: PLR0913
        self,
        *,
        call: ToolCallRequest,
        session_id: str | None,
        logical_turn_id: str | None,
        execution_context: Any,
    ) -> FrozenExecutionInputs:
        """Validate source scope and rebind only current authority revision metadata."""

        source = self.source_frozen_inputs()
        visible, _attribution = split_visible_execution_arguments(call)
        normalized_session = str(session_id or "").strip()
        normalized_turn = str(logical_turn_id or "").strip()
        payload = source.execution_context_payload
        project_id = getattr(execution_context, "project_id", None)
        root_id = getattr(execution_context, "root_id", None)
        root_revision = getattr(execution_context, "root_revision", None)
        authority_revision = getattr(execution_context, "authority_revision", None)
        if (
            source.call_id != str(call.call_id or "").strip()
            or source.tool_name != str(call.tool_id or "").strip()
            or _canonical_json(source.visible_tool_arguments) != _canonical_json(visible)
            or _ID.fullmatch(normalized_session) is None
            or _ID.fullmatch(normalized_turn) is None
            or payload["session_id"] != normalized_session
            or payload["logical_turn_id"] != normalized_turn
            or not isinstance(project_id, str)
            or _ID.fullmatch(project_id) is None
            or payload["project_id"] != project_id
            or (
                root_id is not None
                and (not isinstance(root_id, str) or _ID.fullmatch(root_id) is None)
            )
            or payload["root_id"] != root_id
            or isinstance(root_revision, bool)
            or not isinstance(root_revision, int)
            or payload["root_revision"] != root_revision
        ):
            _fail("restored_tool_input_scope_mismatch")
        effective = source.effective_tool_arguments
        for key, expected in (
            ("_jenny_session_id", normalized_session),
            ("_jenny_turn_id", normalized_turn),
            ("_jenny_tool_call_id", source.call_id),
        ):
            if key in effective and effective[key] != expected:
                _fail("restored_tool_input_attribution_mismatch")
        for key in _ATTRIBUTION_KEYS:
            if key in payload and payload[key] != effective.get(key):
                _fail("restored_tool_input_attribution_mismatch")
        if (
            not isinstance(authority_revision, str)
            or _ID.fullmatch(authority_revision) is None
        ):
            _fail("restored_tool_input_authority_invalid")
        rebound_payload = dict(payload)
        rebound_payload["authority_revision"] = authority_revision
        return FrozenExecutionInputs(
            call_id=source.call_id,
            tool_name=source.tool_name,
            visible_tool_arguments=dict(source.visible_tool_arguments),
            effective_tool_arguments=dict(effective),
            injected_arg_keys=tuple(source.injected_arg_keys),
            effective_args_fingerprint=source.effective_args_fingerprint,
            execution_context_payload=rebound_payload,
        )


__all__ = [
    "MAX_RESTORED_TOOL_INPUT_BYTES",
    "RestoredToolInputError",
    "RestoredToolInputs",
]
