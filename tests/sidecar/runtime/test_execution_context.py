from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.runtime.execution_context import execution_context_from_params


def _payload(root: Path | None) -> dict[str, object]:
    rooted = root is not None
    return {
        "schema_version": 1,
        "authority_revision": "authority_1",
        "project_id": "project_alpha",
        "root_path": str(root) if rooted else None,
        "root_id": "root_1234567890abcdef12345678" if rooted else None,
        "root_revision": 4,
        "device_id": "11" if rooted else None,
        "inode": "101" if rooted else None,
        "tool_policy_snapshot": {"version": 3, "legacy_policies": {"read_file": "auto"}},
        "knowledge_roots": [str(root / "knowledge")] if rooted else [],
        "skills_config": {
            "skills_bundled_root": str(root / "bundled") if rooted else None,
            "skills_user_root": str(root / "user") if rooted else None,
            "skills_project_root": str(root / ".jenny" / "skills") if rooted else None,
            "skills_bundled_enabled": rooted,
            "skills_user_enabled": rooted,
            "skills_project_enabled": rooted,
            "skills_disabled_ids": ["project/disabled"] if rooted else [],
            "skills_auto_index": "auto",
        },
    }


def test_execution_context_is_frozen_and_round_trips(tmp_path: Path) -> None:
    payload = _payload(tmp_path.resolve())
    context = execution_context_from_params({"execution_context": payload})
    assert context is not None
    payload["knowledge_roots"] = []
    assert context.knowledge_roots == (str(tmp_path.resolve() / "knowledge"),)
    assert context.tool_policy_snapshot.legacy_decision_for("read_file") == "auto"
    assert context.to_wire()["skills_config"]["skills_auto_index"] == "auto"


def test_execution_context_null_root_is_conversation_only() -> None:
    context = execution_context_from_params({"execution_context": _payload(None)})
    assert context is not None
    assert context.root_path is None
    assert context.workspace_root_present is False


def test_null_root_rejects_knowledge_or_project_skill_authority(tmp_path: Path) -> None:
    payload = _payload(None)
    payload["knowledge_roots"] = [str(tmp_path.resolve())]
    with pytest.raises(ValueError, match="cannot authorize project resources"):
        execution_context_from_params({"execution_context": payload})

    payload = _payload(None)
    payload["skills_config"]["skills_project_root"] = str(tmp_path.resolve())
    with pytest.raises(ValueError, match="cannot authorize project resources"):
        execution_context_from_params({"execution_context": payload})


def test_execution_context_rejects_incoherent_or_extra_authority(tmp_path: Path) -> None:
    payload = _payload(tmp_path.resolve())
    payload["inode"] = None
    with pytest.raises(ValueError, match="incomplete"):
        execution_context_from_params({"execution_context": payload})
    payload = _payload(tmp_path.resolve())
    payload["forged"] = True
    with pytest.raises(ValueError, match="exact version-1"):
        execution_context_from_params({"execution_context": payload})


def test_missing_transition_skills_config_disables_project_scope(tmp_path: Path) -> None:
    payload = _payload(tmp_path.resolve())
    payload.pop("skills_config")
    context = execution_context_from_params({"execution_context": payload})
    assert context is not None
    assert context.skills_config is None
