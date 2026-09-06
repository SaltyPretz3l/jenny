from __future__ import annotations

import logging

import sidecar.runtime.diagnostics as _diag_module
from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import StructuredLogFormatter, log_tool_execution


def test_log_tool_execution_adds_hashes_without_snippet_in_redacted_mode(caplog) -> None:
    original_capture_mode = _diag_module._CAPTURE_MODE  # noqa: SLF001
    _diag_module._CAPTURE_MODE = "redacted"  # noqa: SLF001
    try:
        logger = logging.getLogger("tests.sidecar.diagnostics.snippet.redacted")
        with caplog.at_level(logging.DEBUG, logger=logger.name):
            log_tool_execution(logger, tool_name="echo", tool_output="some output")

        data = caplog.records[-1].data
        assert data["tool_output_chars"] == len("some output")
        assert "tool_output_hash" in data
        assert "tool_output_snippet" not in data
    finally:
        _diag_module._CAPTURE_MODE = original_capture_mode  # noqa: SLF001


def test_log_tool_execution_adds_bounded_snippet_in_sanitized_mode(caplog) -> None:
    original_capture_mode = _diag_module._CAPTURE_MODE  # noqa: SLF001
    _diag_module._CAPTURE_MODE = "sanitized_snippets"  # noqa: SLF001
    try:
        logger = logging.getLogger("tests.sidecar.diagnostics.snippet.sanitized")
        output = "x" * 200
        with caplog.at_level(logging.DEBUG, logger=logger.name):
            log_tool_execution(logger, tool_name="echo", tool_output=output)

        data = caplog.records[-1].data
        assert data["tool_output_chars"] == len(output)
        assert "tool_output_hash" in data
        assert "tool_output_snippet" in data
        assert len(data["tool_output_snippet"]) <= 160
    finally:
        _diag_module._CAPTURE_MODE = original_capture_mode  # noqa: SLF001


def test_log_tool_execution_redacts_secrets_from_output_snippet(caplog) -> None:
    original_capture_mode = _diag_module._CAPTURE_MODE  # noqa: SLF001
    _diag_module._CAPTURE_MODE = "sanitized_snippets"  # noqa: SLF001
    try:
        logger = logging.getLogger("tests.sidecar.diagnostics.snippet.secret")
        raw_secret = "secret-token-value"
        output = f"Authorization: Bearer {raw_secret}"
        with caplog.at_level(logging.DEBUG, logger=logger.name):
            log_tool_execution(logger, tool_name="echo", tool_output=output)

        serialized_record = StructuredLogFormatter().format(caplog.records[-1])
        assert raw_secret not in serialized_record
    finally:
        _diag_module._CAPTURE_MODE = original_capture_mode  # noqa: SLF001


def test_log_tool_execution_without_output_preserves_existing_data_shape(caplog) -> None:
    original_capture_mode = _diag_module._CAPTURE_MODE  # noqa: SLF001
    _diag_module._CAPTURE_MODE = "sanitized_snippets"  # noqa: SLF001
    try:
        logger = logging.getLogger("tests.sidecar.diagnostics.snippet.absent")
        with caplog.at_level(logging.DEBUG, logger=logger.name):
            log_tool_execution(logger, tool_name="echo")

        assert caplog.records[-1].data == {
            "tool_name": "echo",
            "arguments": {},
            "success": True,
            "cancelled": False,
        }
    finally:
        _diag_module._CAPTURE_MODE = original_capture_mode  # noqa: SLF001


def test_builtin_server_success_path_captures_tool_output(caplog, tmp_path) -> None:
    original_capture_mode = _diag_module._CAPTURE_MODE  # noqa: SLF001
    _diag_module._CAPTURE_MODE = "sanitized_snippets"  # noqa: SLF001
    try:
        output_text = "output from the real builtin server call site"
        tool = builtin_server.BuiltinTool(
            name="snippet_test",
            description="test tool-output snippet wiring",
            side_effecting=False,
            input_schema={"type": "object", "properties": {}},
            handler=lambda _arguments, _workspace: output_text,
        )
        with caplog.at_level(logging.DEBUG, logger=builtin_server.logger.name):
            response = builtin_server._handle_tools_call(  # noqa: SLF001
                "snippet-test-call",
                {tool.name: tool},
                WorkspaceGuard(str(tmp_path)),
                {"name": tool.name, "arguments": {}},
            )

        assert response["result"]["content"][0]["text"] == output_text
        records = [
            record for record in caplog.records if record.event == "ai.tools.execution"
        ]
        assert len(records) == 1
        assert records[0].data["tool_output_chars"] == len(output_text)
        assert records[0].data["tool_output_snippet"] == output_text
    finally:
        _diag_module._CAPTURE_MODE = original_capture_mode  # noqa: SLF001
