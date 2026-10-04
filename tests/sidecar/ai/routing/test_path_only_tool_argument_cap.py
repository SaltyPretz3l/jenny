"""Path-only builtins get a small per-call argument cap (dogfood MQ-033).

A dogfood run spent three minutes streaming ONE ``delete_file`` call whose
arguments grew to 41.6 KB: under the generic 64 KiB per-call cap, so nothing
tripped. Tools that take only a path and flags now reject past 8 KiB with the
reason ``tool_argument_bytes``; every other tool keeps the 64 KiB cap.
"""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_LOOP_INVALID_TOOL_CALL
from sidecar.ai.routing import provider_tool_limits
from sidecar.ai.routing.provider_stream_normalizer import (
    NORMALIZED_KIND_FAILED,
    NORMALIZED_KIND_TOOL_CALL_COMPLETED,
    ProviderStreamNormalizer,
)
from sidecar.ai.routing.provider_tool_limits import MAX_TOOL_CALL_ARGUMENT_BYTES
from sidecar.ai.routing.thinking_checkpoint import build_checkpoint_messages
from sidecar.ai.routing.tool_call_canonicalization import validate_provider_tool_call_limits
from sidecar.ai.tools.models import ToolCallRequest

_PATH_ONLY_CAP = 8 * 1024
_KIB_PIECE = "a" * 1024


def _fragment(index: int, arguments: str, *, name: str = "", call_id: str = "") -> dict:
    call: dict[str, Any] = {"index": index, "function": {"arguments": arguments}}
    if call_id:
        call["id"] = call_id
    if name:
        call["function"]["name"] = name
    return {"choices": [{"delta": {"tool_calls": [call]}}]}


def _feed(normalizer: ProviderStreamNormalizer, chunks: list[dict]) -> list:
    events: list = []
    for chunk in chunks:
        events.extend(normalizer.process_chunk(chunk))
    events.extend(normalizer.finalize())
    return events


def _streamed_call(name: str, *, kib: int, name_first: bool = True) -> list[dict]:
    """One call whose string argument is ``kib`` KiB, split into 1 KiB fragments."""
    head = _fragment(0, '{"path": "', name=name if name_first else "", call_id="call-1")
    body = [_fragment(0, _KIB_PIECE) for _ in range(kib)]
    chunks = [head, *body]
    if not name_first:
        chunks.append(_fragment(0, "", name=name))
    chunks.append(_fragment(0, '"}'))
    return chunks


def _completed(events: list) -> list:
    return [event for event in events if event.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED]


# -- limits ------------------------------------------------------------------


def test_path_only_tools_get_the_small_cap_and_every_other_tool_keeps_64_kib() -> None:
    assert provider_tool_limits.PATH_ONLY_TOOL_ARGUMENT_BYTES == _PATH_ONLY_CAP
    for name in ("delete_file", "read_file", "list_dir", "glob_files"):
        assert provider_tool_limits.tool_argument_byte_cap(name) == _PATH_ONLY_CAP, name
    for name in ("check_background_job", "stop_background_job"):
        assert provider_tool_limits.tool_argument_byte_cap(name) == _PATH_ONLY_CAP, name
    for name in (
        "run_command",
        "move_file",  # a batch of up to 100 source/destination pairs
        "write_file",
        "edit_file",
        "apply_patch",
        "python_execute",
        "run_temp_script",
        "grep_search",
        "git_diff",
        "mcp__server__delete_file",
        "plugin.acme.read_file",
        "copy_file",
        "",
    ):
        assert provider_tool_limits.tool_argument_byte_cap(name) == (
            MAX_TOOL_CALL_ARGUMENT_BYTES
        ), name


# -- vLLM / OpenAI-compatible accumulation -----------------------------------


def test_a_9_kib_delete_file_call_is_rejected_at_the_path_only_cap() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")

    events = _feed(normalizer, _streamed_call("delete_file", kib=9))

    assert normalizer.tool_input_rejected is True
    assert normalizer.tool_input_rejection_reason == "tool_argument_bytes"
    assert _completed(events) == []
    assert sum(event.kind == NORMALIZED_KIND_FAILED for event in events) == 1


def test_a_40_kib_write_file_call_is_not_rejected() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")

    events = _feed(normalizer, _streamed_call("write_file", kib=40))

    assert normalizer.tool_input_rejected is False
    assert normalizer.tool_input_rejection_reason == ""
    assert [event.tool_name for event in _completed(events)] == ["write_file"]


