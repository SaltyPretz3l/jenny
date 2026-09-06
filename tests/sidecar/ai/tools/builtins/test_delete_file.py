from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_OUTSIDE_WORKSPACE,
)
from sidecar.ai.tools.builtins import delete_file as delete_module
from sidecar.ai.tools.builtins import filesystem as filesystem_module
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.registry import build_default_registry, build_tool_bindings
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _make_junction(link: Path, target: Path) -> bool:
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.returncode == 0


def _can_create_symlink(tmp_path: Path) -> bool:
    target = tmp_path / "symlink-probe-target"
    target.write_text("probe", encoding="utf-8")
    link = tmp_path / "symlink-probe-link"
    try:
        os.symlink(target, link)
    except (NotImplementedError, OSError):
        return False
    finally:
        if link.is_symlink():
            link.unlink()
        target.unlink()
    return True


@pytest.fixture(autouse=True)
def _reset_filesystem_config() -> None:
    filesystem_module.configure_filesystem_tools(None)
    yield
    filesystem_module.configure_filesystem_tools(None)


def test_delete_file_moves_target_to_trash_and_is_reversible(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    result = delete_module.delete_file_tool({"path": "notes.txt"}, _guard(tmp_path))

    assert result.success is True
    assert not target.exists()
    assert result.metadata["kind"] == "file"
    trashed = tmp_path / Path(result.metadata["trashed_path"])
    assert trashed.is_file()
    assert trashed.read_text(encoding="utf-8") == "hello\n"
    assert ".jenny/trash" in str(result.metadata["trashed_path"]).replace("\\", "/")

    # Reversible: moving it back from trash restores the original.
    trashed.replace(target)
    assert target.read_text(encoding="utf-8") == "hello\n"


def test_delete_file_accepts_file_path_alias(tmp_path: Path) -> None:
    (tmp_path / "x.txt").write_text("x\n", encoding="utf-8")

    result = delete_module.delete_file_tool({"file_path": "x.txt"}, _guard(tmp_path))

    assert result.success is True
    assert not (tmp_path / "x.txt").exists()


def test_delete_file_refuses_directory_without_recursive(tmp_path: Path) -> None:
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "a.txt").write_text("a\n", encoding="utf-8")

    result = delete_module.delete_file_tool({"path": "pkg"}, _guard(tmp_path))

    assert result.success is False
    assert "recursive" in result.output.lower()
    assert (tmp_path / "pkg").is_dir()


def test_delete_file_deletes_directory_with_recursive(tmp_path: Path) -> None:
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "a.txt").write_text("a\n", encoding="utf-8")

    result = delete_module.delete_file_tool(
        {"path": "pkg", "recursive": True}, _guard(tmp_path)
    )

    assert result.success is True
    assert not (tmp_path / "pkg").exists()
    assert result.metadata["kind"] == "directory"
    trashed = tmp_path / Path(result.metadata["trashed_path"])
    assert (trashed / "a.txt").read_text(encoding="utf-8") == "a\n"


def test_delete_file_allows_directory_child_churn_before_revalidation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "pkg"
    source.mkdir()
    (source / "original.txt").write_text("original\n", encoding="utf-8")

    def _add_child_before_move(
        _store: GuardedWorkspaceStore,
        _destination: object,
    ) -> None:
        if source.exists():
            (source / "late.txt").write_text("late\n", encoding="utf-8")

    monkeypatch.setattr(
        GuardedWorkspaceStore,
        "_before_operation",
        _add_child_before_move,
    )

    result = delete_module.delete_file_tool(
        {"path": "pkg", "recursive": True},
        _guard(tmp_path),
    )

    assert result.success is True
    trashed = tmp_path / Path(str(result.metadata["trashed_path"]))
    assert (trashed / "original.txt").read_text(encoding="utf-8") == "original\n"
    assert (trashed / "late.txt").read_text(encoding="utf-8") == "late\n"


def test_delete_file_moves_same_root_symlink_object_not_target(tmp_path: Path) -> None:
    if not _can_create_symlink(tmp_path):
        pytest.skip("symlink creation not permitted in this environment")
    target = tmp_path / "important.txt"
    target.write_text("keep\n", encoding="utf-8")
    link = tmp_path / "alias.txt"
    os.symlink(target, link)

    result = delete_module.delete_file_tool({"path": "alias.txt"}, _guard(tmp_path))

    assert result.success is True
    assert target.read_text(encoding="utf-8") == "keep\n"
    assert not link.is_symlink()
    trashed = tmp_path / Path(str(result.metadata["trashed_path"]))
    assert trashed.is_symlink()
    assert trashed.resolve(strict=True) == target.resolve(strict=True)


def test_delete_file_moves_broken_symlink_object(tmp_path: Path) -> None:
    if not _can_create_symlink(tmp_path):
        pytest.skip("symlink creation not permitted in this environment")
    missing_target = tmp_path / "missing.txt"
    link = tmp_path / "broken.txt"
    os.symlink(missing_target, link)

    result = delete_module.delete_file_tool({"path": "broken.txt"}, _guard(tmp_path))

    assert result.success is True
    assert not link.is_symlink()
    trashed = tmp_path / Path(str(result.metadata["trashed_path"]))
    assert trashed.is_symlink()
    assert not trashed.exists()


