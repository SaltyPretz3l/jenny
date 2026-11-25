"""Row 196: the sidecar's seams for the Electron-owned `computer` tool.

The one-changing-step rule, the picture path (newest picture only, the pixels-gone note), the saved
output, strict safety, the waiting-on-a-person credit and the vision requirement.
"""

from __future__ import annotations

import base64
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_TOOL_COMPUTER_LOOK_FIRST
from sidecar.ai.mcp.models import MCPToolDescriptor, MCPToolResult
from sidecar.ai.mode_policy import MODE_ASSIST
from sidecar.ai.routing.iteration_limits import COMPUTER_USE_TOOL_ID
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.preview_vision import _with_observations, admit_preview
from sidecar.ai.routing.tool_call_execution import pre_filter_tool_calls
from sidecar.ai.routing.tool_execution_ask_user_wait import credit_browser_consent_wait
from sidecar.ai.routing.tool_resolution import engine_takes_pictures
from sidecar.ai.routing.vision_turn import engine_supports_vision
from sidecar.ai.tools.assembly import (
    SAFETY_MODE_STRICT_REASON,
    VISION_REQUIRED_REASON,
    ToolAssemblyContext,
    assemble_tool_contract,
)
from sidecar.ai.tools.catalog import (
    MANAGED_SIDECAR_SURFACE,
    CanonicalToolAvailability,
    CanonicalToolDescriptor,
)
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.tool_families import (
    COMPUTER_STEP_FAILED,
    COMPUTER_STEP_FALLBACK,
    saved_tool_output,
)

PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII="
PNG = base64.b64decode(PNG_BASE64)
BRIDGE = MCPToolDescriptor(
    name="computer", description="", input_schema={}, side_effecting=True,
    source_kind="builtin", server_name="electron_tool_bridge",
)


def _computer(call_id: str, action: str, **arguments: object) -> ToolCallRequest:
    return ToolCallRequest(tool_id="computer", call_id=call_id, arguments={"action": action, **arguments})


# ---- one changing step a model message ---------------------------------------------------------


class _Kernel:
    def __init__(self) -> None:
        self._mcp_client = SimpleNamespace(tool_descriptor=lambda _name: None)

    def _assert_valid_tool_call(self, _call: Any) -> None:
        return None

    def _assistant_tool_call_message(self, *_a: Any, **_k: Any) -> dict[str, object]:
        return {"role": "assistant"}

    def _tool_result_message(self, *_a: Any, **_k: Any) -> dict[str, object]:
        return {"role": "tool"}

    def _build_deferred_outcome(self, _call: Any) -> Any:
        raise AssertionError("no deferred outcome expected")


def _prefilter(calls: list[ToolCallRequest]) -> tuple[list[str], list[Any]]:
    entry = SimpleNamespace(descriptor=None, available=True, reason=None, deferred=False)
    contract = SimpleNamespace(entry=lambda _name: entry)
    outcomes: list[Any] = []
    remaining, _ = pre_filter_tool_calls(
        calls, kernel=_Kernel(), runtime=LoopRuntime(emit=lambda _e: None, request_id="req-cu"),
        result=SimpleNamespace(), request_id="req-cu", session_id="s-cu",
        tool_resolution_context=None, tool_contract=contract, outcomes=outcomes,
        working_messages=[], iteration_calls=[], streamed_event_types=set(), outcome_index=0,
    )
    return [call.call_id for call, _index in remaining], outcomes


def test_only_the_first_changing_computer_call_of_a_message_runs() -> None:
    remaining, outcomes = _prefilter([
        _computer("c1", "click", x=1, y=2),
        _computer("c2", "screenshot"),
        _computer("c3", "type", text="hi"),
        _computer("c4", "key", chord="enter"),
        ToolCallRequest(tool_id="read_file", call_id="r1", arguments={"path": "a"}),
    ])
    assert remaining == ["c1", "c2", "r1"]
    assert [outcome.call_id for outcome in outcomes] == ["c3", "c4"]
    assert {outcome.error_code for outcome in outcomes} == {CMP_TOOL_COMPUTER_LOOK_FIRST}
    assert "look at the new picture before acting again" in outcomes[0].output


def test_looking_never_counts_as_a_change() -> None:
    remaining, outcomes = _prefilter([
        _computer("s1", "screenshot"), _computer("w1", "wait", seconds=1),
        _computer("l1", "windows"), _computer("o1", "open", name="Notepad"),
    ])
    assert remaining == ["s1", "w1", "l1", "o1"] and not outcomes


def test_a_malformed_computer_call_counts_as_changing() -> None:
    remaining, outcomes = _prefilter([
        _computer("c1", "focus", name="calc"),
        ToolCallRequest(tool_id="computer", call_id="c2", arguments={}),
    ])
    assert remaining == ["c1"] and [outcome.call_id for outcome in outcomes] == ["c2"]


