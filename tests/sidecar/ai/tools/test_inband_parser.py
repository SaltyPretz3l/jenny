"""Tests for the in-band tool call parser."""

from __future__ import annotations

import pytest

from sidecar.ai.tools.inband_parser import (
    extract_inband_tool_calls,
    extract_inband_tool_calls_detailed,
)
from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing

KNOWN_TOOLS = frozenset({"glob_files", "read_file", "grep_search", "edit_file"})


@pytest.fixture(autouse=True)
def _reset_healing_cache():
    configure_tool_call_healing(None)
    yield
    configure_tool_call_healing(None)


class TestXmlFormat:
    def test_basic_xml_extraction(self) -> None:
        text = (
            "Let me list the files.\n"
            "<tool_call>\n"
            '{"name": "glob_files", "arguments": {"pattern": "*.py"}}\n'
            "</tool_call>"
        )
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].tool_id == "glob_files"
        assert calls[0].arguments == {"pattern": "*.py"}
        assert calls[0].call_id.startswith("inband_")
        assert "<tool_call>" not in remaining
        assert "Let me list the files." in remaining

    def test_multiple_xml_calls(self) -> None:
        text = (
            "<tool_call>\n"
            '{"name": "glob_files", "arguments": {"pattern": "*.py"}}\n'
            "</tool_call>\n"
            "Now reading:\n"
            "<tool_call>\n"
            '{"name": "read_file", "arguments": {"path": "main.py"}}\n'
            "</tool_call>"
        )
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 2
        assert calls[0].tool_id == "glob_files"
        assert calls[1].tool_id == "read_file"

    def test_xml_with_extra_whitespace(self) -> None:
        text = '<tool_call>  \n  {"name": "glob_files", "arguments": {}}  \n  </tool_call>'
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].tool_id == "glob_files"


class TestMarkdownFormat:
    def test_tool_call_code_block(self) -> None:
        text = (
            "Here is the call:\n"
            "```tool_call\n"
            '{"name": "grep_search", "arguments": {"pattern": "TODO", "path": "."}}\n'
            "```"
        )
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].tool_id == "grep_search"
        assert calls[0].arguments == {"pattern": "TODO", "path": "."}

    def test_json_code_block(self) -> None:
        text = '```json\n{"name": "read_file", "arguments": {"path": "README.md"}}\n```'
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].tool_id == "read_file"


class TestFunctionCallFormat:
    def test_inline_function_call(self) -> None:
        text = 'I will call glob_files({"pattern": "src/**/*.ts"})'
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].tool_id == "glob_files"
        assert calls[0].arguments == {"pattern": "src/**/*.ts"}

    def test_unknown_function_ignored(self) -> None:
        text = 'I will call unknown_tool({"arg": "val"})'
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 0
        assert remaining == text


class TestEdgeCases:
    def test_empty_text(self) -> None:
        calls, remaining = extract_inband_tool_calls("", KNOWN_TOOLS)
        assert calls == []
        assert remaining == ""

    def test_no_known_tools(self) -> None:
        text = '<tool_call>\n{"name": "glob_files", "arguments": {}}\n</tool_call>'
        calls, remaining = extract_inband_tool_calls(text, frozenset())
        assert calls == []

    def test_malformed_json_ignored(self) -> None:
        text = "<tool_call>\n{not valid json}\n</tool_call>"
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []

    def test_unknown_tool_name_ignored(self) -> None:
        text = '<tool_call>\n{"name": "delete_everything", "arguments": {}}\n</tool_call>'
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []
        assert remaining == text

    def test_prose_mention_not_extracted(self) -> None:
        text = "I would use glob_files to search for Python files in the directory."
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []
        assert remaining == text

    def test_xml_preferred_over_function_call(self) -> None:
        text = (
            "<tool_call>\n"
            '{"name": "glob_files", "arguments": {"pattern": "*.py"}}\n'
            "</tool_call>\n"
            'Also glob_files({"pattern": "*.js"})'
        )
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        # XML is found first, so function-call format should not also fire
        assert len(calls) == 1
        assert calls[0].arguments == {"pattern": "*.py"}

    def test_missing_arguments_key_defaults_to_empty(self) -> None:
        text = '<tool_call>\n{"name": "glob_files"}\n</tool_call>'
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].arguments == {}

    def test_call_ids_are_unique(self) -> None:
        text = (
            '<tool_call>{"name": "glob_files", "arguments": {}}</tool_call>\n'
            '<tool_call>{"name": "glob_files", "arguments": {}}</tool_call>'
        )
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 2
        assert calls[0].call_id != calls[1].call_id


class TestFailedAttemptEvidence:
    @pytest.mark.parametrize(
        "text",
        [
            "<tool_call>\n{not valid json}\n</tool_call>",
            'grep_search({"pattern"',
        ],
    )
    def test_explicit_malformed_candidate_sets_evidence(self, text: str) -> None:
        result = extract_inband_tool_calls_detailed(text, KNOWN_TOOLS)

        assert result.calls == ()
        assert result.remaining_text == text
        assert result.failed_attempt is True

    @pytest.mark.parametrize(
        "text",
        [
            "The new flow used edit_file(normalize_bom=true) successfully.",
            "workspace_change_baseline() then workspace_change_delta() is clear.",
            "git_show(ref=x, path=y) returned the parent blob.",
            "`grep_search({bad})` is an invalid example.",
            "```python\ngrep_search({bad})\n```",
            "def edit_file(path: str) -> None:",
            'unknown_tool({"pattern"',
            '<tool_call>{"name":"unknown_tool","arguments":{}}</tool_call>',
            "Here is a plain answer.",
        ],
    )
    def test_prose_and_code_examples_do_not_set_evidence(self, text: str) -> None:
        result = extract_inband_tool_calls_detailed(text, KNOWN_TOOLS)

        assert result.calls == ()
        assert result.failed_attempt is False

    def test_successful_call_never_sets_failure_evidence(self) -> None:
        result = extract_inband_tool_calls_detailed(
            '<tool_call>{"name":"read_file","arguments":{"path":"a.py"}}</tool_call>',
            KNOWN_TOOLS,
        )

        assert len(result.calls) == 1
        assert result.failed_attempt is False


