from __future__ import annotations

import json

from sidecar.ai.routing import tool_execution


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

    output, truncated = tool_execution._bounded_tool_output(  # noqa: SLF001
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
    output, truncated = tool_execution._bounded_tool_output(  # noqa: SLF001
        "x" * (tool_execution.MAX_RESPONSE_CHARS + 100),
        tool_name="read_file",
    )

    assert truncated is True
    assert len(output) == tool_execution.MAX_RESPONSE_CHARS
    assert output.endswith("[truncated]")


def test_deeply_nested_json_degrades_to_bounded_text_instead_of_crashing() -> None:
    depth = 2_000
    raw = '{"nested":' * depth + '"value"' + '}' * depth

    output, truncated = tool_execution._bounded_tool_output(  # noqa: SLF001
        raw,
        tool_name="remote_tool",
    )

    assert truncated is True
    assert len(output) <= tool_execution.MAX_RESPONSE_CHARS
    assert output.endswith("[truncated]")


def test_small_result_is_not_reformatted_or_marked_truncated() -> None:
    raw = '{"ok":true,"stdout":"done"}'

    output, truncated = tool_execution._bounded_tool_output(  # noqa: SLF001
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

    output, truncated = tool_execution._bounded_tool_output(  # noqa: SLF001
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
