"""Closed application-owned continuation identity for one ``chat.send``."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping, NoReturn

from sidecar.runtime.continuation_codec import (
    ContinuationCodecError,
    normalize_continuation_context_fields,
)
from sidecar.runtime.execution_context import ExecutionContext
from sidecar.runtime.runtime_ids import RuntimeIdError, parse_session_id

CONTINUATION_CONTEXT_SCHEMA_VERSION = 1
MAX_CONTINUATION_CONTEXT_BYTES = 16 * 1024

_CONTEXT_KEYS = frozenset(
    {"schema_version", "work_id", "turn_id", "source_attempt", "authority", "route"}
)


class ContinuationContextError(ValueError):
    """A present continuation context is malformed or mismatched."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _fail(code: str) -> NoReturn:
    raise ContinuationContextError(code)


@dataclass(frozen=True, slots=True)
class SourceAttempt:
    attempt_id: str
    stream_id: str
    incarnation: str
    authority_revision: str

    def to_wire(self) -> dict[str, str]:
        return {
            "attempt_id": self.attempt_id,
            "stream_id": self.stream_id,
            "incarnation": self.incarnation,
            "authority_revision": self.authority_revision,
        }


@dataclass(frozen=True, slots=True)
class AuthorityReference:
    project_id: str
    root_id: str | None
    root_revision: int
    sha256: str

    def to_wire(self) -> dict[str, str | int | None]:
        return {
            "project_id": self.project_id,
            "root_id": self.root_id,
            "root_revision": self.root_revision,
            "sha256": self.sha256,
        }


@dataclass(frozen=True, slots=True)
class RouteReference:
    route_id: str
    route_revision: str
    sha256: str

    def to_wire(self) -> dict[str, str]:
        return {
            "route_id": self.route_id,
            "route_revision": self.route_revision,
            "sha256": self.sha256,
        }


@dataclass(frozen=True, slots=True)
class ContinuationContext:
    schema_version: int
    work_id: str
    turn_id: str
    source_attempt: SourceAttempt
    authority: AuthorityReference
    route: RouteReference
    enclosing_session_id: str

    def to_wire(self) -> dict[str, Any]:
        """Return a fresh exact v1 wire object without its enclosing binding."""

        return {
            "schema_version": self.schema_version,
            "work_id": self.work_id,
            "turn_id": self.turn_id,
            "source_attempt": self.source_attempt.to_wire(),
            "authority": self.authority.to_wire(),
            "route": self.route.to_wire(),
        }


def _bounded_canonical_size(value: Mapping[str, Any]) -> None:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError, OverflowError) as error:
        raise ContinuationContextError("invalid_continuation_context_encoding") from error
    if len(encoded) > MAX_CONTINUATION_CONTEXT_BYTES:
        _fail("continuation_context_capacity")


def continuation_context_from_params(
    params: Any,
    *,
    request_id: str,
    session_id: str | None,
    execution_context: ExecutionContext | None,
) -> ContinuationContext | None:
    """Parse and bind a present v1 context to its enclosing trusted request."""

    if not isinstance(params, dict) or "continuation_context" not in params:
        return None
    value = params.get("continuation_context")
    if not isinstance(value, Mapping) or isinstance(value, (str, bytes, bytearray)):
        _fail("invalid_continuation_context")
    if any(not isinstance(key, str) for key in value) or set(value) != _CONTEXT_KEYS:
        _fail("invalid_continuation_context_keys")
    _bounded_canonical_size(value)
    schema_version = value["schema_version"]
    if isinstance(schema_version, bool) or schema_version != CONTINUATION_CONTEXT_SCHEMA_VERSION:
        _fail("unsupported_continuation_context_schema_version")
    if not isinstance(execution_context, ExecutionContext):
        _fail("continuation_execution_context_required")
    try:
        trusted_session_id = parse_session_id(session_id)
    except RuntimeIdError as error:
        raise ContinuationContextError("continuation_session_id_required") from error
    try:
        normalized = normalize_continuation_context_fields(
            work_id=value["work_id"],
            turn_id=value["turn_id"],
            source_attempt=value["source_attempt"],
            authority=value["authority"],
            route=value["route"],
        )
    except ContinuationCodecError as error:
        raise ContinuationContextError(error.code) from error

    attempt = normalized["source_attempt"]
    authority = normalized["authority"]
    if request_id != attempt["stream_id"]:
        _fail("continuation_request_stream_mismatch")
    if attempt["authority_revision"] != execution_context.authority_revision:
        _fail("continuation_authority_revision_mismatch")
    if (
        authority["project_id"] != execution_context.project_id
        or authority["root_id"] != execution_context.root_id
        or authority["root_revision"] != execution_context.root_revision
    ):
        _fail("continuation_authority_mismatch")

    return ContinuationContext(
        schema_version=CONTINUATION_CONTEXT_SCHEMA_VERSION,
        work_id=normalized["work_id"],
        turn_id=normalized["turn_id"],
        source_attempt=SourceAttempt(**attempt),
        authority=AuthorityReference(**authority),
        route=RouteReference(**normalized["route"]),
        enclosing_session_id=trusted_session_id,
    )


__all__ = [
    "AuthorityReference",
    "CONTINUATION_CONTEXT_SCHEMA_VERSION",
    "ContinuationContext",
    "ContinuationContextError",
    "MAX_CONTINUATION_CONTEXT_BYTES",
    "RouteReference",
    "SourceAttempt",
    "continuation_context_from_params",
]
