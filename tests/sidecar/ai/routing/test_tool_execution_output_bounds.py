from __future__ import annotations

import json

import pytest

from sidecar.ai.routing import tool_execution


@pytest.mark.parametrize("keep_edges", [True, False])
@pytest.mark.parametrize("as_json", [True, False])
def test_harness_router_keeps_edges_and_priority_keys(keep_edges, as_json):
    text = "FIRST\n" + "x" * 30_000 + "\nLAST"
    raw = json.dumps({
        "stdout": text, "ok": False, "exit_code": 7,
        "full_output_path": ".jenny/tool-results/x.txt", "full_output_complete": True,
    }) if as_json else text
    output, truncated = tool_execution._bounded_tool_output(
        raw, tool_name="run_command", keep_edges=keep_edges,
    )
    assert truncated
    assert len(output) <= tool_execution.MAX_RESPONSE_CHARS
    if as_json:
        payload = json.loads(output)
        assert payload["ok"] is False
        assert payload["exit_code"] == 7
        assert payload["full_output_path"] == ".jenny/tool-results/x.txt"
        assert payload["full_output_complete"] is True
        output = payload["stdout"]
    assert output.startswith("FIRST\n")
    assert output.endswith("\nLAST") is keep_edges
    if keep_edges:
        marker = "\n...[middle truncated by router]\n"
        head, tail = output.split(marker)
        budget = len(head) + len(tail)
        assert len(head) == int(budget * 0.7)


def test_oversized_json_result_remains_valid_and_preserves_terminal_metadata() -> None:
    raw = json.dumps(
        {
            "command": "build",
            "cwd": ".",
            "exit_code": 1,
            "stdout": "o" * 12_000,
            "stderr": "e" * 12_000,
            "ok": False,
            "shell": "cmd.exe",
            "full_output_path": ".jenny/tool-results/build.txt",
            "output_counters": {"captured_bytes": 24_000},
        }
    )

    output, truncated = tool_execution._bounded_tool_output(
        raw,
        tool_name="run_command",
    )
    payload = json.loads(output)

    assert truncated is True
    assert len(output) <= tool_execution.MAX_RESPONSE_CHARS
    assert payload["truncated"] is True
    assert payload["truncation_reason"] == "router_output_chars"
    assert payload["ok"] is False
    assert payload["exit_code"] == 1
    assert payload["full_output_path"] == ".jenny/tool-results/build.txt"
    assert payload["output_counters"] == {"captured_bytes": 24_000}
    assert payload["stdout"].endswith("...[truncated]")
    assert payload["stderr"].endswith("...[truncated]")


def test_oversized_plain_text_keeps_legacy_bounded_text_contract() -> None:
    output, truncated = tool_execution._bounded_tool_output(
        "x" * (tool_execution.MAX_RESPONSE_CHARS + 100),
        tool_name="read_file",
    )

    assert truncated is True
    assert len(output) == tool_execution.MAX_RESPONSE_CHARS
    assert output.endswith("[truncated]")


def test_deeply_nested_json_degrades_to_bounded_text_instead_of_crashing() -> None:
    depth = 2_000
    raw = '{"nested":' * depth + '"value"' + '}' * depth

    output, truncated = tool_execution._bounded_tool_output(
        raw,
        tool_name="remote_tool",
    )

    assert truncated is True
    assert len(output) <= tool_execution.MAX_RESPONSE_CHARS
    assert output.endswith("[truncated]")


def test_small_result_is_not_reformatted_or_marked_truncated() -> None:
    raw = '{"ok":true,"stdout":"done"}'

    output, truncated = tool_execution._bounded_tool_output(
        raw,
        tool_name="run_command",
    )

    assert output == raw
    assert truncated is False


def test_oversized_json_bounds_omitted_key_summary_without_losing_priority_fields() -> None:
    raw = json.dumps(
        {
            "ok": False,
            "exit_code": 9,
            "full_output_path": ".jenny/tool-results/failure.txt",
            **{f"very_long_field_{index}_{'x' * 100}": "y" * 500 for index in range(500)},
        }
    )

    output, truncated = tool_execution._bounded_tool_output(
        raw,
        tool_name="run_command",
    )
    payload = json.loads(output)

    assert truncated is True
    assert len(output) <= tool_execution.MAX_RESPONSE_CHARS
    assert payload["ok"] is False
    assert payload["exit_code"] == 9
    assert payload["full_output_path"] == ".jenny/tool-results/failure.txt"
    assert payload["omitted_field_count"] > len(payload.get("omitted_fields", []))


def test_oversized_mcp_result_object_keeps_a_bounded_prefix_instead_of_an_empty_stub() -> None:
    # MCP tools wrap the whole answer in one "result" object (rea binary_session).
    raw = json.dumps(
        {
            "result": {
                "sessions": [
                    {"id": f"session-{index}", "path": f"C:\\targets\\app-{index}.exe", "note": 'quoted "x"'}
                    for index in range(2_000)
                ]
            }
        }
    )

    output, truncated = tool_execution._bounded_tool_output(raw, tool_name="mcp__rea__binary_session")
    payload = json.loads(output)

    assert truncated is True
    assert len(output) <= tool_execution.MAX_RESPONSE_CHARS
    assert "omitted_fields" not in payload
    assert isinstance(payload["result"], str)
    assert payload["result"].startswith('{"sessions":[{"id":"session-0"')
    assert payload["result"].endswith("...[truncated]")
    assert len(payload["result"]) > tool_execution.MAX_RESPONSE_CHARS // 2
