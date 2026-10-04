"""Tool-call markup written as visible text (HB-031): find and strip, never dispatch."""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.tools.text_tool_calls import (
    TextToolCall,
    contract_tool_names,
    find_text_tool_calls,
    is_tool_call_only,
    strip_text_tool_calls,
)

_KNOWN = ("edit_file", "read_file", "run_command")

# Trimmed from the persisted HB-031 leak (Qwen3-Coder template, opener included).
_LEAK = (
    "Now writing the code.\n\n<tool_call>\n<function=edit_file>\n"
    "<parameter=path>\nbank_recon/matching.py\n</parameter>\n"
    "<parameter=old_string>\n# --- G5 fix: noise-tolerant text gate\n</parameter>\n"
    "<parameter=new_string>\n# --- G5 fix: strict token-subset rescue\n</parameter>\n"
    "</function>\n</tool_call>"
)


def test_full_leak_shape_is_one_complete_call_with_framing_newlines_stripped() -> None:
    (call,) = find_text_tool_calls(_LEAK, _KNOWN)

    assert isinstance(call, TextToolCall)
    assert call.name == "edit_file"
    assert call.complete is True
    assert call.arguments == {
        "path": "bank_recon/matching.py",
        "old_string": "# --- G5 fix: noise-tolerant text gate",
        "new_string": "# --- G5 fix: strict token-subset rescue",
    }
    assert _LEAK[call.start : call.end].startswith("<tool_call>")
    assert call.end == len(_LEAK)


def test_parameter_value_keeps_its_inner_newlines() -> None:
    text = "<function=edit_file><parameter=new_string>\na\n\nb\n</parameter></function>"

    (call,) = find_text_tool_calls(text, _KNOWN)

    assert call.arguments == {"new_string": "a\n\nb"}


def test_truncated_block_is_incomplete_and_runs_to_the_end() -> None:
    text = "Let me run it.\n<tool_call>\n<function=run_command>\n<parameter=command>\nnpm te"

    (call,) = find_text_tool_calls(text, _KNOWN)

    assert call.name == "run_command"
    assert call.complete is False
    assert call.end == len(text)
    assert strip_text_tool_calls(text, _KNOWN)[0] == "Let me run it."


def test_bare_function_block_without_the_wrapper_is_found() -> None:
    text = "Checking.\n<function=read_file><parameter=path>a.txt</parameter></function>"

    (call,) = find_text_tool_calls(text, _KNOWN)

    assert (call.name, call.arguments, call.complete) == ("read_file", {"path": "a.txt"}, True)


def test_unknown_function_name_is_left_untouched() -> None:
    text = "Done.\n<tool_call><function=delete_repo><parameter=x>1</parameter></function></tool_call>"

    assert find_text_tool_calls(text, _KNOWN) == ()
    assert strip_text_tool_calls(text, _KNOWN) == (text, ())


def test_blocks_inside_markdown_code_are_left_untouched() -> None:
    fenced = (
        "The template renders calls like this:\n```xml\n<tool_call>\n<function=edit_file>\n"
        "<parameter=path>\na.py\n</parameter>\n</function>\n</tool_call>\n```\nThat is all."
    )
    inline = "Qwen opens a call with `<function=edit_file>` and closes it with `</function>`."

    for text in (fenced, inline):
        assert find_text_tool_calls(text, _KNOWN) == ()
        assert strip_text_tool_calls(text, _KNOWN) == (text, ())


def test_tilde_fenced_code_is_left_untouched() -> None:
    text = (
        "Example:\n~~~xml\n<function=edit_file><parameter=path>a.py</parameter></function>\n"
        "~~~\nDone."
    )

    assert strip_text_tool_calls(text, _KNOWN) == (text, ())


def test_an_unclosed_tag_mention_is_not_a_call() -> None:
    text = "The <function=read_file> tag identifies the reader. It requires a path."

    assert strip_text_tool_calls(text, _KNOWN) == (text, ())


def test_an_unclosed_bare_block_with_a_parameter_is_a_truncated_call() -> None:
    text = "Reading.\n<function=read_file>\n<parameter=path>\nbank_recon/mat"

    prose, (call,) = strip_text_tool_calls(text, _KNOWN)

    assert (prose, call.name, call.complete) == ("Reading.", "read_file", False)


def test_contract_tool_names_include_tools_that_are_not_available() -> None:
    def entry(name: str, available: bool) -> SimpleNamespace:
        return SimpleNamespace(descriptor=SimpleNamespace(name=name), available=available)

    contract = SimpleNamespace(entries=(entry("task_board", False), entry("read_file", True)))

    assert contract_tool_names(contract) == ("read_file", "task_board")
    assert contract_tool_names(None) == ()


def test_json_envelope_is_found_for_known_names_only() -> None:
    text = 'Reading.\n<tool_call>{"name": "read_file", "arguments": {"path": "a.txt", "limit": 5}}</tool_call>'
    unknown = '<tool_call>{"name": "nope", "arguments": {}}</tool_call>'

    (call,) = find_text_tool_calls(text, _KNOWN)

    assert (call.name, call.complete, call.shape) == ("read_file", True, "json_envelope")
    assert call.arguments == {"path": "a.txt", "limit": "5"}
    assert find_text_tool_calls(unknown, _KNOWN) == ()


def test_two_blocks_in_one_text_are_both_found_in_order() -> None:
    text = (
        "First.\n<function=read_file><parameter=path>a</parameter></function>\n"
        "Then.\n<tool_call>\n<function=run_command>\n<parameter=command>\ndir\n</parameter>\n"
        "</function>\n</tool_call>"
    )

    calls = find_text_tool_calls(text, _KNOWN)

    assert [call.name for call in calls] == ["read_file", "run_command"]
    assert [call.shape for call in calls] == ["qwen_xml", "qwen_xml"]
    assert calls[0].end <= calls[1].start


def test_strip_keeps_the_prose_and_collapses_blank_lines() -> None:
    text = (
        "Before.\n\n<function=read_file><parameter=path>a</parameter></function>\n\n"
        "After.\n\n" + _LEAK.split("\n\n", 1)[1]
    )

    prose, calls = strip_text_tool_calls(text, _KNOWN)

    assert prose == "Before.\n\nAfter."
    assert [call.name for call in calls] == ["read_file", "edit_file"]
    assert strip_text_tool_calls(_LEAK, _KNOWN)[0] == "Now writing the code."


def test_tool_call_only_is_false_once_prose_survives_the_strip() -> None:
    markup_only = _LEAK.split("\n\n", 1)[1]

    assert is_tool_call_only(markup_only, _KNOWN) is True
    assert is_tool_call_only(_LEAK, _KNOWN) is False
    assert is_tool_call_only("", _KNOWN) is False


def test_text_without_calls_is_returned_unchanged() -> None:
    text = "  Plain answer.\n\n\n\nWith spacing.  "

    assert strip_text_tool_calls(text, _KNOWN) == (text, ())