def test_delete_file_moves_outside_target_link_without_touching_target(tmp_path: Path) -> None:
    if not _can_create_symlink(tmp_path):
        pytest.skip("symlink creation not permitted in this environment")
    outside = tmp_path.parent / f"{tmp_path.name}-outside-target.txt"
    outside.write_text("outside\n", encoding="utf-8")
    link = tmp_path / "outside-alias.txt"
    try:
        os.symlink(outside, link)

        result = delete_module.delete_file_tool(
            {"path": "outside-alias.txt"}, _guard(tmp_path)
        )

        assert result.success is True
        assert outside.read_text(encoding="utf-8") == "outside\n"
        assert not link.is_symlink()
        trashed = tmp_path / Path(str(result.metadata["trashed_path"]))
        assert trashed.is_symlink()
    finally:
        outside.unlink(missing_ok=True)


def test_delete_file_refuses_jenny_directory(tmp_path: Path) -> None:
    backups = tmp_path / ".jenny" / "backups"
    backups.mkdir(parents=True)
    keep = backups / "keep.bak"
    keep.write_text("x\n", encoding="utf-8")

    result = delete_module.delete_file_tool(
        {"path": ".jenny/backups/keep.bak"}, _guard(tmp_path)
    )

    assert result.success is False
    assert ".jenny" in result.output
    assert keep.exists()


def test_delete_file_reports_missing_path(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        delete_module.delete_file_tool({"path": "nope.txt"}, _guard(tmp_path))
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


def test_delete_file_rejects_path_outside_workspace(tmp_path: Path) -> None:
    outside = tmp_path.parent / f"{tmp_path.name}_outside.txt"
    outside.write_text("secret\n", encoding="utf-8")
    try:
        with pytest.raises(ToolExecutionFailure) as excinfo:
            delete_module.delete_file_tool(
                {"path": f"../{outside.name}"}, _guard(tmp_path)
            )
        assert excinfo.value.code == CMP_TOOL_OUTSIDE_WORKSPACE
        assert outside.read_text(encoding="utf-8") == "secret\n"
    finally:
        outside.unlink(missing_ok=True)


def test_delete_file_requires_non_empty_path(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        delete_module.delete_file_tool({"path": "   "}, _guard(tmp_path))
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


def test_delete_file_reports_guarded_store_refusal_without_moving_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    def _fail(*_args: object, **_kwargs: object) -> object:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="workspace store parent changed before use",
            retryable=True,
        )

    # WIDE-044: delete_file builds its store via workspace.internal_store()
    # now, so the patch targets the class where it is defined.
    monkeypatch.setattr(
        GuardedWorkspaceStore,
        "move_workspace_leaf_atomic",
        _fail,
    )

    result = delete_module.delete_file_tool({"path": "notes.txt"}, _guard(tmp_path))

    assert result.success is False
    assert target.exists()
    assert target.read_text(encoding="utf-8") == "hello\n"


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_delete_file_quarantines_junctioned_jenny_root(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()

    if not _make_junction(tmp_path / ".jenny", elsewhere):
        pytest.skip("mklink /J not permitted in this environment")
    result = delete_module.delete_file_tool({"path": "notes.txt"}, _guard(tmp_path))

    assert result.success is True
    assert not target.exists()
    assert list(elsewhere.iterdir()) == []
    quarantine = tmp_path / ".jenny" / "quarantine"
    assert quarantine.is_dir()
    assert any(entry.name.startswith("layout-jenny") for entry in quarantine.iterdir())


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_delete_file_moves_directory_junction_object_not_target(tmp_path: Path) -> None:
    target = tmp_path / "important-dir"
    target.mkdir()
    sentinel = target / "keep.txt"
    sentinel.write_text("keep", encoding="utf-8")
    junction = tmp_path / "alias-dir"
    if not _make_junction(junction, target):
        pytest.skip("mklink /J not permitted in this environment")

    result = delete_module.delete_file_tool({"path": "alias-dir"}, _guard(tmp_path))

    assert result.success is True
    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert not junction.exists()
    trashed = tmp_path / Path(str(result.metadata["trashed_path"]))
    assert trashed.is_dir()
    assert (trashed / "keep.txt").read_text(encoding="utf-8") == "keep"
    os.rmdir(trashed)


def test_delete_file_bound_by_default_and_gated_by_flag() -> None:
    assert "delete_file" in build_tool_bindings(config=None)
    assert "delete_file" not in build_tool_bindings(
        config={"tools_delete_file_enabled": False}
    )


def test_delete_file_present_in_default_registry() -> None:
    # Confirms the manifest entry and the handler binding agree by name.
    assert "delete_file" in build_default_registry(config=None)
