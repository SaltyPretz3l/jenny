"""Red-first contract for the W3 precondition probe registry.

The manifest declares WHICH probe; this module owns HOW. One probe function
per fact, shared by assembly-time rendering AND call-time enforcement, so the
Session Environment block, the Executable Tools split, and the runtime failure
can never disagree about the same fact (spec Part 5).
"""

from __future__ import annotations

from pathlib import Path

from sidecar.ai.tools.preconditions import (
    PRECONDITION_PROBES,
    PRECONDITION_RENDER,
    PRECONDITION_SEVERITIES,
    ProbeContext,
    run_probe,
)


def test_registry_is_closed_and_names_the_spec_probes() -> None:
    assert set(PRECONDITION_PROBES) == {
        "workspace_present",
        "git_root_present",
        "python_runtime_ready",
    }
    assert PRECONDITION_SEVERITIES == ("blocking", "advisory")


def test_every_probe_has_render_templates() -> None:
    # reason + fix, both non-empty, keyed by precondition id used in the
    # manifest (git_repo / python_runtime / workspace).
    for precondition_id, (reason, fix) in PRECONDITION_RENDER.items():
        assert reason.strip(), precondition_id
        assert fix.strip(), precondition_id


def test_workspace_present_probe(tmp_path: Path) -> None:
    assert run_probe("workspace_present", ProbeContext(workspace_root=tmp_path)) is True
    assert run_probe("workspace_present", ProbeContext(workspace_root=None)) is False
    missing = tmp_path / "gone"
    assert run_probe("workspace_present", ProbeContext(workspace_root=missing)) is False


def test_git_root_present_probe_matches_the_shared_expression(tmp_path: Path) -> None:
    context = ProbeContext(workspace_root=tmp_path)
    assert run_probe("git_root_present", context) is False
    (tmp_path / ".git").mkdir()
    assert run_probe("git_root_present", context) is True


def test_unknown_probe_fails_closed(tmp_path: Path) -> None:
    assert run_probe("no_such_probe", ProbeContext(workspace_root=tmp_path)) is False


def test_probe_exceptions_fail_closed() -> None:
    # A broken context must degrade to "unmet", never raise into assembly.
    class _Broken:
        pass

    assert run_probe("git_root_present", _Broken()) is False  # type: ignore[arg-type]
