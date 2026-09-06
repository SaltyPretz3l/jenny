"""Tests for the tool-call reliability-net flag plumbing (config + cache)."""

from __future__ import annotations

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.tools.registry import build_tool_bindings
from sidecar.ai.tools.tool_call_healing import (
    HealResult,
    coerce_arguments,
    configure_tool_call_healing,
    drain_heal_telemetry,
    extract_balanced_json_objects,
    is_healing_enabled,
    record_repair,
    repair_json_payload,
)

KNOWN_TOOLS = frozenset(
    {"grep_search", "read_file", "glob_files", "edit_file"}
)


@pytest.fixture(autouse=True)
def _reset_healing_cache():
    configure_tool_call_healing(None)
    yield
    configure_tool_call_healing(None)


class TestConfigParsing:
    def test_defaults_true_when_key_absent(self) -> None:
        # Shipped default flipped ON 2026-07-01 (owner-directed pre-soak flip);
        # explicit config False remains the disable path.
        config = parse_runtime_config({})
        assert config.tool_call_reliability_net_enabled is True

    def test_true_when_raw_value_true(self) -> None:
        config = parse_runtime_config({"tool_call_reliability_net_enabled": True})
        assert config.tool_call_reliability_net_enabled is True

    def test_false_when_raw_value_false(self) -> None:
        config = parse_runtime_config({"tool_call_reliability_net_enabled": False})
        assert config.tool_call_reliability_net_enabled is False

    @pytest.mark.parametrize("garbage", ["yes", 1, None, "true", 0, []])
    def test_garbage_values_fall_back_to_shipped_default(self, garbage: object) -> None:
        # _as_bool only honors real booleans; anything else falls back to the
        # shipped default (True since the 2026-07-01 flip).
        config = parse_runtime_config({"tool_call_reliability_net_enabled": garbage})
        assert config.tool_call_reliability_net_enabled is True


