from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import move_file as move_module
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.registry import build_default_registry, build_tool_bindings
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def test_move_file_moves_batch_and_creates_parents(tmp_path: Path) -> None:
    (tmp_path / "one.txt").write_text("one\n", encoding="utf-8")
    (tmp_path / "two.txt").write_text("two\n", encoding="utf-8")

    result = move_module.move_file_tool(
        {
            "moves": [
                {"source": "one.txt", "destination": "archive/a/one.txt"},
                {"source": "two.txt", "destination": "archive/b/two.txt"},
            ]
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert not (tmp_path / "one.txt").exists()
    assert not (tmp_path / "two.txt").exists()
    assert (tmp_path / "archive/a/one.txt").read_text(encoding="utf-8") == "one\n"
    assert (tmp_path / "archive/b/two.txt").read_text(encoding="utf-8") == "two\n"
    assert result.metadata["moved_count"] == 2
    assert result.metadata["moves"] == [
        {"source": "one.txt", "destination": "archive/a/one.txt", "status": "moved"},
        {"source": "two.txt", "destination": "archive/b/two.txt", "status": "moved"},
    ]
    assert [diff["old_path"] for diff in result.metadata["diffs"]] == [
        "one.txt",
        "two.txt",
    ]
    assert [diff["path"] for diff in result.metadata["diffs"]] == [
        "archive/a/one.txt",
        "archive/b/two.txt",
    ]
    assert all(diff["status"] == "renamed" for diff in result.metadata["diffs"])


def test_move_file_incident_case_creates_missing_destination_directory(
    tmp_path: Path,
) -> None:
    (tmp_path / "_b.js").write_text("export const b = 1;\n", encoding="utf-8")

    result = move_module.move_file_tool(
        {
            "source": "_b.js",
            "destination": "neon-vendetta/scripts/_b.js",
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert not (tmp_path / "_b.js").exists()
    assert (tmp_path / "neon-vendetta/scripts").is_dir()
    assert (tmp_path / "neon-vendetta/scripts/_b.js").read_text(
        encoding="utf-8"
    ) == "export const b = 1;\n"


def test_move_file_reorganize_batch_allows_expected_directory_churn(
    tmp_path: Path,
) -> None:
    (tmp_path / "a.js").write_text("a\n", encoding="utf-8")
    (tmp_path / "b.js").write_text("b\n", encoding="utf-8")
    (tmp_path / "scripts").mkdir()

    result = move_module.move_file_tool(
        {
            "moves": [
                {"source": "a.js", "destination": "scripts/a.js"},
                {"source": "b.js", "destination": "scripts/b.js"},
                {
                    "source": "scripts",
                    "destination": "neon-vendetta/scripts",
                },
            ]
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert not (tmp_path / "a.js").exists()
    assert not (tmp_path / "b.js").exists()
    assert not (tmp_path / "scripts").exists()
    assert (tmp_path / "neon-vendetta/scripts/a.js").read_text(
        encoding="utf-8"
    ) == "a\n"
    assert (tmp_path / "neon-vendetta/scripts/b.js").read_text(
        encoding="utf-8"
    ) == "b\n"
    assert [diff["old_path"] for diff in result.metadata["diffs"]] == [
        "a.js",
        "b.js",
        "scripts",
    ]
    directory_diff = result.metadata["diffs"][2]
    assert directory_diff["path"] == "neon-vendetta/scripts"
    assert directory_diff["status"] == "renamed"
    assert directory_diff["hunks"] == []


def test_move_file_validation_failure_moves_nothing(tmp_path: Path) -> None:
    for name in ("one.txt", "two.txt", "four.txt"):
        (tmp_path / name).write_text(name, encoding="utf-8")

    result = move_module.move_file_tool(
        {
            "moves": [
                {"source": "one.txt", "destination": "done/one.txt"},
                {"source": "two.txt", "destination": "done/two.txt"},
                {"source": "three.txt", "destination": "done/three.txt"},
                {"source": "four.txt", "destination": "done/four.txt"},
            ]
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert "entry 3" in result.output.lower()
    assert "path does not exist: three.txt" in result.output
    assert result.metadata["moved_count"] == 0
    assert all((tmp_path / name).exists() for name in ("one.txt", "two.txt", "four.txt"))
    assert not (tmp_path / "done").exists()


def test_move_file_overwrite_checkpoints_clobbered_content(tmp_path: Path) -> None:
    source = tmp_path / "new.txt"
    destination = tmp_path / "existing.txt"
    source.write_text("new bytes\n", encoding="utf-8")
    destination.write_text("recover me\n", encoding="utf-8")

    refused = move_module.move_file_tool(
        {"source": "new.txt", "destination": "existing.txt"},
        _guard(tmp_path),
    )

    assert refused.success is False
    assert "destination already exists" in refused.output
    assert source.read_text(encoding="utf-8") == "new bytes\n"
    assert destination.read_text(encoding="utf-8") == "recover me\n"

    moved = move_module.move_file_tool(
        {
            "source": "new.txt",
            "destination": "existing.txt",
            "overwrite": True,
        },
        _guard(tmp_path),
    )

    assert moved.success is True
    assert not source.exists()
    assert destination.read_text(encoding="utf-8") == "new bytes\n"
    backups = list((tmp_path / ".jenny/backups").glob("*@v*.bak"))
    assert any(backup.read_text(encoding="utf-8") == "recover me\n" for backup in backups)


def test_move_file_refuses_overwrite_onto_existing_directory_in_validation(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.txt"
    destination = tmp_path / "archive"
    source.write_text("keep\n", encoding="utf-8")
    destination.mkdir()

    result = move_module.move_file_tool(
        {
            "source": "source.txt",
            "destination": "archive",
            "overwrite": True,
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert "destination archive is a directory" in result.output
    assert source.read_text(encoding="utf-8") == "keep\n"
    assert destination.is_dir()
    assert not (tmp_path / ".jenny/backups").exists()


def test_move_file_refuses_jenny_source_and_destination(tmp_path: Path) -> None:
    (tmp_path / ".jenny").mkdir()
    (tmp_path / ".jenny/secret.txt").write_text("secret\n", encoding="utf-8")
    (tmp_path / "ordinary.txt").write_text("ordinary\n", encoding="utf-8")

    source_result = move_module.move_file_tool(
        {"source": ".jenny/secret.txt", "destination": "restored.txt"},
        _guard(tmp_path),
    )
    destination_result = move_module.move_file_tool(
        {"source": "ordinary.txt", "destination": ".jenny/moved.txt"},
        _guard(tmp_path),
    )

    assert source_result.success is False
    assert destination_result.success is False
    assert "the .jenny directory holds Jenny's backups and trash" in source_result.output
    assert "the .jenny directory holds Jenny's backups and trash" in destination_result.output
    assert (tmp_path / ".jenny/secret.txt").exists()
    assert (tmp_path / "ordinary.txt").exists()


def test_move_file_refuses_duplicate_destinations(tmp_path: Path) -> None:
    (tmp_path / "one.txt").write_text("one", encoding="utf-8")
    (tmp_path / "two.txt").write_text("two", encoding="utf-8")

    result = move_module.move_file_tool(
        {
            "moves": [
                {"source": "one.txt", "destination": "same.txt"},
                {"source": "two.txt", "destination": "same.txt"},
            ]
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert "duplicate destination" in result.output
    assert (tmp_path / "one.txt").exists()
    assert (tmp_path / "two.txt").exists()
    assert not (tmp_path / "same.txt").exists()


def test_move_file_refuses_destination_that_is_another_source(tmp_path: Path) -> None:
    (tmp_path / "one.txt").write_text("one", encoding="utf-8")
    (tmp_path / "two.txt").write_text("two", encoding="utf-8")

    result = move_module.move_file_tool(
        {
            "moves": [
                {"source": "one.txt", "destination": "two.txt"},
                {"source": "two.txt", "destination": "three.txt"},
            ],
            "overwrite": True,
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert "destination is the source of entry 2" in result.output
    assert (tmp_path / "one.txt").read_text(encoding="utf-8") == "one"
    assert (tmp_path / "two.txt").read_text(encoding="utf-8") == "two"
    assert not (tmp_path / "three.txt").exists()


def test_move_file_refuses_more_than_one_hundred_entries(tmp_path: Path) -> None:
    result = move_module.move_file_tool(
        {
            "moves": [
                {"source": f"source-{index}.txt", "destination": f"dest-{index}.txt"}
                for index in range(101)
            ]
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert "101 entries; the maximum is 100" in result.output
    assert result.metadata["moved_count"] == 0
    assert result.metadata["moves"] == []


def test_move_file_accepts_single_pair_form(tmp_path: Path) -> None:
    (tmp_path / "before.txt").write_text("hello\n", encoding="utf-8")

    result = move_module.move_file_tool(
        {"source": "before.txt", "destination": "after.txt"},
        _guard(tmp_path),
    )

    assert result.success is True
    assert not (tmp_path / "before.txt").exists()
    assert (tmp_path / "after.txt").read_text(encoding="utf-8") == "hello\n"


def test_move_file_refuses_both_batch_and_single_pair_forms(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        move_module.move_file_tool(
            {
                "source": "ignored.txt",
                "destination": "also-ignored.txt",
                "moves": [{"source": "one.txt", "destination": "two.txt"}],
            },
            _guard(tmp_path),
        )

    assert "provide either 'moves'" in excinfo.value.message
    assert "not both" in excinfo.value.message


def test_move_file_same_path_reports_only_same_path_reason(tmp_path: Path) -> None:
    target = tmp_path / "same.txt"
    target.write_text("same\n", encoding="utf-8")

    result = move_module.move_file_tool(
        {"source": "same.txt", "destination": "same.txt"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert "source and destination resolve to the same path" in result.output
    assert "pass overwrite" not in result.output
    assert target.read_text(encoding="utf-8") == "same\n"


def test_move_file_refuses_cross_volume_batch_before_execution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_source = tmp_path / "first.txt"
    second_source = tmp_path / "second.txt"
    first_source.write_text("first\n", encoding="utf-8")
    second_source.write_text("second\n", encoding="utf-8")
    source_device = first_source.lstat().st_dev
    monkeypatch.setattr(
        move_module,
        "_nearest_existing_parent_device",
        lambda parent, _root: (
            source_device + 1 if parent.name == "cross-volume" else source_device
        ),
    )

    result = move_module.move_file_tool(
        {
            "moves": [
                {"source": "first.txt", "destination": "same-volume/first.txt"},
                {
                    "source": "second.txt",
                    "destination": "cross-volume/second.txt",
                },
            ]
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert "cross-volume moves are not supported" in result.output
    assert first_source.read_text(encoding="utf-8") == "first\n"
    assert second_source.read_text(encoding="utf-8") == "second\n"
    assert not (tmp_path / "same-volume").exists()
    assert not (tmp_path / "cross-volume").exists()


def test_move_file_revalidates_before_creating_each_destination_parent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("one.txt", "two.txt", "three.txt"):
        (tmp_path / name).write_text(name, encoding="utf-8")
    real_revalidate = move_module.revalidate_workspace_leaf
    calls = 0

    def _revalidate(identity: object) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ToolExecutionFailure(
                code=move_module.CMP_TOOL_IO_FAILED,
                message="simulated revalidation failure",
                retryable=True,
            )
        real_revalidate(identity)  # type: ignore[arg-type]

    monkeypatch.setattr(move_module, "revalidate_workspace_leaf", _revalidate)
    result = move_module.move_file_tool(
        {
            "moves": [
                {"source": "one.txt", "destination": "first/one.txt"},
                {"source": "two.txt", "destination": "second/two.txt"},
                {"source": "three.txt", "destination": "third/three.txt"},
            ]
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert (tmp_path / "first/one.txt").is_file()
    assert not (tmp_path / "second").exists()
    assert not (tmp_path / "third").exists()
    assert "may leave empty destination directories" in result.output


def test_overwrite_refuses_destination_that_appears_after_batch_validation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.txt"
    destination = tmp_path / "destination.txt"
    source.write_text("source\n", encoding="utf-8")
    real_prepare_destination = move_module._prepare_destination

    def _prepare_destination(*args: object, **kwargs: object):
        destination.write_text("new occupant\n", encoding="utf-8")
        return real_prepare_destination(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(move_module, "_prepare_destination", _prepare_destination)
    result = move_module.move_file_tool(
        {
            "source": "source.txt",
            "destination": "destination.txt",
            "overwrite": True,
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert "destination appeared after batch validation" in result.output
    assert source.read_text(encoding="utf-8") == "source\n"
    assert destination.read_text(encoding="utf-8") == "new occupant\n"


def test_move_file_reports_partial_batch_without_rollback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("one.txt", "two.txt", "three.txt"):
        (tmp_path / name).write_text(name, encoding="utf-8")
    real_replace = move_module.os.replace
    calls = 0

    def _replace(source: object, destination: object) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated race")
        real_replace(source, destination)

    monkeypatch.setattr(move_module.os, "replace", _replace)
    result = move_module.move_file_tool(
        {
            "moves": [
                {"source": "one.txt", "destination": "done/one.txt"},
                {"source": "two.txt", "destination": "done/two.txt"},
                {"source": "three.txt", "destination": "done/three.txt"},
            ]
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.metadata["moved_count"] == 1
    assert [item["status"] for item in result.metadata["moves"]] == [
        "moved",
        "failed",
        "not_moved",
    ]
    assert (tmp_path / "done/one.txt").read_text(encoding="utf-8") == "one.txt"
    assert not (tmp_path / "one.txt").exists()
    assert (tmp_path / "two.txt").exists()
    assert (tmp_path / "three.txt").exists()
    assert "one.txt -> done/one.txt: moved" in result.output
    assert "two.txt -> done/two.txt: failed" in result.output
    assert "three.txt -> done/three.txt: not_moved" in result.output


def test_move_file_bound_by_default_and_gated_by_flag() -> None:
    assert "move_file" in build_tool_bindings(config=None)
    assert "move_file" not in build_tool_bindings(
        config={"tools_move_file_enabled": False}
    )


def test_move_file_present_in_default_registry() -> None:
    assert "move_file" in build_default_registry(config=None)
