"""W7b-S4: the merged `lsp` tool — the first actioned tool on the surface.

Pins the spec §6.3 lsp-family merge contract: one manifest entry with an
``action`` enum, four read-only actions, dispatcher routing in
``builtins/lsp/tools.py``, registry binding on the single ``lsp`` name,
two-regime read-only listing, action-aware policy resolution, and approval
presentation.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.config_models import ToolPolicySnapshot
from sidecar.ai.tools.assembly import (
    ToolAssemblyContext,
    assemble_tool_contract,
)
from sidecar.ai.tools.catalog import MANAGED_SIDECAR_SURFACE, build_tool_catalog
from sidecar.ai.tools.policy import (
    approval_presentation_for_call,
    evaluate_tool_policy,
)
from sidecar.ai.tools.tool_actions import (
    ToolActionSpec,
    has_any_non_side_effecting_action,
)
from sidecar.ai.tools.workspace import WorkspaceGuard

_RETIRED_NAMES = ("lsp_diagnostics", "lsp_symbols", "lsp_definition", "lsp_references")
_ACTIONS = ("diagnostics", "symbols", "definition", "references")


def _lsp_descriptor(*, bound: bool = False):
    # bound=True marks the tool runtime-registered (the builtin server's
    # bound_names seam) so assembly can list it; policy/metadata tests can use
    # the plain catalog descriptor.
    bound_names = ("lsp",) if bound else ()
    matches = [
        item
        for item in build_tool_catalog(bound_names=bound_names)
        if item.name == "lsp"
    ]
    assert len(matches) == 1, f"expected exactly one lsp descriptor, got {len(matches)}"
    return matches[0]


class TestManifestSurface:
    def test_manifest_has_one_lsp_tool_and_no_retired_names(self) -> None:
        names = {item.name for item in build_tool_catalog()}
        assert "lsp" in names
        assert not names.intersection(_RETIRED_NAMES)

    def test_lsp_descriptor_carries_four_read_only_actions(self) -> None:
        descriptor = _lsp_descriptor()
        assert descriptor.actions == {
            action: ToolActionSpec(side_effecting=False) for action in _ACTIONS
        }
        assert descriptor.side_effecting is False
        assert descriptor.read_only is True
        assert has_any_non_side_effecting_action(descriptor)

    def test_action_enum_matches_declared_actions(self) -> None:
        descriptor = _lsp_descriptor()
        properties = descriptor.input_schema["properties"]
        assert sorted(properties["action"]["enum"]) == sorted(_ACTIONS)
        assert set(descriptor.input_schema["required"]) == {"action", "path"}

    def test_config_flag_and_family_unchanged(self) -> None:
        descriptor = _lsp_descriptor()
        assert descriptor.availability.config_flag == "tools_lsp_enabled"
        assert descriptor.tool_family == "code_intelligence"


def _workspace(tmp_path: Path) -> WorkspaceGuard:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir(exist_ok=True)
    (workspace_root / "module.py").write_text("value = 1\n", encoding="utf-8")
    return WorkspaceGuard(str(workspace_root))


class TestDispatch:
    @pytest.mark.parametrize(
        ("action", "expected_kind", "extra"),
        [
            ("diagnostics", "lsp_diagnostics", {}),
            ("symbols", "lsp_symbols", {}),
            ("definition", "lsp_definition", {"line": 1, "character": 2}),
            ("references", "lsp_references", {"line": 1, "character": 2}),
        ],
    )
    def test_each_action_routes_to_its_request_kind(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        action: str,
        expected_kind: str,
        extra: dict[str, object],
    ) -> None:
        from sidecar.ai.tools.builtins.lsp import tools as lsp_tools

        captured: dict[str, str] = {}

        def _fake_run(*, target: object, workspace: object, spec: object) -> str:
            captured["kind"] = spec.result_kind  # type: ignore[attr-defined]
            return "sentinel"

        monkeypatch.setattr(lsp_tools, "_run_lsp_request", _fake_run)
        result = lsp_tools.lsp_tool(
            {"action": action, "path": "module.py", **extra},
            _workspace(tmp_path),
        )
        assert result == "sentinel"
        assert captured["kind"] == expected_kind

    def test_unknown_action_fails_closed(self, tmp_path: Path) -> None:
        from sidecar.ai.tools.builtins.lsp import tools as lsp_tools

        result = lsp_tools.lsp_tool(
            {"action": "explode", "path": "module.py"},
            _workspace(tmp_path),
        )
        assert getattr(result, "error_code", None), (
            "an undeclared action must produce a structured failure"
        )

    def test_missing_action_fails_closed(self, tmp_path: Path) -> None:
        from sidecar.ai.tools.builtins.lsp import tools as lsp_tools

        result = lsp_tools.lsp_tool(
            {"path": "module.py"},
            _workspace(tmp_path),
        )
        assert getattr(result, "error_code", None), (
            "a missing action must produce a structured failure"
        )


class TestRegistryBinding:
    def test_registry_binds_single_lsp_name_when_enabled(self) -> None:
        from sidecar.ai.tools.registry import build_tool_bindings

        bindings = build_tool_bindings(config={"tools_lsp_enabled": True})
        assert "lsp" in bindings
        assert not set(bindings).intersection(_RETIRED_NAMES)

    def test_registry_omits_lsp_when_disabled(self) -> None:
        from sidecar.ai.tools.registry import build_tool_bindings

        bindings = build_tool_bindings(config={"tools_lsp_enabled": False})
        assert "lsp" not in bindings
        assert not set(bindings).intersection(_RETIRED_NAMES)


class TestListingAndPolicy:
    def test_lsp_listed_in_read_only_context(self) -> None:
        # Two-regime rule (S1): an actioned descriptor lists iff any
        # non-side-effecting action exists — all four lsp actions are reads.
        descriptor = _lsp_descriptor(bound=True)
        contract = assemble_tool_contract(
            (descriptor,),
            ToolAssemblyContext(
                surface=MANAGED_SIDECAR_SURFACE,
                config={"tools_lsp_enabled": True},
                engine_supports_tool_calling=True,
                mode="assist",
                plan_mode=False,
                workspace_root_present=True,
                read_only=True,
            ),
        )
        entry = contract.entry("lsp")
        assert entry.available is True, entry.reason

    def test_read_action_resolves_auto_with_no_grants(self) -> None:
        decision = evaluate_tool_policy(
            descriptor=_lsp_descriptor(),
            arguments={"action": "symbols", "path": "module.py"},
            mode="agent",
            snapshot=ToolPolicySnapshot(),
        )
        assert decision.decision == "auto"

    def test_composite_deny_binds_for_its_action(self) -> None:
        # Migrated grants land as composite legacy entries; a deny scoped to
        # one action must still bind (never-widening).
        snapshot = ToolPolicySnapshot(legacy_policies=(("lsp:definition", "deny"),))
        decision = evaluate_tool_policy(
            descriptor=_lsp_descriptor(),
            arguments={"action": "definition", "path": "module.py", "line": 0, "character": 0},
            mode="agent",
            snapshot=snapshot,
        )
        assert decision.decision == "deny"

    def test_approval_presentation_is_read_shaped_for_every_action(self) -> None:
        descriptor = _lsp_descriptor()
        for action in _ACTIONS:
            presentation = approval_presentation_for_call(
                descriptor, {"action": action, "path": "module.py"}
            )
            assert presentation.policy_consequence == "May read data in this scope."