class TestHealingCache:
    def test_disabled_before_any_configure_call(self) -> None:
        assert is_healing_enabled() is False

    def test_configure_true_enables(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        assert is_healing_enabled() is True

    def test_configure_false_disables(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
        assert is_healing_enabled() is False

    def test_configure_none_disables(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        assert is_healing_enabled() is True
        configure_tool_call_healing(None)
        assert is_healing_enabled() is False

    def test_configure_missing_key_disables(self) -> None:
        configure_tool_call_healing({})
        assert is_healing_enabled() is False

    def test_configure_dict_or_attr_contract_with_plain_dict(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        assert is_healing_enabled() is True

    def test_configure_non_bool_value_disables(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": "yes"})
        assert is_healing_enabled() is False


class TestBuildToolBindingsWiring:
    def test_build_tool_bindings_wires_flag_true(self) -> None:
        build_tool_bindings(config={"tool_call_reliability_net_enabled": True})
        assert is_healing_enabled() is True

    def test_build_tool_bindings_wires_flag_false(self) -> None:
        build_tool_bindings(config={"tool_call_reliability_net_enabled": False})
        assert is_healing_enabled() is False


class TestRepairJsonPayloadCleanParse:
    def test_clean_dict_no_repairs(self) -> None:
        result = repair_json_payload('{"name": "read_file", "arguments": {}}')
        assert result.value == {"name": "read_file", "arguments": {}}
        assert result.repairs == ()

    def test_clean_non_dict_json_returns_none(self) -> None:
        # A healed/parsed non-dict is not useful; value must be None.
        result = repair_json_payload("[1, 2, 3]")
        assert result.value is None
        assert result.repairs == ()

    def test_returns_healresult_dataclass(self) -> None:
        result = repair_json_payload('{"a": 1}')
        assert isinstance(result, HealResult)


class TestRepairTaxonomyPositives:
    def test_trailing_comma(self) -> None:
        raw = '{"name": "grep_search", "arguments": {"pattern": "x",}}'
        result = repair_json_payload(raw)
        assert result.value == {
            "name": "grep_search",
            "arguments": {"pattern": "x"},
        }
        assert result.repairs == ("trailing_comma",)

    def test_unterminated_string(self) -> None:
        raw = '{"name": "read_file", "arguments": {"path": "main.py'
        result = repair_json_payload(raw)
        assert result.value == {
            "name": "read_file",
            "arguments": {"path": "main.py"},
        }
        assert "closed_string" in result.repairs
        assert "closed_brace" in result.repairs

    def test_unterminated_braces(self) -> None:
        raw = '{"name": "glob_files", "arguments": {"pattern": "*.py"'
        result = repair_json_payload(raw)
        assert result.value == {
            "name": "glob_files",
            "arguments": {"pattern": "*.py"},
        }
        assert "closed_brace" in result.repairs

    def test_single_quotes(self) -> None:
        raw = "{'name': 'grep_search', 'arguments': {'pattern': 'TODO'}}"
        result = repair_json_payload(raw)
        assert result.value == {
            "name": "grep_search",
            "arguments": {"pattern": "TODO"},
        }
        assert result.repairs == ("single_quotes",)

    def test_single_quotes_translate_escaped_apostrophe_and_preserve_json_escape(self) -> None:
        raw = r"{'name':'write_file','arguments':{'content':'don\'t\nstop'}}"

        result = repair_json_payload(raw)

        assert result.value == {
            "name": "write_file",
            "arguments": {"content": "don't\nstop"},
        }
        assert result.repairs == ("single_quotes",)

    def test_python_literals(self) -> None:
        raw = '{"name": "grep_search", "arguments": {"ignore_case": True, "path": None}}'
        result = repair_json_payload(raw)
        assert result.value == {
            "name": "grep_search",
            "arguments": {"ignore_case": True, "path": None},
        }
        assert result.repairs == ("python_literals",)

    def test_smart_quotes(self) -> None:
        raw = "{“name”: “read_file”, “arguments”: {“path”: “a.py”}}"
        result = repair_json_payload(raw)
        assert result.value == {
            "name": "read_file",
            "arguments": {"path": "a.py"},
        }
        assert result.repairs == ("ascii_quotes",)

    def test_fenced_payload_with_prose(self) -> None:
        raw = (
            "Sure, here is the call:\n"
            "```json\n"
            '{"name": "read_file", "arguments": {"path": "a.py"}}\n'
            "```\n"
            "Let me know if that works."
        )
        result = repair_json_payload(raw)
        assert result.value == {
            "name": "read_file",
            "arguments": {"path": "a.py"},
        }
        assert "stripped_fence" in result.repairs

    def test_tool_call_debris(self) -> None:
        raw = '<tool_call>{"name": "read_file", "arguments": {"path": "a.py"}}</tool_call>'
        result = repair_json_payload(raw)
        assert result.value == {
            "name": "read_file",
            "arguments": {"path": "a.py"},
        }
        assert "stripped_debris" in result.repairs

    def test_nested_brace_arguments_embedded(self) -> None:
        text = (
            "Here you go: "
            '{"name": "edit_file", "arguments": {"edits": {"a": {"b": 1}}}}'
            " done."
        )
        objs = extract_balanced_json_objects(text)
        assert objs == [
            '{"name": "edit_file", "arguments": {"edits": {"a": {"b": 1}}}}'
        ]
        result = repair_json_payload(objs[0])
        assert result.value == {
            "name": "edit_file",
            "arguments": {"edits": {"a": {"b": 1}}},
        }

    def test_combination_fence_and_trailing_comma(self) -> None:
        raw = (
            "```json\n"
            '{"name": "grep_search", "arguments": {"pattern": "x",}}\n'
            "```"
        )
        result = repair_json_payload(raw)
        assert result.value == {
            "name": "grep_search",
            "arguments": {"pattern": "x"},
        }
        assert "stripped_fence" in result.repairs
        assert "trailing_comma" in result.repairs
        # Only these two tags, no others.
        assert set(result.repairs) == {"stripped_fence", "trailing_comma"}


class TestRepairNegativeSpace:
    def test_hopeless_fragment_key(self) -> None:
        result = repair_json_payload('{"name": "gr')
        assert result.value is None

    def test_plain_prose(self) -> None:
        result = repair_json_payload("I think you should read the file.")
        assert result.value is None

    def test_all_open_braces(self) -> None:
        result = repair_json_payload("{{{{")
        assert result.value is None

    def test_never_invents_content(self) -> None:
        # A bare key with no value cannot be healed without inventing.
        result = repair_json_payload('{"name":')
        assert result.value is None


class TestExtractBalancedJsonObjects:
    def test_nested_braces_returned_whole(self) -> None:
        text = 'prefix {"a": {"b": {"c": 1}}} suffix'
        assert extract_balanced_json_objects(text) == ['{"a": {"b": {"c": 1}}}']

    def test_braces_inside_strings_dont_split(self) -> None:
        text = '{"pattern": "a{b}c"}'
        assert extract_balanced_json_objects(text) == ['{"pattern": "a{b}c"}']

    def test_escaped_quotes_handled(self) -> None:
        text = '{"pattern": "say \\"hi\\" {x}"}'
        assert extract_balanced_json_objects(text) == [
            '{"pattern": "say \\"hi\\" {x}"}'
        ]

    def test_multiple_objects_in_order(self) -> None:
        text = 'a {"x": 1} b {"y": 2} c'
        assert extract_balanced_json_objects(text) == ['{"x": 1}', '{"y": 2}']

    def test_unbalanced_trailing_not_returned(self) -> None:
        text = '{"x": 1} then {"y": '
        assert extract_balanced_json_objects(text) == ['{"x": 1}']

    def test_empty_when_no_objects(self) -> None:
        assert extract_balanced_json_objects("no json here") == []


class TestCoerceArguments:
    def test_dict_passthrough_empty_tags(self) -> None:
        assert coerce_arguments({"a": 1}) == ({"a": 1}, ())

    def test_valid_json_string(self) -> None:
        assert coerce_arguments('{"a": 1}') == (
            {"a": 1},
            ("parsed_string_arguments",),
        )

    def test_single_quoted_string_healed_with_tags(self) -> None:
        result = coerce_arguments("{'a': 1}")
        assert result is not None
        value, tags = result
        assert value == {"a": 1}
        assert tags[0] == "parsed_string_arguments"
        assert "single_quotes" in tags

    def test_trailing_comma_string_healed_with_tags(self) -> None:
        result = coerce_arguments('{"a": 1,}')
        assert result is not None
        value, tags = result
        assert value == {"a": 1}
        assert tags == ("parsed_string_arguments", "trailing_comma")

    def test_non_dict_json_string_returns_none(self) -> None:
        assert coerce_arguments("[1, 2]") is None

    def test_none_returns_none(self) -> None:
        assert coerce_arguments(None) is None

    def test_int_returns_none(self) -> None:
        assert coerce_arguments(5) is None

    def test_list_returns_none(self) -> None:
        assert coerce_arguments([1, 2]) is None


class TestPurityIndependentOfFlag:
    def test_heal_works_with_flag_disabled(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
        assert is_healing_enabled() is False
        result = repair_json_payload('{"name": "read_file", "arguments": {"x": 1,}}')
        assert result.value == {"name": "read_file", "arguments": {"x": 1}}
        assert result.repairs == ("trailing_comma",)

    def test_heal_works_with_flag_enabled(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        result = repair_json_payload('{"name": "read_file", "arguments": {"x": 1,}}')
        assert result.value == {"name": "read_file", "arguments": {"x": 1}}
        assert result.repairs == ("trailing_comma",)


class TestHealTelemetryAccumulator:
    """The bounded repair tally drained by the reliability event emitter."""

    @pytest.fixture(autouse=True)
    def _drain_before_and_after(self):
        drain_heal_telemetry()
        yield
        drain_heal_telemetry()

    def test_record_and_drain_resets(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        record_repair(("trailing_comma",))
        record_repair(("single_quotes", "closed_brace"))
        counts = drain_heal_telemetry()
        assert counts["repair_used"] == 2
        assert drain_heal_telemetry()["repair_used"] == 0

    def test_empty_tags_record_nothing(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        record_repair(())
        assert drain_heal_telemetry()["repair_used"] == 0

    def test_disabled_flag_makes_record_a_noop(self) -> None:
        configure_tool_call_healing(None)
        record_repair(("trailing_comma",))
        assert drain_heal_telemetry()["repair_used"] == 0

    def test_count_is_capped(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
        for _ in range(10_005):
            record_repair(("trailing_comma",))
        assert drain_heal_telemetry()["repair_used"] == 10_000
