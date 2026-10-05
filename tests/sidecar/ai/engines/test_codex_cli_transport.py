from __future__ import annotations

import json

import pytest

from sidecar.ai.engines import codex_cli_transport as transport


def _reply(message: str, *calls: tuple[str, str]) -> str:
    return json.dumps(
        {
            "message": message,
            "tool_calls": [{"name": name, "arguments_json": raw} for name, raw in calls],
        }
    )


def test_output_schema_is_strict_and_limits_names_to_the_catalog() -> None:
    names = transport._catalog_tool_names(
        [{"name": "write_file"}, {"tool_id": "read_file"}, {"name": " "}, "junk"]  # type: ignore[list-item]
    )
    schema = transport._output_schema(names)

    assert names == ["read_file", "write_file"]
    assert schema["required"] == ["message", "tool_calls"]
    assert schema["additionalProperties"] is False
    item = schema["properties"]["tool_calls"]["items"]
    assert item["properties"]["name"]["enum"] == names
    assert item["required"] == ["name", "arguments_json"]
    assert item["additionalProperties"] is False


def test_structured_result_reads_calls_only_from_the_call_list() -> None:
    result = transport._structured_result(
        [_reply('Use read_file({"path": "b"}) later.', ("read_file", '{"path": "a"}'))],
        ["read_file"],
    )

    assert result is not None
    assert [(call.tool_id, call.arguments) for call in result.tool_calls] == [
        ("read_file", {"path": "a"})
    ]
    assert result.content == 'Use read_file({"path": "b"}) later.'


def test_structured_result_is_none_for_a_reply_that_is_not_the_schema_object() -> None:
    assert transport._structured_result(["Plain text."], ["read_file"]) is None
    assert transport._structured_result(['{"tool_calls": "none"}'], ["read_file"]) is None


def test_structured_result_collects_into_the_out_list() -> None:
    out: list = []
    result = transport._structured_result([_reply("Done.")], ["read_file"], out)

    assert out == [result]
    assert result is not None and result.finish_reason == "stop"


@pytest.mark.parametrize(
    ("stderr", "exit_code", "expected"),
    [
        ("error: unexpected argument '--output-schema' found", 2, True),
        ("error: unexpected argument '--output-schema' found", 0, False),
        ("failed to read --output-schema file", 1, False),
        ("stream disconnected", 1, False),
    ],
)
def test_only_a_clap_rejection_counts_as_an_unsupported_schema_flag(
    stderr: str, exit_code: int, expected: bool
) -> None:
    from sidecar.ai.engines.codex_cli import CodexCliProcessResult

    result = CodexCliProcessResult(exit_code=exit_code, stderr=stderr)
    assert transport._output_schema_flag_rejected(result) is expected


def test_agent_message_parts_keep_message_boundaries() -> None:
    stdout = "\n".join(
        json.dumps(event)
        for event in (
            {"type": "thread.started"},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "One."}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "Two."}},
            {"type": "turn.completed", "usage": {"input_tokens": 1}},
        )
    )

    assert transport._agent_message_parts(stdout) == ["One.", "Two."]
    assert transport._parse_jsonl_output(stdout) == "One.Two."


def test_a_cli_owned_tool_event_is_rejected_while_parsing() -> None:
    stdout = json.dumps({"type": "item.started", "item": {"type": "command_execution"}})

    with pytest.raises(RuntimeError, match="its own tool"):
        transport._agent_message_parts(stdout)


def test_event_counts_summarise_a_stalled_turn_without_its_text() -> None:
    stdout = "\n".join(
        [
            json.dumps({"type": "thread.started"}),
            json.dumps({"type": "item.completed", "item": {"type": "reasoning", "text": "x"}}),
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "y"}}),
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "z"}}),
            "not json",
            json.dumps(["not", "an", "event"]),
        ]
    )

    assert transport._jsonl_event_counts(stdout) == {
        "thread.started": 1,
        "item.completed:reasoning": 1,
        "item.completed:agent_message": 2,
    }


def test_structured_instructions_say_jenny_tools_are_not_bound_by_the_cli_sandbox() -> None:
    instructions = transport._JENNY_STRUCTURED_TRANSPORT_INSTRUCTIONS

    assert "Never refuse a Jenny tool request because your own sandbox is read-only" in instructions
    # They ride on a cmd.exe command line when the CLI is a Windows shim.
    assert not set(instructions) & transport._CMD_METACHARACTERS
