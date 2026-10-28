"""WIDE-019/021: typed trusted-attachment pipeline tests.

Covers the fail-closed admission matrix, the aggregate decoded-byte cap and
its relationship to the outbound queue ceiling, the no-base64 invariant on
sanitized model-visible output, and refs-only persistence in canonical turn
events.
"""

from __future__ import annotations

import base64
import json
import re
import struct
import zlib
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.mcp.models import MCPToolResult
from sidecar.ai.routing.loop_events import ToolResultEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_execution import (
    execute_tool,
    tool_outcome_from_handler_result,
)
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.trusted_attachments import (
    TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES,
    admit_trusted_attachments,
    attachment_refs,
    base64_encoded_length,
    build_trusted_attachment,
    parse_wire_attachments,
    strip_attachment_shaped_metadata,
)
from sidecar.runtime.chat_serialization import (
    _serialize_loop_event,
    _serialize_turn_event,
)
from sidecar.runtime.multiplexer import _OUTPUT_HIGH_WATER_MARK_BYTES

_BASE64_RUN_RE = re.compile(r"[A-Za-z0-9+/=]{100,}")


def _jpeg_bytes(byte_length: int, *, width: int = 10, height: int = 10) -> bytes:
    """SOI, a baseline SOF0 frame header with the given size, filler, EOI."""
    sof = (b"\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big")
           + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01")
    head = b"\xff\xd8" + sof
    return head + b"j" * (byte_length - len(head) - 2) + b"\xff\xd9"


def _png_bytes(width: int = 2, height: int = 3) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        crc = struct.pack(">I", zlib.crc32(kind + payload))
        return struct.pack(">I", len(payload)) + kind + payload + crc

    rows = b"".join(b"\x00" + b"\x00\x00\x00" * width for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows))
            + chunk(b"IEND", b""))


def _attachment(*, byte_length: int = 64, kind: str = "image") -> dict[str, Any]:
    return build_trusted_attachment(
        kind=kind,
        mime_type="image/jpeg",
        data=_jpeg_bytes(byte_length),
        source_tool="read_file",
        width=10,
        height=10,
    )


# ---------------------------------------------------------------------------
# Admission matrix (design point 2)
# ---------------------------------------------------------------------------


def test_admission_admits_builtin_read_file() -> None:
    admitted = admit_trusted_attachments(
        attachments=[_attachment()],
        tool_id="read_file",
        source_kind="builtin",
    )
    assert len(admitted) == 1
    assert admitted[0]["kind"] == "image"


def test_admission_admits_builtin_python_execute() -> None:
    attachment = build_trusted_attachment(
        kind="chart",
        mime_type="image/png",
        data=_png_bytes(),
        source_tool="python_execute",
    )
    admitted = admit_trusted_attachments(
        attachments=[attachment],
        tool_id="python_execute",
        source_kind="builtin",
    )
    assert len(admitted) == 1


def _admit_image(data: bytes, mime_type: str, width: int, height: int) -> tuple[dict[str, Any], ...]:
    attachment = build_trusted_attachment(
        kind="image", mime_type=mime_type, data=data, source_tool="read_file",
        width=width, height=height,
    )
    return admit_trusted_attachments(
        attachments=[attachment], tool_id="read_file", source_kind="builtin"
    )


def _webp_vp8l(width: int, height: int) -> bytes:
    bits = (width - 1) | ((height - 1) << 14)
    payload = b"\x2f" + bits.to_bytes(4, "little") + b"\x00" * 16
    chunk = b"VP8L" + len(payload).to_bytes(4, "little") + payload
    return b"RIFF" + (4 + len(chunk)).to_bytes(4, "little") + b"WEBP" + chunk


def _webp_vp8x(width: int, height: int) -> bytes:
    payload = b"\x00" * 4 + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
    chunk = b"VP8X" + len(payload).to_bytes(4, "little") + payload
    return b"RIFF" + (4 + len(chunk)).to_bytes(4, "little") + b"WEBP" + chunk


@pytest.mark.parametrize(
    ("data", "mime_type", "width", "height"),
    [
        (_png_bytes(2, 3), "image/png", 2, 3),
        (_png_bytes(2, 3), "image/png", 0, 0),  # undeclared dimensions (charts) stay 0 x 0
        (_jpeg_bytes(256, width=640, height=480), "image/jpeg", 640, 480),
        (_webp_vp8l(5, 7), "image/webp", 5, 7),
        (_webp_vp8x(1200, 900), "image/webp", 1200, 900),
    ],
)
def test_admission_accepts_signature_and_declared_size_that_match(
    data: bytes, mime_type: str, width: int, height: int
) -> None:
    admitted = _admit_image(data, mime_type, width, height)
    assert len(admitted) == 1
    assert (admitted[0]["width"], admitted[0]["height"]) == (width, height)


