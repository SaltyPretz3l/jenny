"""Unknown-tool observations name the valid tools.

Small local models hallucinate near-miss tool names (write_to_file for
write_file) and do not re-derive the right one from the system prompt's tool
block; without the list inline they conclude the capability is missing.
"""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.routing.tool_loop import _available_tool_names, _invalid_tool_output


def _contract(*entries: tuple[str, bool]) -> SimpleNamespace:
    return SimpleNamespace(
        entries=tuple(
            SimpleNamespace(descriptor=SimpleNamespace(name=name), available=available)
            for name, available in entries
        )
    )


def test_invalid_tool_output_lists_available_tools_sorted() -> None:
    contract = _contract(("write_file", True), ("read_file", True), ("list_dir", True))
    output = _invalid_tool_output("model requested unknown tool 'write_to_file'", contract)
    assert "unknown tool 'write_to_file'" in output
    assert "Available tools: list_dir, read_file, write_file." in output


def test_invalid_tool_output_omits_unavailable_entries() -> None:
    contract = _contract(("write_file", True), ("delete_file", False))
    output = _invalid_tool_output("model requested unknown tool 'patch'", contract)
    assert "write_file" in output
    assert "delete_file" not in output


def test_invalid_tool_output_without_contract_keeps_base_message() -> None:
    output = _invalid_tool_output("model requested unknown tool 'nope'", None)
    assert output.startswith("Error: model requested unknown tool 'nope'.")
    assert "Available tools" not in output


def test_available_tool_names_dedupes_and_skips_blank() -> None:
    contract = _contract(("write_file", True), ("write_file", True), ("", True))
    assert _available_tool_names(contract) == ("write_file",)


def test_a_shipped_tool_the_turn_did_not_offer_says_unavailable_not_unknown() -> None:
    from sidecar.ai.routing.tool_loop import _is_unknown_tool_call
    from sidecar.ai.tools.models import ToolCallRequest

    kernel = SimpleNamespace(
        _assert_valid_tool_call=lambda _call: None,
        _is_direct_deferred_tool_call=lambda _call, _context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: None),
        _config=SimpleNamespace(tools_shell_enabled=True),
    )

    def message(tool_id: str) -> str | None:
        return _is_unknown_tool_call(
            kernel,
            ToolCallRequest(tool_id=tool_id, arguments={}, call_id="call_1"),
            tool_resolution_context=None,
            tool_contract=None,
            request_disabled_tools=frozenset(),
        )

    assert message("sessions_list") == "tool 'sessions_list' is not available in this chat right now"
    assert message("write_to_file") == "model requested unknown tool 'write_to_file'"