def test_fragments_before_the_name_still_count_when_the_name_arrives() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    chunks = _streamed_call("delete_file", kib=9, name_first=False)
    name_chunk_index = len(chunks) - 2

    for chunk in chunks[:name_chunk_index]:
        list(normalizer.process_chunk(chunk))
    assert normalizer.tool_input_rejected is False, "no name yet: only the generic cap"
    events = list(normalizer.process_chunk(chunks[name_chunk_index]))

    assert normalizer.tool_input_rejection_reason == "tool_argument_bytes"
    assert [event.kind for event in events] == [NORMALIZED_KIND_FAILED]
    assert _completed(_feed(normalizer, chunks[name_chunk_index + 1 :])) == []


@pytest.mark.parametrize("name", ["mcp__files__delete_file", "acme_lookup_records"])
def test_an_unknown_or_plugin_tool_at_9_kib_is_not_rejected(name: str) -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")

    events = _feed(normalizer, _streamed_call(name, kib=9))

    assert normalizer.tool_input_rejected is False
    assert [event.tool_name for event in _completed(events)] == [name]


def test_a_path_only_call_under_the_cap_completes() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")

    events = _feed(normalizer, _streamed_call("delete_file", kib=7))

    assert normalizer.tool_input_rejected is False
    assert [event.tool_name for event in _completed(events)] == ["delete_file"]


def test_a_parsed_dict_for_a_path_only_tool_is_held_to_the_same_cap() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    chunk = {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call-1",
                            "function": {
                                "name": "delete_file",
                                "arguments": {"path": "a" * (9 * 1024)},
                            },
                        }
                    ]
                }
            }
        ]
    }

    events = _feed(normalizer, [chunk])

    assert normalizer.tool_input_rejection_reason == "tool_argument_bytes"
    assert _completed(events) == []


# -- Ollama whole-call classification ------------------------------------------


def _ollama_call(name: str, path_kib: int) -> dict:
    arguments = {"path": "a" * (path_kib * 1024)}
    return {"message": {"tool_calls": [{"function": {"name": name, "arguments": arguments}}]}}


def test_ollama_path_only_call_past_the_cap_is_rejected() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")

    events = _feed(normalizer, [_ollama_call("delete_file", 9)])

    assert normalizer.tool_input_rejection_reason == "tool_argument_bytes"
    assert _completed(events) == []


def test_ollama_write_file_call_at_9_kib_is_not_rejected() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")

    events = _feed(normalizer, [_ollama_call("write_file", 9)])

    assert normalizer.tool_input_rejected is False
    assert [event.tool_name for event in _completed(events)] == ["write_file"]


# -- checkpoint continuation note ----------------------------------------------


def test_the_continuation_note_says_the_tool_takes_only_a_path() -> None:
    notes = [
        str(message["content"])
        for message in build_checkpoint_messages(
            "reasoning",
            tool_call_truncated=True,
            tool_call_rejected_reason="tool_argument_bytes",
        )
        if message["role"] == "system"
    ]

    assert any(
        "did not run" in note
        and "only a short path, pattern or id" in note
        and "one target per call" in note
        for note in notes
    ), notes
    assert not any("cut off at the output-token limit" in note for note in notes), notes


# -- the pre-dispatch validator (every engine, including Ollama) --------------


def test_the_pre_dispatch_validator_rejects_a_path_only_call_past_the_small_cap() -> None:
    kept = ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"}, call_id="kept")
    runaway = ToolCallRequest(
        tool_id="delete_file",
        arguments={"path": "x" * (_PATH_ONLY_CAP + 1)},
        call_id="runaway",
    )
    content = ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "b.txt", "content": "y" * (_PATH_ONLY_CAP + 1)},
        call_id="content",
    )
    batch = ToolCallRequest(
        tool_id="move_file",
        arguments={
            "moves": [
                {"source": f"src/{'s' * 60}-{index}", "destination": f"dst/{'d' * 60}-{index}"}
                for index in range(100)
            ]
        },
        call_id="batch",
    )

    accepted, rejected = validate_provider_tool_call_limits((kept, runaway, content, batch))

    assert accepted == (kept, content, batch)
    assert [call.call_id for call, _failure in rejected] == ["runaway"]
    failure = rejected[0][1]
    assert failure.code == CMP_LOOP_INVALID_TOOL_CALL
    assert f"{_PATH_ONLY_CAP}-byte per-call limit" in failure.message
