"""``_raise_for_error`` keeps the server's ``error.data`` detail, redacted.

It used to read only the structured keys of ``error.data`` and drop the rest,
so a third-party server's actual explanation never reached the raised error.
"""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.mcp.exceptions import MCPError, mcp_error_data_detail
from sidecar.ai.mcp.transport_stdio import StdioMCPTransport


def _transport() -> StdioMCPTransport:
    from tests.sidecar.ai.mcp.test_transport_stdio import _stub_transport
    return _stub_transport()


def _raise(data: Any) -> MCPError:
    response = {"jsonrpc": "2.0", "id": 1, "error": {"message": "tool failed", "data": data}}
    with pytest.raises(MCPError) as caught:
        _transport()._raise_for_error(response)  # type: ignore[attr-defined]
    return caught.value


def test_unstructured_error_data_reaches_the_raised_error_redacted() -> None:
    error = _raise(
        {
            "code": "CMP-MCP-9999",
            "retryable": True,
            "reason": "schema mismatch on field 'path'",
            "upstream": "api_key=secret-value rejected",
        }
    )

    assert error.code == "CMP-MCP-9999"
    assert error.retryable is True
    assert error.detail is not None
    assert "schema mismatch on field 'path'" in error.detail
    assert "secret-value" not in error.detail
    assert "[REDACTED]" in error.detail
    # Structured keys already travel as typed fields, not inside the detail.
    assert "CMP-MCP-9999" not in error.detail
    assert error.to_metadata()["detail"] == error.detail


def test_string_error_data_is_kept_as_detail() -> None:
    error = _raise("disk quota exceeded on /srv/data")
    assert error.detail == "disk quota exceeded on /srv/data"


def test_structured_only_or_missing_data_has_no_detail() -> None:
    for data in (None, {"code": "CMP-MCP-0002", "retryable": False}):
        error = _raise(data)
        assert error.detail is None
        assert "detail" not in error.to_metadata()


def test_error_data_detail_serializes_non_json_values() -> None:
    assert mcp_error_data_detail({"when": object}).startswith('{"when": ')
    assert mcp_error_data_detail([1, 2]) == "[1, 2]"
    assert mcp_error_data_detail({}) == ""
