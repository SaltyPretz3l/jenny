"""The real Electron bridge must allow its existing bounded human consent window."""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import pytest

from sidecar.runtime import electron_tool_bridge as bridge


@pytest.mark.parametrize(("tool_name", "action", "consent"), [
    ("session_message", "send", True),
    ("session_message", "read", False),
    ("session_message", "list_targets", False),
    ("mcp__external__session_message", "send", False),
    ("run_command", "send", False),
])
@pytest.mark.parametrize("gated", [False, True])
def test_only_the_consent_response_gets_the_human_window(
    monkeypatch: pytest.MonkeyPatch, tool_name: str, action: str, consent: bool, gated: bool,
) -> None:
    now = [0.0]
    waits: list[float] = []
    messages: list[dict[str, Any]] = []
    monkeypatch.setattr(bridge.time, "monotonic", lambda: now[0])

    def factory(expected_id: int, **_kwargs: Any):
        def read(timeout: float) -> dict[str, Any]:
            waits.append(timeout)
            prepare = gated and len(messages) == 1
            if prepare:
                if tool_name == "run_command":
                    assert timeout >= 4 * 60 * 60 + 120
                    now[0] += 600
                result = {"runtime_resource_ready": {
                    "schema_version": 1, "operation_id": "call_1", "token": "a" * 36,
                }}
            else:
                # A real ordinary decision takes ten minutes; guarded Auto can
                # extend it to four hours. Both are the current Electron contract.
                if consent:
                    assert timeout >= 4 * 60 * 60 + 120
                    now[0] += 600
                result = {"tool_name": tool_name, "success": True, "output": '{"ok":false}'}
            return {"id": expected_id, "result": result}
        return read

    result = bridge.execute_electron_tool(bridge.ElectronToolBridgeRequest(
        tool_name=tool_name, arguments={"action": action}, request_id="req_1", trace_id=None,
        session_id="session_1", tool_call_id="call_1", write_message=messages.append,
        read_message=None, response_reader_factory=factory, timeout_seconds=120,
        before_resource_start=(lambda: None) if gated else None,
    ))
    assert result.success
    if gated:
        assert waits[0] == 120 + (4 * 60 * 60 if tool_name == "run_command" else 0)
    assert waits[-1] == 120 + (4 * 60 * 60 if consent else 0)


def test_bridge_consent_ceiling_matches_the_existing_electron_contract() -> None:
    source = (Path(__file__).resolve().parents[4] / "services/backend/chat-stream-tool-approval.js").read_text()
    normal = re.search(r"const APPROVAL_TIMEOUT_MS = ([\d *]+);", source)
    unattended = re.search(r"const UNATTENDED_PAUSE_APPROVAL_TIMEOUT_MS = ([\d *]+);", source)
    assert normal and unattended
    assert math.prod(map(int, re.findall(r"\d+", normal[1]))) == 600_000
    assert math.prod(map(int, re.findall(r"\d+", unattended[1]))) == 14_400_000
