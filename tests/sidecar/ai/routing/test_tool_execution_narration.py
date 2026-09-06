"""Message-shape guards for assistant tool-call turns (no imitable narration).

Split out of test_tool_execution_orchestration.py to stay under the
600-line test-file ratchet.
"""

from sidecar.ai.routing.tool_execution import assistant_tool_call_message
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.tool_execution_support import GenerationResult


def test_first_tool_call_carries_genuine_commentary_without_synthetic_narration() -> None:
    first = ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"}, call_id="c1")
    second = ToolCallRequest(tool_id="read_file", arguments={"path": "b.txt"}, call_id="c2")
    result = GenerationResult(
        content="I’ll inspect the two relevant files.",
        tool_calls=(first, second),
    )

    message = assistant_tool_call_message(result, first)

    assert message["role"] == "assistant"
    assert message["content"] == "I’ll inspect the two relevant files."
    assert "Calling tool" not in message["content"]
    tool_calls = message["tool_calls"]
    assert isinstance(tool_calls, list)
    assert tool_calls[0]["id"] == "c1"
    assert tool_calls[0]["name"] == "read_file"


def test_later_or_unmatched_tool_calls_do_not_duplicate_commentary() -> None:
    first = ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"}, call_id="c1")
    second = ToolCallRequest(tool_id="read_file", arguments={"path": "b.txt"}, call_id="c2")
    unmatched = ToolCallRequest(tool_id="read_file", arguments={"path": "c.txt"}, call_id="c3")
    result = GenerationResult(content="Checking both files.", tool_calls=(first, second))

    assert assistant_tool_call_message(result, second)["content"] == ""
    assert assistant_tool_call_message(result, unmatched)["content"] == ""
    assert assistant_tool_call_message(GenerationResult(content="   ", tool_calls=(first,)), first)[
        "content"
    ] == ""


def test_identical_blank_id_calls_match_only_the_first_call_object() -> None:
    first = ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"})
    second = ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"})
    result = GenerationResult(content="Checking it once.", tool_calls=(first, second))

    assert assistant_tool_call_message(result, first)["content"] == "Checking it once."
    assert assistant_tool_call_message(result, second)["content"] == ""
