"""Cross-layer parity: every Electron-owned manifest tool must reach the model.

`services/tools/tool-manifest.json` marks Electron-owned tools with
``owner: "electron"``. Electron registers and executes them, but they only
become model-visible if the sidecar's tool resolver hands them to the provider.
`ask_user` shipped with the Electron half complete and the sidecar half missing,
so the plan-mode prompt instructed the model to call a tool that was never in
its schema. This test asserts at the PROVIDER PAYLOAD level -- the layer that
actually failed -- so it exercises runtime registration, the read-only gate, the
plan-mode gate, workspace gating, and budget filtering, not just the resolver's
name derivation.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing import tool_resolution
from sidecar.runtime.chat_models import ChatRequestContext

_MANIFEST_PATH = (
    Path(__file__).resolve().parents[4] / "services" / "tools" / "tool-manifest.json"
)

# Written out rather than recomputed from `owner == "electron"`. The resolver now
# derives its bridge set from that same predicate, so a test that recomputed it
# would agree with any derivation, including a broken one. Spelling the roster out
# means a thirteenth Electron-owned tool reds this file until someone extends the
# literal on purpose -- the review beat `ask_user` skipped.
EXPECTED_ELECTRON_BRIDGE_TOOLS = frozenset(
    {
        "ask_user",
        "automation_list",
        "automation_read",
        "exit_plan_mode",
        "home",
        "jenny_status",
        "preview_test",
        # Added deliberately (WO-10): `task_board` writes durable agent_task
        # follow-ups into the Open Loops store through Electron; side-effecting,
        # so it is withheld from the plan-mode schema like `verify`.
        "task_board",
        # Added deliberately: `verify` runs one of the user's own saved Test
        # Runner configurations through WorkspaceTestRunnerService. It is the
        # first Electron-owned tool that is NOT read-only, so it is correctly
        # withheld from the plan-mode schema by the read-only gate below.
        "verify",
        "workspace_present",
        "worktree_create",
        "worktree_delete",
        "worktree_list",
        "worktree_select",
    }
)


class _MCPClient:
    available_tools: list[object] = []

    def execute_tool(self, *_args: object, **_kwargs: object) -> object:
        raise AssertionError("Electron-owned tools must execute through the bridge")

    def tool_descriptor(self, _tool_name: str) -> None:
        return None


def _electron_owned_entries() -> list[dict[str, Any]]:
    payload = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
    return [
        entry
        for entry in payload["tools"]
        if str(entry.get("owner") or "") == "electron"
    ]


def _kernel(workspace_root: str, **overrides: bool) -> SimpleNamespace:
    # RuntimeConfig is frozen, so flag variations are constructed, not mutated.
    flags: dict[str, object] = {
        "electron_tool_bridge_enabled": True,
        "tools_worktree_enabled": True,
        "tools_automations_enabled": True,
        "tools_workspace_present_enabled": True,
        "tools_preview_test_enabled": True,
        "tools_verify_enabled": True,
        "tools_home_enabled": True,
        "tools_task_board_enabled": True,
        "tools_workspace_root": workspace_root,
        "mode": "assist",
    }
    flags.update(overrides)
    return SimpleNamespace(
        _config=RuntimeConfig(**flags),
        _mcp_client=_MCPClient(),
        _engine=SimpleNamespace(supports_tool_calling=True),
        _active_cancel_handle=None,
    )


def _payload_names(kernel: SimpleNamespace, *, plan_mode: bool) -> set[str]:
    request_context = ChatRequestContext(
        request_id="req_parity",
        trace_id="trace_parity",
        session_id="session_parity",
        mode="assist",
        approvals_pre_granted=True,
        plan_mode=plan_mode,
        read_only=plan_mode,
        workspace_root_present=True,
    )
    payload = tool_resolution.build_tool_payload(
        kernel, None, request_context=request_context
    )
    return {str(schema["name"]) for schema in payload}


def test_the_expected_bridge_roster_matches_the_manifest(tmp_path) -> None:
    declared = {entry["name"] for entry in _electron_owned_entries()}
    assert declared == EXPECTED_ELECTRON_BRIDGE_TOOLS, (
        "services/tools/tool-manifest.json changed which tools Electron owns. "
        "Extend EXPECTED_ELECTRON_BRIDGE_TOOLS deliberately, then confirm the "
        "new tool actually reaches the provider schema below."
    )


def test_electron_owned_manifest_tools_reach_the_provider_schema(tmp_path) -> None:
    names = _payload_names(_kernel(str(tmp_path)), plan_mode=False)
    plan_mode_only = {
        entry["name"]
        for entry in _electron_owned_entries()
        if (entry.get("availability") or {}).get("plan_mode_only")
    }
    expected = EXPECTED_ELECTRON_BRIDGE_TOOLS - plan_mode_only

    missing = sorted(expected - names)
    assert not missing, (
        "Electron-owned tools missing from the provider schema: "
        f"{missing}. Every owner=electron tool must reach the model through the "
        "sidecar Electron-bridge descriptors."
    )
    assert plan_mode_only.isdisjoint(names)


def test_electron_owned_read_only_tools_reach_the_plan_mode_schema(tmp_path) -> None:
    names = _payload_names(_kernel(str(tmp_path)), plan_mode=True)
    expected = {
        entry["name"]
        for entry in _electron_owned_entries()
        if entry.get("read_only") is True
    } & EXPECTED_ELECTRON_BRIDGE_TOOLS

    # Plan mode is read-only, so write-capable Electron tools are correctly
    # withheld; every read-only one -- including `ask_user`, which the plan-mode
    # prompt instructs the model to call -- must be offered. This pair is the
    # point: no derivation-level assertion can show that `ask_user` survives the
    # read-only gate while `exit_plan_mode` gates on mode.
    missing = sorted(expected - names)
    assert not missing, (
        "read-only Electron-owned tools missing from the plan-mode provider "
        f"schema: {missing}"
    )
    assert {"ask_user", "exit_plan_mode"} <= names


@pytest.mark.parametrize(
    ("config_flag", "gated_tools"),
    [
        ("tools_worktree_enabled", {"worktree_list", "worktree_create", "worktree_select", "worktree_delete"}),
        ("tools_automations_enabled", {"automation_list", "automation_read"}),
        ("tools_workspace_present_enabled", {"workspace_present"}),
        ("tools_preview_test_enabled", {"preview_test"}),
        ("tools_verify_enabled", {"verify"}),
        ("tools_home_enabled", {"home"}),
        ("tools_task_board_enabled", {"task_board"}),
    ],
)
def test_manifest_config_flags_still_gate_their_bridge_groups(
    tmp_path, config_flag: str, gated_tools: set[str]
) -> None:
    # Byte-identity guard for the deleted ELECTRON_*_TOOL_NAMES tuples: the
    # manifest's availability.config_flag must gate exactly the group its tuple
    # used to, and nothing else. Asserted on the bridge descriptors themselves,
    # not on the payload -- assembly re-checks the same flag downstream, so a
    # payload-level assertion here passes even if the resolver stops gating at
    # all (verified by mutation), which would leave runtime_registered lying.
    kernel = _kernel(str(tmp_path), **{config_flag: False})
    bridged = {
        descriptor.name
        for descriptor in tool_resolution._electron_bridge_runtime_descriptors(
            kernel._config
        )
    }

    assert gated_tools.isdisjoint(bridged)
    assert EXPECTED_ELECTRON_BRIDGE_TOOLS - gated_tools == bridged
    # ...and the user-visible consequence still holds end to end.
    assert gated_tools.isdisjoint(_payload_names(kernel, plan_mode=False))


def test_every_expected_bridge_tool_is_registered_when_all_flags_are_on(
    tmp_path,
) -> None:
    bridged = {
        descriptor.name
        for descriptor in tool_resolution._electron_bridge_runtime_descriptors(
            _kernel(str(tmp_path))._config
        )
    }
    assert bridged == EXPECTED_ELECTRON_BRIDGE_TOOLS
    assert not tool_resolution._electron_bridge_runtime_descriptors(
        _kernel(str(tmp_path), electron_tool_bridge_enabled=False)._config
    )