# ---- pictures ------------------------------------------------------------------------------------


class _SeeingEngine:
    capabilities = {"vision": True}


def _wire(key: str) -> dict[str, object]:
    return {"call_id": key, "mime_type": "image/png", "width": 2, "height": 1,
            "data_base64": PNG_BASE64, "byte_length": len(PNG)}


def _admit(runtime: LoopRuntime, key: str, *, picture: bool = True) -> tuple[str, str]:
    result = MCPToolResult("computer", "Computer click: done\nPicture: 2 x 1", True,
                           preview_image=_wire(key) if picture else None)
    return admit_preview(runtime, _SeeingEngine(), _computer(key, "click", x=1, y=1), result, BRIDGE)


def test_a_computer_picture_replaces_every_earlier_one_even_unseen() -> None:
    runtime = LoopRuntime(request_id="req-pic")
    assert _admit(runtime, "c1")[0] == "queued"
    assert _admit(runtime, "c2")[0] == "queued"
    assert list(runtime.preview_images) == ["c2"]


def test_a_computer_step_without_a_picture_admits_nothing() -> None:
    runtime = LoopRuntime(request_id="req-pic")
    assert _admit(runtime, "c1", picture=False) == ("", "")
    assert not runtime.preview_images


def _rows(key: str, content: str) -> list[dict[str, object]]:
    return [
        {"role": "user", "content": "Use Notepad."},
        {"role": "assistant", "content": "",
         "tool_calls": [{"id": key, "name": "computer", "arguments": {"action": "click"}}]},
        {"role": "tool", "name": "computer", "tool_call_id": key, "content": content},
    ]


def test_a_dropped_computer_picture_says_its_pixels_are_gone() -> None:
    with_picture = _with_observations(_rows("c1", "Computer click: done\nPicture: 2 x 1"), {})
    assert "No screenshot pixels accompany this result" in with_picture[-1]["content"]
    windows = _with_observations(_rows("c2", "Computer windows: done"), {})
    assert windows[-1]["content"] == "Computer windows: done"


# ---- saved output, strict safety, waits, sight ------------------------------------------------------


def test_history_keeps_only_the_step_summary() -> None:
    line = "Computer: type Notepad done"
    assert saved_tool_output("computer", "Typed hello", {"step_summary": line}) == line
    assert saved_tool_output("computer", "x", {"step_summary": "  "}) == COMPUTER_STEP_FALLBACK
    assert saved_tool_output("computer", "x", {"failure_class": "boom"}) == COMPUTER_STEP_FAILED
    assert len(saved_tool_output("computer", "x", {"step_summary": "a" * 500})) == 200


def _descriptor() -> CanonicalToolDescriptor:
    return CanonicalToolDescriptor(
        name="computer", description="", input_schema={"type": "object"}, side_effecting=True,
        read_only=False,
        tool_family="computer_use", source_kind="builtin", server_name="electron_tool_bridge",
        availability=CanonicalToolAvailability(config_flag="tools_computer_use_enabled"),
        runtime_registered=True,
    )


def _entry(safety: str = "normal", *, vision: bool = True) -> Any:
    contract = assemble_tool_contract(
        (_descriptor(),),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={"tools_computer_use_enabled": True, "safety_mode": safety},
            engine_supports_tool_calling=True, mode=MODE_ASSIST, workspace_root_present=True,
            engine_supports_vision=vision,
        ),
    )
    return contract.entry("computer")


@pytest.mark.skipif(__import__("sys").platform != "win32", reason="the tool is Windows only")
def test_strict_and_paranoid_safety_and_a_blind_model_withhold_the_tool() -> None:
    assert _entry().available is True
    assert _entry("strict").reason == SAFETY_MODE_STRICT_REASON
    assert _entry("paranoid").reason == SAFETY_MODE_STRICT_REASON
    assert _entry(vision=False).reason == VISION_REQUIRED_REASON


@pytest.mark.parametrize(
    "engine",
    [
        SimpleNamespace(capabilities={"vision": True}),
        SimpleNamespace(capabilities={"vision": False}),
        SimpleNamespace(capabilities="vision"),
        SimpleNamespace(),
        None,
    ],
)
def test_the_vision_read_matches_the_shared_one(engine: Any) -> None:
    assert engine_takes_pictures(SimpleNamespace(_engine=engine)) is engine_supports_vision(engine)


def test_a_person_s_wait_on_a_computer_card_is_credited() -> None:
    runtime = LoopRuntime(request_id="req-wait", wall_clock_deadline=100.0, clock=lambda: 50.0)
    outcome = SimpleNamespace(metadata={"human_wait_ms": 12_500})
    credit_browser_consent_wait(runtime, _computer("c1", "focus", name="calc"), BRIDGE, outcome)
    assert runtime.wall_clock_deadline == pytest.approx(112.5)
    assert COMPUTER_USE_TOOL_ID == "computer"