@pytest.mark.parametrize(
    ("data", "mime_type"),
    [
        (b"\x00arbitrary bytes, not an image\x00" * 4, "image/png"),
        (_png_bytes(2, 3), "image/jpeg"),  # a real PNG labelled as JPEG
        (_jpeg_bytes(256, width=2, height=3), "image/webp"),
        (b"RIFF\x10\x00\x00\x00WAVEfmt " + b"\x00" * 24, "image/webp"),
        (b"\xff\xd8\xff\xda\x00\x08" + b"\x00" * 40, "image/jpeg"),  # a scan before any frame
    ],
)
def test_admission_rejects_bytes_that_do_not_carry_the_declared_format(
    data: bytes, mime_type: str
) -> None:
    assert _admit_image(data, mime_type, 2, 3) == ()


def test_admission_rejects_a_declared_size_that_differs_from_the_pixels() -> None:
    assert _admit_image(_png_bytes(2, 3), "image/png", 3, 2) == ()
    assert _admit_image(_jpeg_bytes(256, width=10, height=10), "image/jpeg", 4096, 4096) == ()


def test_admission_rejects_dimensions_past_the_vision_pixel_cap() -> None:
    header = struct.pack(">IIBBBBB", 10_000, 10_000, 8, 2, 0, 0, 0)
    oversized = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR" + header + b"\x00" * 16
    assert _admit_image(oversized, "image/png", 10_000, 10_000) == ()


