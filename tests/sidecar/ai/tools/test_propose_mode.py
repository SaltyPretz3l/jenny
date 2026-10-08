"""Propose mode plumbing: availability, read-only gates, overlay, params (Plan Plus C1/C2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.context.prompt_modes import (
    PROPOSE_MODE_GUIDANCE,
    append_propose_mode_runtime_overlay,
    build_propose_mode_overlay,
)
from sidecar.ai.context.runtime_message_markers import (
    PROPOSE_MODE_OVERLAY_HEADING,
    RUNTIME_SYSTEM_MESSAGE_HEADINGS,
)
from sidecar.ai.mode_policy import MODE_ASSIST
from sidecar.ai.tools.assembly import (
    PROPOSE_MODE_ONLY_REASON,
    READ_ONLY_UNAVAILABLE_REASON,
    ToolAssemblyContext,
    assemble_tool_contract,
    blocked_tool_message,
)
from sidecar.ai.tools.catalog import (
    MANAGED_SIDECAR_SURFACE,
    CanonicalToolAvailability,
    CanonicalToolDescriptor,
    manifest_tool_entry,
)
from sidecar.ai.tools.manifest_validation import validate_manifest_availability
from sidecar.runtime.chat_normalization import (
    cap_propose_reasoning_effort,
    propose_mode_from_params,
    suggested_changes_context_from_params,
)

ROOT = Path(__file__).resolve().parents[4]


def _descriptor(name: str, *, side_effecting: bool, propose_only: bool = False) -> CanonicalToolDescriptor:
    return CanonicalToolDescriptor(
        name=name,
        description=name,
        input_schema={"type": "object", "properties": {}},
        side_effecting=side_effecting,
        read_only=not side_effecting,
        availability=CanonicalToolAvailability(propose_mode_only=propose_only),
        runtime_registered=True,
        server_name="runtime",
    )


def _contract(*, propose_mode: bool, read_only: bool):
    return assemble_tool_contract(
        (
            _descriptor("propose_change", side_effecting=False, propose_only=True),
            _descriptor("edit_file", side_effecting=True),
            _descriptor("read_file", side_effecting=False),
        ),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            mode=MODE_ASSIST,
            propose_mode=propose_mode,
            read_only=read_only,
            workspace_root_present=True,
        ),
    )


def test_propose_change_is_available_only_in_propose_mode() -> None:
    outside = _contract(propose_mode=False, read_only=False).entry("propose_change")
    inside = _contract(propose_mode=True, read_only=True).entry("propose_change")

    assert outside is not None and outside.available is False
    assert outside.reason == PROPOSE_MODE_ONLY_REASON
    assert "Propose" in blocked_tool_message("propose_change", PROPOSE_MODE_ONLY_REASON)
    assert inside is not None and inside.available is True


def test_read_only_gate_still_blocks_edit_file_in_propose_mode() -> None:
    contract = _contract(propose_mode=True, read_only=True)

    edit = contract.entry("edit_file")
    assert edit is not None and edit.available is False
    assert edit.reason == READ_ONLY_UNAVAILABLE_REASON
    read = contract.entry("read_file")
    assert read is not None and read.available is True


def test_manifest_declares_propose_change_as_a_propose_only_read_tool() -> None:
    entry = manifest_tool_entry("propose_change")

    assert entry is not None
    assert entry["owner"] == "sidecar"
    assert entry["side_effecting"] is False
    assert entry["read_only"] is True
    assert entry["availability"]["propose_mode_only"] is True
    assert entry["availability"]["always_available"] is False
    properties = entry["parameters"]["properties"]
    assert "replace_all" not in properties
    assert set(entry["parameters"]["required"]) >= {"path", "kind", "new_string", "title", "what", "why"}
    assert "someone who doesn't program" in properties["title"]["description"]
    validate_manifest_availability(entry["availability"], label="propose_change")


def test_propose_mode_param_is_a_strict_boolean() -> None:
    assert propose_mode_from_params({}) is False
    assert propose_mode_from_params({"propose_mode": True}) is True
    with pytest.raises(ValueError):
        propose_mode_from_params({"propose_mode": "yes"})


def test_suggested_changes_context_is_bounded_and_drops_malformed_entries() -> None:
    entries = [
        {"id": f"sg_{index}", "path": "a.py", "kind": "replace", "old_string": "x"}
        for index in range(60)
    ]
    entries.insert(0, {"id": "bad", "path": "a.py", "kind": "delete", "old_string": "x"})
    entries.insert(0, "not an object")

    context = suggested_changes_context_from_params(
        {"suggested_changes_context": {"schema_version": 1, "live": entries}}
    )

    assert len(context) == 50
    assert context[0] == {"id": "sg_0", "path": "a.py", "kind": "replace", "old_string": "x"}
    assert suggested_changes_context_from_params({}) == ()
    assert suggested_changes_context_from_params(
        {"suggested_changes_context": {"schema_version": 2, "live": entries}}
    ) == ()


@pytest.mark.parametrize(
    ("requested", "expected"),
    [(None, None), ("none", "none"), ("low", "low"), ("medium", "medium"),
     ("high", "medium"), ("xhigh", "medium"), ("max", "medium")],
)
def test_propose_requests_cap_reasoning_effort_at_medium(requested: str | None, expected: str | None) -> None:
    assert cap_propose_reasoning_effort(requested) == expected


def test_propose_overlay_comes_from_the_packaged_contract() -> None:
    contract = json.loads(
        (ROOT / "services" / "tools" / "propose-mode-contract.json").read_text(encoding="utf-8")
    )

    assert PROPOSE_MODE_OVERLAY_HEADING in RUNTIME_SYSTEM_MESSAGE_HEADINGS
    assert PROPOSE_MODE_GUIDANCE == contract["propose_mode_prompt"]
    assert build_propose_mode_overlay(propose_mode_active=False) == ""
    overlay = build_propose_mode_overlay(propose_mode_active=True)
    assert overlay.startswith(PROPOSE_MODE_OVERLAY_HEADING + "\n")
    assert "propose_change" in overlay
    assert "not applied" in overlay
    messages: list[str] = []
    append_propose_mode_runtime_overlay(messages, propose_mode_active=True)
    assert messages == [overlay]


def test_packaged_sidecar_bundles_the_propose_contract() -> None:
    source = (ROOT / "scripts" / "packaging" / "build_sidecar_artifact.py").read_text(encoding="utf-8")

    assert '"propose-mode-contract.json"' in source


def test_builtin_transport_lists_propose_change_for_dispatch() -> None:
    from sidecar.ai.mcp.builtin_server import TRANSPORT_ARGUMENT_KEYS, _default_tools

    assert "propose_change" in _default_tools(None)
    assert "_jenny_live_suggestions" in TRANSPORT_ARGUMENT_KEYS
