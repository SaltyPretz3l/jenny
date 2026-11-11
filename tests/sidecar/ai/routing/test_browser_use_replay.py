"""The browser tool's history replay and consent window (roadmap row 114)."""

from __future__ import annotations

import json

import pytest

from sidecar.ai.routing.preview_vision import _with_observations


def test_replayed_arguments_are_parsed_only_for_browser_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    parsed: list[str] = []
    real_loads = json.loads
    monkeypatch.setattr(json, "loads", lambda raw, **kw: parsed.append(raw) or real_loads(raw, **kw))
    screenshot = '{"action": "screenshot"}'
    rows = [
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "a", "function": {"name": "read_file", "arguments": screenshot}},
            {"id": "b", "function": {"name": "browser", "arguments": screenshot}},
        ]},
        {"role": "tool", "name": "read_file", "tool_call_id": "a", "content": "file"},
        {"role": "tool", "name": "browser", "tool_call_id": "b", "content": "Loaded"},
    ]
    seen = _with_observations(rows, {})
    assert parsed == [screenshot]
    assert seen[1]["content"] == "file"
    assert "No screenshot pixels accompany this result" in seen[2]["content"]


def test_the_browser_consent_cap_matches_the_bridge_window() -> None:
    from sidecar.ai.routing.tool_execution_ask_user_wait import _MAX_BROWSER_CONSENT_WAIT_SECONDS
    from sidecar.runtime.electron_tool_bridge import _ELECTRON_CONSENT_WAIT_SECONDS

    assert _MAX_BROWSER_CONSENT_WAIT_SECONDS == _ELECTRON_CONSENT_WAIT_SECONDS
