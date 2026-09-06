"""Red-first: derived idempotency keys (W5, spec §3.2).

The key names one LOGICAL operation, stable across attempts, and is derived —
never model-supplied. It binds post-alias-collapse arguments so `{"path": x}`
and `{"file_path": x}` name the same operation.
"""

from __future__ import annotations

import re

from sidecar.ai.routing.tool_execution import (
    derive_idempotency_key,
    inject_idempotency_key,
)
from sidecar.ai.routing.tool_observation import _VOLATILE_TOOL_ARGUMENT_KEYS
from sidecar.ai.tools.contracts import canonicalize_tool_arguments
from sidecar.ai.tools.models import ToolCallRequest

_KEY_RE = re.compile(r"^idem_[0-9a-f]{24}$")


def _derive(**overrides) -> str:
    payload = {
        "session_id": "session-1",
        "request_id": "req-7",
        "call_id": "call_a",
        "tool_id": "write_file",
        "canonical_arguments": {"path": "src/foo.py", "content": "x"},
    }
    payload.update(overrides)
    return derive_idempotency_key(**payload)


def test_key_shape_is_prefixed_24_hex() -> None:
    assert _KEY_RE.match(_derive())


def test_key_is_deterministic_across_attempts() -> None:
    assert _derive() == _derive()


def test_key_binds_post_alias_collapse_arguments() -> None:
    canonical, _ = canonicalize_tool_arguments(
        tool_name="write_file", arguments={"path": "src/foo.py", "content": "x"}
    )
    aliased, _ = canonicalize_tool_arguments(
        tool_name="write_file", arguments={"file_path": "src/foo.py", "content": "x"}
    )
    assert _derive(canonical_arguments=canonical) == _derive(canonical_arguments=aliased)


def test_key_is_insensitive_to_argument_key_order() -> None:
    forward = {"path": "src/foo.py", "content": "x"}
    reversed_order = {"content": "x", "path": "src/foo.py"}
    assert _derive(canonical_arguments=forward) == _derive(
        canonical_arguments=reversed_order
    )


def test_key_differs_per_call_and_per_tool_and_per_session() -> None:
    base = _derive()
    assert _derive(call_id="call_b") != base
    assert _derive(tool_id="edit_file") != base
    assert _derive(session_id="session-2") != base
    assert _derive(request_id="req-8") != base
    assert _derive(canonical_arguments={"path": "src/bar.py", "content": "x"}) != base


class _Descriptor:
    def __init__(self, *, source_kind: str, side_effecting: bool) -> None:
        self.source_kind = source_kind
        self.side_effecting = side_effecting


def _call() -> ToolCallRequest:
    return ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "src/foo.py", "content": "x"},
        call_id="call_a",
    )


class _Runtime:
    trace_id = "trace-1"
    session_id = "session-1"
    request_id = "req-7"


def test_injects_for_builtin_side_effecting_only() -> None:
    arguments = {"path": "src/foo.py", "content": "x"}
    out = inject_idempotency_key(
        dict(arguments),
        descriptor=_Descriptor(source_kind="builtin", side_effecting=True),
        runtime=_Runtime(),
        call=_call(),
    )
    assert _KEY_RE.match(str(out.get("_jenny_idempotency_key", "")))


def test_never_injects_for_mcp_or_read_only() -> None:
    arguments = {"path": "src/foo.py", "content": "x"}
    for descriptor in (
        _Descriptor(source_kind="mcp", side_effecting=True),
        _Descriptor(source_kind="builtin", side_effecting=False),
        None,
    ):
        out = inject_idempotency_key(
            dict(arguments),
            descriptor=descriptor,
            runtime=_Runtime(),
            call=_call(),
        )
        assert "_jenny_idempotency_key" not in out


def test_injected_key_is_redacted_from_tool_observations() -> None:
    assert "_jenny_idempotency_key" in _VOLATILE_TOOL_ARGUMENT_KEYS
