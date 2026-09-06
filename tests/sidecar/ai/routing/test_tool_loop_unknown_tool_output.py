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
