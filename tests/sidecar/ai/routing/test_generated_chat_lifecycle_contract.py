from __future__ import annotations

from sidecar.ai.routing.generated_chat_lifecycle_contract import (
    normalize_identifier,
    normalize_terminal_status,
    sanitize_structure,
    truncate_utf8,
)


def test_generated_identifier_and_utf8_contract() -> None:
    assert normalize_identifier(" turn_1 ") == (True, "turn_1", None)
    for malformed in (0, False, ["turn_1"], {"id": "turn_1"}, "bad id", "会話"):
        assert normalize_identifier(malformed)[0] is False
    assert truncate_utf8("会話abc", 7) == "会話a"
    assert truncate_utf8("😀abc", 5) == "😀a"
    assert truncate_utf8("éabc", 3) == "é"


def test_generated_structure_budgets_and_terminal_aliases() -> None:
    deep: dict = {"leaf": True}
    for _index in range(14):
        deep = {"child": deep}
    assert sanitize_structure(deep)[1] == "depth_budget_exceeded"
    cycle: dict = {}
    cycle["self"] = cycle
    assert sanitize_structure(cycle)[1] == "cycle_detected"
    assert sanitize_structure({"text": "会" * 33000})[1] == "payload_byte_budget_exceeded"
    assert normalize_terminal_status("completed") == "complete"
    assert normalize_terminal_status("runtime-error") == "error"
    assert normalize_terminal_status("future_status") == "unknown"
