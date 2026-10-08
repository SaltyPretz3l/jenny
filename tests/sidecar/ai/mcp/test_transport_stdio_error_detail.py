"""``_raise_for_error`` keeps the server's ``error.data`` detail, redacted.

It used to read only the structured keys of ``error.data`` and drop the rest,
so a third-party server's actual explanation never reached the raised error.
"""

from __future__ import annotations

import json
import logging
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


# Row 34 S2: the builtin server's ``observed_changes`` travels as a typed field,
# never inside ``detail``, ``to_metadata()`` or a log line.
def _review(**overrides: object) -> dict[str, object]:
    return {
        "schema_version": 1, "state": "observed", "certainty": "observed_during_call",
        "call_outcome": "failed", "changed_paths": ["a.py"], "changed_path_count": 1,
        "diff_count": 1, "summary_only_count": 0, "omitted_count": 0,
        "coverage": "git_status_paths", **overrides,
    }


def test_observed_changes_map_to_a_typed_field_kept_out_of_metadata_and_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    diffs = [{"diff_id": "scripted:op:0", "path": "a.py", "hunks": [{"lines": ["+BODY_MARK"]}]}]
    error = _raise({
        "code": "CMP-TOOL-0001",
        "observed_changes": {"diffs": diffs, "scripted_change_review": _review(), "extra": 1},
    })

    assert error.observed_changes == {"diffs": diffs, "scripted_change_review": _review()}
    assert error.detail is None
    assert "observed_changes" not in error.to_metadata()
    assert "BODY_MARK" not in json.dumps(error.to_metadata())
    assert "BODY_MARK" not in caplog.text


def test_an_oversize_observed_changes_payload_degrades_to_an_unavailable_review() -> None:
    body = "+" + "x" * (600 * 1024)
    diffs = [{"diff_id": "scripted:op:0", "path": "a.py", "hunks": [{"lines": [body]}]}]

    error = _raise({"observed_changes": {"diffs": diffs, "scripted_change_review": _review()}})

    assert error.observed_changes is not None
    assert "diffs" not in error.observed_changes
    review = error.observed_changes["scripted_change_review"]
    assert (review["state"], review["reason"]) == ("unavailable", "payload_over_limit")
    assert review["call_outcome"] == "failed"
    assert review["diff_count"] == 0
    assert review["changed_paths"] == []
    assert "restore_point" not in review


def test_an_oversize_payload_keeps_the_reviews_restore_point_and_drops_a_bad_one() -> None:
    body = "+" + "x" * (600 * 1024)
    diffs = [{"diff_id": "scripted:op:0", "path": "a.py", "hunks": [{"lines": [body]}]}]
    point = {"kind": "git_checkpoint", "ref": "refs/jenny/checkpoints/s1/2",
             "created_at": "2026-10-05T12:00:00.000Z"}

    kept = _raise({"observed_changes": {
        "diffs": diffs, "scripted_change_review": _review(restore_point=point)}})
    dropped = _raise({"observed_changes": {
        "diffs": diffs, "scripted_change_review": _review(restore_point={"kind": "git_checkpoint", "ref": "../x"})}})

    assert kept.observed_changes["scripted_change_review"]["restore_point"] == point
    assert "restore_point" not in dropped.observed_changes["scripted_change_review"]


def test_a_malformed_observed_changes_value_is_ignored() -> None:
    for value in ("text", [1], 3, None, {"diffs": "no"}, {"scripted_change_review": []}):
        error = _raise({"code": "CMP-TOOL-0001", "observed_changes": value})
        assert error.observed_changes is None
        assert error.detail is None
