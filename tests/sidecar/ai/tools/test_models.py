from __future__ import annotations

import logging

from sidecar.ai.tools.models import ensure_tool_call_id


def test_ensure_tool_call_id_preserves_provider_id() -> None:
    assert (
        ensure_tool_call_id(
            "call_provider_123",
            provider="ollama",
            tool_name="read_file",
            request_id="req_1",
            position=0,
        )
        == "call_provider_123"
    )


def test_ensure_tool_call_id_is_deterministic_with_request_id() -> None:
    first = ensure_tool_call_id(
        "",
        provider="ollama",
        tool_name="read_file",
        request_id="req_1",
        position=2,
    )
    second = ensure_tool_call_id(
        None,
        provider="ollama",
        tool_name="read_file",
        request_id="req_1",
        position=2,
    )

    assert first == second
    assert first.startswith("ollama_read_file_")


def test_ensure_tool_call_id_logs_random_fallback_at_debug(caplog) -> None:
    # Finding #32: the random-fallback diagnostic is logged at DEBUG (not WARNING)
    # now that the local engines thread request_id, so it no longer spams the WARN
    # log on every id-less tool call.
    caplog.set_level(logging.DEBUG, logger="sidecar.ai.tools.models")

    call_id = ensure_tool_call_id(
        "",
        provider="local engine",
        tool_name="read-file",
        position=3,
    )

    assert call_id.startswith("localengine_readfile_")
    debug_records = [
        record for record in caplog.records
        if record.levelno == logging.DEBUG and "non-deterministic id" in record.getMessage()
    ]
    assert debug_records, "expected a DEBUG-level non-deterministic-id diagnostic"
    assert "provider=localengine" in caplog.text
    assert "tool=readfile" in caplog.text
    assert "position=3" in caplog.text
