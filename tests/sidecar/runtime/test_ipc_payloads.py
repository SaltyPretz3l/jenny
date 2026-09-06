"""Behavioral unit tests for sidecar.runtime.ipc_payloads."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from sidecar.runtime.ipc_payloads import (
    DEFAULT_MAX_INLINE_PAYLOAD_BYTES,
    IpcPayloadExternalizer,
    _clamp_max_inline_payload_bytes,
    _truncate_text_to_bytes,
)


# ---------------------------------------------------------------------------
# _clamp_max_inline_payload_bytes
# ---------------------------------------------------------------------------


class TestClampMaxInlinePayloadBytes:
    def test_in_range_value_is_returned_unchanged(self) -> None:
        assert _clamp_max_inline_payload_bytes(8192) == 8192

    def test_below_floor_returns_default(self) -> None:
        # 100 is below the 4096 floor so the default is returned
        result = _clamp_max_inline_payload_bytes(100)
        assert result == DEFAULT_MAX_INLINE_PAYLOAD_BYTES

    def test_above_ceiling_returns_default(self) -> None:
        # 5_000_000 exceeds the 2_097_152 ceiling
        result = _clamp_max_inline_payload_bytes(5_000_000)
        assert result == DEFAULT_MAX_INLINE_PAYLOAD_BYTES

    def test_non_numeric_returns_default(self) -> None:
        result = _clamp_max_inline_payload_bytes("x")
        assert result == DEFAULT_MAX_INLINE_PAYLOAD_BYTES

    def test_exact_floor_accepted(self) -> None:
        assert _clamp_max_inline_payload_bytes(4096) == 4096

    def test_exact_ceiling_accepted(self) -> None:
        assert _clamp_max_inline_payload_bytes(2_097_152) == 2_097_152


# ---------------------------------------------------------------------------
# _truncate_text_to_bytes
# ---------------------------------------------------------------------------


class TestTruncateTextToBytes:
    def test_short_text_returned_unchanged(self) -> None:
        assert _truncate_text_to_bytes("hello", 100) == "hello"

    def test_long_text_ends_with_truncation_suffix(self) -> None:
        long_text = "a" * 2000
        limit = 100
        result = _truncate_text_to_bytes(long_text, limit)
        assert result.endswith(" [truncated]")
        assert len(result.encode("utf-8")) <= limit

    def test_zero_limit_returns_empty_string(self) -> None:
        assert _truncate_text_to_bytes("anything", 0) == ""

    def test_negative_limit_returns_empty_string(self) -> None:
        assert _truncate_text_to_bytes("anything", -5) == ""


# ---------------------------------------------------------------------------
# IpcPayloadExternalizer.harden_tool_notification
# ---------------------------------------------------------------------------


class TestHardenToolNotification:
    def test_output_field_truncated_and_externalized(self, tmp_path: Path) -> None:
        ext = IpcPayloadExternalizer(root=tmp_path, max_inline_payload_bytes=20)
        big_value = "x" * 200
        out = ext.harden_tool_notification(
            method="tool.result",
            params={"output": big_value, "tool_input": "small"},
            request_id="req1",
        )

        # "output" must be a truncated string (not a dict), ending with the suffix
        assert isinstance(out["output"], str)
        assert out["output"].endswith(" [truncated]")

        # "tool_input" is small enough to stay inline unchanged
        assert out["tool_input"] == "small"

        # external payloads map must contain "output"
        ext_payloads = out["_external_payloads"]
        assert "output" in ext_payloads

        ref = ext_payloads["output"]
        assert set(ref.keys()) >= {"path", "bytes", "encoding", "format"}
        assert ref["encoding"] == "utf-8"
        assert ref["format"] == "json"
        assert ref["bytes"] > 20

        # The written file must exist and its "value" key must equal the original
        written_path = Path(ref["path"])
        assert written_path.exists()
        payload = json.loads(written_path.read_bytes())
        assert payload["value"] == big_value

    def test_method_not_in_map_returns_same_params_object(self, tmp_path: Path) -> None:
        ext = IpcPayloadExternalizer(root=tmp_path, max_inline_payload_bytes=20)
        p = {"some_key": "some_value"}
        out = ext.harden_tool_notification(
            method="chat.delta",
            params=p,
            request_id="r",
        )
        # Must be the exact same dict object — no copy made
        assert out is p

    def test_small_fields_not_externalized(self, tmp_path: Path) -> None:
        ext = IpcPayloadExternalizer(root=tmp_path, max_inline_payload_bytes=10_000)
        params = {"output": "tiny", "tool_input": "also tiny"}
        out = ext.harden_tool_notification(
            method="tool.result",
            params=params,
            request_id="req2",
        )
        # Nothing was oversized, so no external payloads key
        assert "_external_payloads" not in out
        assert out["output"] == "tiny"
        assert out["tool_input"] == "also tiny"

    def test_external_file_contains_request_id_and_field(self, tmp_path: Path) -> None:
        ext = IpcPayloadExternalizer(root=tmp_path, max_inline_payload_bytes=20)
        big_value = "z" * 300
        out = ext.harden_tool_notification(
            method="tool.result",
            params={"output": big_value},
            request_id="req-abc",
        )
        ref = out["_external_payloads"]["output"]
        payload = json.loads(Path(ref["path"]).read_bytes())
        assert payload["request_id"] == "req-abc"
        assert payload["field"] == "output"


# ---------------------------------------------------------------------------
# IpcPayloadExternalizer.from_config
# ---------------------------------------------------------------------------


class TestFromConfig:
    def test_from_config_sets_root_and_max_inline_bytes(self, tmp_path: Path) -> None:
        cfg = SimpleNamespace(
            background_runtime_root=str(tmp_path),
            max_inline_payload_bytes=8192,
        )
        externalizer = IpcPayloadExternalizer.from_config(cfg)
        assert externalizer.root == tmp_path / "ipc-payloads"
        assert externalizer.max_inline_payload_bytes == 8192

    def test_from_config_clamps_too_small_max_inline(self, tmp_path: Path) -> None:
        cfg = SimpleNamespace(
            background_runtime_root=str(tmp_path),
            max_inline_payload_bytes=100,  # below floor of 4096
        )
        externalizer = IpcPayloadExternalizer.from_config(cfg)
        assert externalizer.max_inline_payload_bytes == DEFAULT_MAX_INLINE_PAYLOAD_BYTES