def test_admission_strips_external_mcp_spoof_and_logs(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level("WARNING"):
        admitted = admit_trusted_attachments(
            attachments=[_attachment()],
            tool_id="mcp__evil__read_file",
            source_kind="mcp",
        )
    assert admitted == ()
    assert any("spoof" in record.message.lower() or "dropped" in record.message.lower()
               for record in caplog.records)


def test_admission_strips_electron_source_tools() -> None:
    admitted = admit_trusted_attachments(
        attachments=[_attachment()],
        tool_id="worktree_create",
        source_kind="mcp",
    )
    assert admitted == ()


def test_admission_strips_non_builtin_source_even_for_allowed_tool_id() -> None:
    # A malicious MCP server namespaced (or aliased) to look like read_file
    # still fails the source_kind half of the AND.
    admitted = admit_trusted_attachments(
        attachments=[_attachment()],
        tool_id="read_file",
        source_kind="mcp",
    )
    assert admitted == ()


def test_admission_strips_builtin_source_for_unlisted_tool_id() -> None:
    admitted = admit_trusted_attachments(
        attachments=[_attachment()],
        tool_id="grep_files",
        source_kind="builtin",
    )
    assert admitted == ()


def test_synthetic_handler_results_never_carry_attachments() -> None:
    """The synthetic/replay path (tool_outcome_from_handler_result) leaves the
    typed field empty and strips attachment-shaped metadata, even when a
    handler result smuggles both."""
    result = ToolHandlerResult(
        output="synthetic output",
        success=True,
        metadata={"trusted_attachments": [_attachment()], "other": 1},
        trusted_attachments=(_attachment(),),
    )

    outcome = tool_outcome_from_handler_result("tool_search", result, call_id="c1")

    assert outcome.trusted_attachments == ()
    assert "trusted_attachments" not in outcome.metadata
    assert outcome.metadata["other"] == 1


# ---------------------------------------------------------------------------
# Aggregate cap + complete-encoding invariant (design points 4 and 8)
# ---------------------------------------------------------------------------


def test_aggregate_cap_refuses_two_mib_plus_one_whole() -> None:
    oversize = _attachment(byte_length=TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES + 1)
    admitted = admit_trusted_attachments(
        attachments=[oversize],
        tool_id="read_file",
        source_kind="builtin",
    )
    # Refused WHOLE — nothing partial, no truncated encoding anywhere.
    assert admitted == ()


def test_aggregate_cap_drops_excess_attachment_whole_keeps_earlier_complete() -> None:
    first = _attachment(byte_length=TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES - 1024)
    second = _attachment(byte_length=64 * 1024)
    admitted = admit_trusted_attachments(
        attachments=[first, second],
        tool_id="read_file",
        source_kind="builtin",
    )
    assert len(admitted) == 1
    assert admitted[0]["id"] == first["id"]
    # Complete-encoding invariant: the survivor decodes exactly, end to end.
    decoded = base64.b64decode(admitted[0]["data_base64"], validate=True)
    assert len(decoded) == admitted[0]["byte_length"]
    assert decoded.endswith(b"\xff\xd9")


def test_admission_drops_truncated_encoding() -> None:
    """A sliced (incomplete) base64 payload must never be admitted."""
    attachment = _attachment(byte_length=1200)
    attachment["data_base64"] = attachment["data_base64"][:900]  # simulated mid-stream slice
    admitted = admit_trusted_attachments(
        attachments=[attachment],
        tool_id="read_file",
        source_kind="builtin",
    )
    assert admitted == ()


def test_wire_base64_of_full_budget_fits_outbound_queue_ceiling() -> None:
    """Design point 4: the base64 wire form of the full 2 MiB decoded budget
    must stay under the sidecar's 4 MiB outbound queue high-water mark, with
    real headroom for the rest of the tool.result payload."""
    wire_bytes = base64_encoded_length(TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES)
    assert wire_bytes < _OUTPUT_HIGH_WATER_MARK_BYTES
    # Leave at least 1 MiB of headroom for output/metadata/envelope fields.
    assert _OUTPUT_HIGH_WATER_MARK_BYTES - wire_bytes >= 1024 * 1024


# ---------------------------------------------------------------------------
# execute_tool end-to-end: admission + sanitized-output oracle (points 2, 3)
# ---------------------------------------------------------------------------


def _fake_kernel(descriptor: Any, result: MCPToolResult) -> SimpleNamespace:
    return SimpleNamespace(
        _config=SimpleNamespace(
            tools_execution_timeout_seconds=30.0,
            tools_workspace_root=None,
        ),
        _active_cancel_handle=None,
        _mcp_client=SimpleNamespace(
            tool_descriptor=lambda _name: descriptor,
            execute_tool=lambda *_args, **_kwargs: result,
        ),
    )


def _media_result(tool_name: str, attachments: list[dict[str, Any]]) -> MCPToolResult:
    inline_data_uri = "data:image/png;base64," + ("A" * 400)
    return MCPToolResult(
        tool_name=tool_name,
        output=json.dumps({"kind": "image", "note": f"inline {inline_data_uri}"}),
        success=True,
        metadata={"kind": "image", "trusted_attachments": [{"spoofed": True}]},
        trusted_attachments=tuple(attachments),
    )


def _execute(tool_id: str, descriptor: Any, result: MCPToolResult):
    return execute_tool(
        _fake_kernel(descriptor, result),
        ToolCallRequest(tool_id=tool_id, arguments={"path": "x.png"}, call_id="call-att-1"),
        request_id="req-att-1",
        session_id="sess-att-1",
        read_snapshot_cache={},
    )


def test_execute_tool_admits_builtin_read_file_attachments_and_sanitizes_output() -> None:
    descriptor = SimpleNamespace(
        name="read_file",
        side_effecting=False,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        source_kind="builtin",
        server_name="jenny_builtin_tools",
    )
    attachment = _attachment(byte_length=2048)
    outcome = _execute("read_file", descriptor, _media_result("read_file", [attachment]))

    assert len(outcome.trusted_attachments) == 1
    assert outcome.trusted_attachments[0]["id"] == attachment["id"]
    # Design point 3: NO base64 in the sanitized model-visible output — the
    # inline data URI planted in the raw output must have been stripped.
    assert not _BASE64_RUN_RE.search(outcome.output)
    assert "INLINE_DATA_URI_STRIPPED" in outcome.output
    # Spoofed attachment-shaped metadata never survives.
    assert "trusted_attachments" not in outcome.metadata


def test_execute_tool_strips_attachments_from_external_mcp_result() -> None:
    descriptor = SimpleNamespace(
        name="mcp__files__read_file",
        side_effecting=False,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        source_kind="mcp",
        server_name="files",
    )
    outcome = _execute(
        "mcp__files__read_file",
        descriptor,
        _media_result("mcp__files__read_file", [_attachment()]),
    )

    assert outcome.trusted_attachments == ()
    assert "trusted_attachments" not in outcome.metadata


def test_execute_tool_strips_attachments_from_electron_bridge_result(tmp_path) -> None:
    descriptor = SimpleNamespace(
        name="worktree_create",
        side_effecting=True,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        source_kind="mcp",
        server_name="electron_tool_bridge",
    )
    result = _media_result("worktree_create", [_attachment()])
    runtime = LoopRuntime(
        request_id="req-att-el",
        trace_id="trace-att-el",
        session_id="sess-att-el",
        electron_tool_writer=lambda _message: None,
        electron_tool_reader=lambda _timeout: {},
        electron_tool_reader_factory=lambda expected_id, **_kwargs: (
            lambda _timeout_seconds: {
                "jsonrpc": "2.0",
                "id": expected_id,
                "result": {
                    "tool_name": "worktree_create",
                    "output": "captured",
                    "success": True,
                    "trusted_attachments": [dict(_attachment())],
                },
            }
        ),
    )
    outcome = execute_tool(
        _fake_kernel(descriptor, result),
        ToolCallRequest(
            tool_id="worktree_create",
            arguments={"path": "x.png"},
            call_id="call-att-el",
        ),
        request_id="req-att-el",
        session_id="sess-att-el",
        read_snapshot_cache={},
        runtime=runtime,
    )

    assert outcome.trusted_attachments == ()


# ---------------------------------------------------------------------------
# Live notification vs canonical turn event (design points 1 and 5)
# ---------------------------------------------------------------------------


def _tool_result_event(attachment: dict[str, Any]) -> ToolResultEvent:
    return ToolResultEvent(
        call_id="call-ser-1",
        tool_name="read_file",
        success=True,
        content="image summary",
        tool_input={"path": "x.png"},
        trusted_attachments=(attachment,),
    )


def test_tool_result_notification_carries_full_typed_attachments() -> None:
    attachment = _attachment(byte_length=512)
    payload = _serialize_loop_event(
        _tool_result_event(attachment),
        "req-ser-1",
        trace_id="trace-ser-1",
        session_id="sess-ser-1",
    )

    assert payload is not None and payload["method"] == "tool.result"
    wire = payload["params"]["trusted_attachments"]
    assert wire[0]["id"] == attachment["id"]
    assert wire[0]["data_base64"] == attachment["data_base64"]
    # snake_case wire keys.
    assert set(wire[0]) >= {"id", "kind", "mime_type", "data_base64", "byte_length"}


def test_canonical_turn_event_persists_refs_only_across_round_trip() -> None:
    attachment = _attachment(byte_length=512)
    payload = _serialize_turn_event(
        _tool_result_event(attachment),
        "req-ser-2",
        trace_id="trace-ser-2",
        session_id="sess-ser-2",
        seq=7,
    )

    assert payload is not None
    # Persist/rehydrate round trip: what is stored is what JSON preserves.
    rehydrated = json.loads(json.dumps(payload))
    event_payload = rehydrated["params"]["payload"]
    refs = event_payload["trusted_attachment_refs"]
    assert refs[0]["id"] == attachment["id"]
    assert refs[0]["byte_length"] == attachment["byte_length"]
    assert refs[0]["kind"] == "image"
    # NEVER raw bytes/base64 in the persisted event — neither the field nor
    # any base64-looking run anywhere in the serialized turn event.
    assert "data_base64" not in refs[0]
    assert not _BASE64_RUN_RE.search(json.dumps(rehydrated))


def test_attachment_refs_never_include_payload_fields() -> None:
    refs = attachment_refs([_attachment(byte_length=256)])
    assert refs and "data_base64" not in refs[0] and "source_tool" not in refs[0]


# ---------------------------------------------------------------------------
# Wire parsing + metadata stripping primitives
# ---------------------------------------------------------------------------


def test_parse_wire_attachments_keeps_only_dict_entries() -> None:
    parsed = parse_wire_attachments([{"id": "a"}, "junk", 7, None, {"id": "b"}])
    assert parsed == ({"id": "a"}, {"id": "b"})
    assert parse_wire_attachments("not-a-list") == ()


def test_strip_attachment_shaped_metadata_removes_reserved_key() -> None:
    metadata = {"trusted_attachments": [{"x": 1}], "keep": True}
    cleaned = strip_attachment_shaped_metadata(metadata)
    assert cleaned == {"keep": True}
    # No mutation of the original and a no-op passthrough without the key.
    assert "trusted_attachments" in metadata
    untouched = {"keep": True}
    assert strip_attachment_shaped_metadata(untouched) is untouched