class TestHealingFlagOffParity:
    """With the flag OFF, every new malformed-input case must behave exactly
    like today's strict parser: zero calls, text returned unchanged."""

    def test_trailing_comma_xml_flag_off(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
        text = (
            "<tool_call>\n"
            '{"name": "glob_files", "arguments": {"pattern": "*.py",}}\n'
            "</tool_call>"
        )
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []
        assert remaining == text

    def test_bare_json_object_mid_prose_flag_off(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
        text = 'Sure, calling it: {"name": "read_file", "arguments": {"path": "a.py"}} done.'
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []
        assert remaining == text

    def test_single_quoted_fence_flag_off(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
        text = "```json\n{'name': 'read_file', 'arguments': {'path': 'a.py'}}\n```"
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []
        assert remaining == text

    def test_func_call_trailing_comma_flag_off(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
        text = 'glob_files({"pattern": "*.py",})'
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []
        assert remaining == text

    def test_hopeless_fragment_flag_off(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
        text = '<tool_call>\n{"name": "gr\n</tool_call>'
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []
        assert remaining == text

    def test_all_existing_malformed_cases_still_zero_calls(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
        text = "<tool_call>\n{not valid json}\n</tool_call>"
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []


class TestHealingFlagOn:
    def test_trailing_comma_xml_heals(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        text = (
            "<tool_call>\n"
            '{"name": "glob_files", "arguments": {"pattern": "*.py",}}\n'
            "</tool_call>"
        )
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].tool_id == "glob_files"
        assert calls[0].arguments == {"pattern": "*.py"}
        assert "<tool_call>" not in remaining
        assert getattr(calls[0], "coerced", False) is False

    def test_bare_json_object_mid_prose_extracted_via_fourth_pass(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        text = 'Sure, calling it: {"name": "read_file", "arguments": {"path": "a.py"}} done.'
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].tool_id == "read_file"
        assert calls[0].arguments == {"path": "a.py"}
        assert '{"name": "read_file"' not in remaining
        assert "Sure, calling it:" in remaining
        assert "done." in remaining
        assert getattr(calls[0], "coerced", False) is False

    def test_single_quoted_fenced_payload_heals(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        text = "```json\n{'name': 'read_file', 'arguments': {'path': 'a.py'}}\n```"
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].tool_id == "read_file"
        assert calls[0].arguments == {"path": "a.py"}
        assert getattr(calls[0], "coerced", False) is False

    def test_func_call_trailing_comma_heals(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        text = 'glob_files({"pattern": "*.py",})'
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].tool_id == "glob_files"
        assert calls[0].arguments == {"pattern": "*.py"}
        assert getattr(calls[0], "coerced", False) is False

    def test_unknown_tool_name_in_healable_object_still_rejected(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        text = 'Here: {"name": "delete_everything", "arguments": {"x": 1,}} thanks.'
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []

    def test_prose_mentioning_tool_name_zero_calls(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        text = "You could use read_file to check the contents of that module."
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []
        assert remaining == text

    def test_hopeless_fragment_zero_calls(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        text = '<tool_call>\n{"name": "gr\n</tool_call>'
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []

    def test_healed_calls_have_falsy_coerced_attribute(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        text = 'glob_files({"pattern": "*.py",})'
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert getattr(calls[0], "coerced", False) is False


class TestFourthPassRequiresArgumentsObject:
    """Bare prose JSON naming a known tool must NOT phantom-dispatch.

    The balanced-object pass has no envelope/fence/call-syntax anchor, so an
    explicit ``arguments`` dict is required — a config blob or documentation
    example whose ``name`` value happens to be a known tool is not a call.
    """

    def _enable(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})

    def test_config_blob_with_known_tool_name_is_not_a_call(self) -> None:
        self._enable()
        text = 'Config: {"name": "read_file", "enabled": true} controls the tool.'
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []
        assert remaining == text

    def test_bare_name_only_object_is_not_a_call(self) -> None:
        self._enable()
        calls, _ = extract_inband_tool_calls('{"name": "grep_search"}', KNOWN_TOOLS)
        assert calls == []

    def test_string_arguments_value_is_not_a_call_on_fourth_pass(self) -> None:
        self._enable()
        text = 'Entry: {"name": "read_file", "arguments": "main.py"}'
        calls, _ = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert calls == []

    def test_explicit_arguments_dict_still_extracts(self) -> None:
        self._enable()
        text = 'Run {"name": "read_file", "arguments": {"path": "main.py"}} now.'
        calls, remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)
        assert len(calls) == 1
        assert calls[0].tool_id == "read_file"
        assert calls[0].arguments == {"path": "main.py"}
        assert '"arguments"' not in remaining


def test_wrapped_truncated_call_carries_structural_argument_repairs() -> None:
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    text = '<tool_call>{"name":"read_file","arguments":{"path":"a}</tool_call>'

    calls, _remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)

    assert len(calls) == 1
    assert "closed_string" in calls[0].argument_repairs


def test_wrapped_clean_call_has_no_argument_repairs() -> None:
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    text = '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>'

    calls, _remaining = extract_inband_tool_calls(text, KNOWN_TOOLS)

    assert len(calls) == 1
    assert calls[0].argument_repairs == ()
