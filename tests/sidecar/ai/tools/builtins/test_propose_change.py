"""propose_change: validated suggestions that never touch the workspace (Plan Plus C2)."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import filesystem as filesystem_module
from sidecar.ai.tools.builtins import propose_change as propose_module
from sidecar.ai.tools.builtins.propose_suggestion import (
    LIVE_SUGGESTIONS_ARG,
    MAX_FILES_PER_REQUEST,
    MAX_SUGGESTION_STRING_CHARS,
    MAX_SUGGESTIONS_PER_REQUEST,
    RECORDED_TEXT,
    TOO_LARGE_TEXT,
    trim_plain_text,
)
from sidecar.ai.tools.workspace import WorkspaceGuard

_SOURCE = "def greet(name):\r\n    return 'hi ' + name\r\n\r\ndef bye():\r\n    return 'bye'\r\n"


@pytest.fixture(autouse=True)
def _reset_filesystem_config() -> Iterator[None]:
    filesystem_module.configure_filesystem_tools(None)
    yield
    filesystem_module.configure_filesystem_tools(None)


def _workspace(tmp_path: Path) -> tuple[Path, WorkspaceGuard, Path]:
    root = tmp_path / "ws"
    root.mkdir()
    snapshots = tmp_path / "snapshots"
    guard = WorkspaceGuard(str(root), pre_change_snapshot_root=str(snapshots))
    return root, guard, snapshots


def _replace_args(**overrides: object) -> dict[str, object]:
    args: dict[str, object] = {
        "path": "app.py",
        "kind": "replace",
        "old_string": "return 'hi ' + name",
        "new_string": "return 'hello ' + name",
        "title": "Friendlier greeting",
        "what": "The greeting says hello instead of hi.",
        "why": "It reads warmer.",
    }
    args.update(overrides)
    return args


def _write_source(root: Path) -> Path:
    target = root / "app.py"
    target.write_bytes(_SOURCE.encode("utf-8"))
    return target


def test_replace_records_metadata_and_leaves_disk_untouched(tmp_path: Path) -> None:
    root, guard, snapshots = _workspace(tmp_path)
    target = _write_source(root)

    result = propose_module.propose_change_tool(_replace_args(watch_for="Tests that pin 'hi'."), guard)

    assert result.success is True, result.output
    assert result.output == RECORDED_TEXT
    assert target.read_bytes() == _SOURCE.encode("utf-8")
    assert not snapshots.exists()
    assert sorted(path.name for path in root.iterdir()) == ["app.py"]
    record = result.metadata["suggested_change"]
    assert isinstance(record, dict)
    lf_text = _SOURCE.replace("\r\n", "\n")
    assert record["schema_version"] == 1
    assert record["path"] == "app.py"
    assert record["kind"] == "replace"
    assert record["old_string"] == "return 'hi ' + name"
    assert record["new_string"] == "return 'hello ' + name"
    assert record["title"] == "Friendlier greeting"
    assert record["what"] == "The greeting says hello instead of hi."
    assert record["why"] == "It reads warmer."
    assert record["watch_for"] == "Tests that pin 'hi'."
    assert record["revises"] is None
    assert record["base_hash"] == "sha256:" + hashlib.sha256(lf_text.encode("utf-8")).hexdigest()
    diff = record["diff"]
    assert isinstance(diff, dict)
    assert diff["status"] == "modified"
    assert diff["before_hash"] == record["base_hash"]
    assert diff["additions"] == 1 and diff["deletions"] == 1
    # The suggestion is not an applied change: no top-level diff or change set.
    assert "diff" not in result.metadata
    assert "workspace_change_set" not in result.metadata


def test_create_records_null_base_hash_and_writes_nothing(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)

    result = propose_module.propose_change_tool(
        {
            "path": "pkg/new_module.py",
            "kind": "create",
            "new_string": "VALUE = 1\n",
            "title": "Add a settings file",
            "what": "Adds a small settings file.",
            "why": "The greeting needs a place for its default.",
        },
        guard,
    )

    assert result.success is True, result.output
    assert not (root / "pkg").exists()
    record = result.metadata["suggested_change"]
    assert record["kind"] == "create"
    assert record["path"] == "pkg/new_module.py"
    assert record["old_string"] == ""
    assert record["base_hash"] is None
    assert record["diff"]["status"] == "created"


def test_create_refuses_an_existing_path(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)

    result = propose_module.propose_change_tool(
        {"path": "app.py", "kind": "create", "new_string": "x\n", "title": "t", "what": "w", "why": "y"},
        guard,
    )

    assert result.success is False
    assert "already exists" in result.output


def test_create_refuses_a_path_outside_the_workspace(tmp_path: Path) -> None:
    _, guard, _ = _workspace(tmp_path)

    result = propose_module.propose_change_tool(
        {"path": "../escape.py", "kind": "create", "new_string": "x\n", "title": "t", "what": "w", "why": "y"},
        guard,
    )

    assert result.success is False
    assert not (tmp_path / "escape.py").exists()


def test_replace_refuses_reserved_internal_state(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    (root / ".jenny").mkdir()
    (root / ".jenny" / "state.txt").write_text("a\n", encoding="utf-8")

    result = propose_module.propose_change_tool(
        _replace_args(path=".jenny/state.txt", old_string="a", new_string="b"), guard
    )

    assert result.success is False


@pytest.mark.parametrize("extra", [{"replace_all": True}, {"edits": [{"old_string": "a", "new_string": "b"}]}])
def test_replace_all_and_edits_are_refused(tmp_path: Path, extra: dict[str, object]) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)

    result = propose_module.propose_change_tool(_replace_args(**extra), guard)

    assert result.success is False
    assert "one change" in result.output


def test_no_match_message_says_the_file_is_unchanged(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)

    result = propose_module.propose_change_tool(
        _replace_args(old_string="return 'hello ' + name", new_string="return 'hey ' + name"),
        guard,
    )

    assert result.success is False
    assert "Target string not found in file: app.py." in result.output
    assert "already edited" not in result.output
    assert "Suggested changes are not applied: the file on disk is unchanged." in result.output


def test_ambiguous_match_never_suggests_replace_all(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)

    result = propose_module.propose_change_tool(_replace_args(old_string="return '"), guard)

    assert result.success is False
    assert "Found 2 matches in app.py" in result.output
    assert "replace_all" not in result.output


def test_identical_new_string_is_refused(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)

    result = propose_module.propose_change_tool(
        _replace_args(new_string="return 'hi ' + name"), guard
    )

    assert result.success is False
    assert "identical" in result.output


def test_replace_requires_old_string(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)
    args = _replace_args()
    del args["old_string"]

    result = propose_module.propose_change_tool(args, guard)

    assert result.success is False


@pytest.mark.parametrize("field", ["old_string", "new_string"])
def test_oversized_strings_are_refused_not_truncated(tmp_path: Path, field: str) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)

    result = propose_module.propose_change_tool(
        _replace_args(**{field: "x" * (MAX_SUGGESTION_STRING_CHARS + 1)}), guard
    )

    assert result.success is False
    assert result.output == TOO_LARGE_TEXT


def test_plain_words_fields_are_trimmed_never_refused(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)
    long_title = "Make the greeting " + "much " * 30 + "friendlier"

    result = propose_module.propose_change_tool(
        _replace_args(
            title=long_title,
            what="One. Two. Three.",
            why=None,
            watch_for="First thing. Second thing.",
        ),
        guard,
    )

    assert result.success is True, result.output
    record = result.metadata["suggested_change"]
    assert len(record["title"]) <= 80
    assert record["title"].endswith("…")
    assert not record["title"][:-1].endswith(" ")
    assert record["what"] == "One. Two."
    assert record["why"] == ""
    assert record["watch_for"] == "First thing."


def test_trim_plain_text_cuts_at_a_word_boundary() -> None:
    assert trim_plain_text("alpha beta gamma", max_chars=12) == "alpha beta…"
    assert trim_plain_text("short", max_chars=12) == "short"
    assert trim_plain_text("  ", max_chars=12) == ""
    assert trim_plain_text(42, max_chars=12) == ""


def _live(*entries: dict[str, object], count: int = 0, paths: tuple[str, ...] = ()) -> dict[str, object]:
    return {"live": list(entries), "request_count": count, "request_paths": list(paths)}


def test_overlap_with_a_live_suggestion_is_refused(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)
    live = _live({"id": "sg_1", "path": "app.py", "kind": "replace", "old_string": "def greet(name):\n    return 'hi '"})

    result = propose_module.propose_change_tool(
        _replace_args(**{LIVE_SUGGESTIONS_ARG: live}), guard
    )

    assert result.success is False
    assert "sg_1" in result.output
    assert "revises" in result.output


def test_overlap_is_allowed_when_it_revises_that_suggestion(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)
    live = _live({"id": "sg_1", "path": "app.py", "kind": "replace", "old_string": "def greet(name):\n    return 'hi '"})

    result = propose_module.propose_change_tool(
        _replace_args(revises="sg_1", **{LIVE_SUGGESTIONS_ARG: live}), guard
    )

    assert result.success is True, result.output
    assert result.metadata["suggested_change"]["revises"] == "sg_1"


def test_disjoint_regions_and_other_files_do_not_overlap(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)
    live = _live(
        {"id": "sg_1", "path": "app.py", "kind": "replace", "old_string": "return 'bye'"},
        {"id": "sg_2", "path": "other.py", "kind": "replace", "old_string": "return 'hi ' + name"},
    )

    result = propose_module.propose_change_tool(
        _replace_args(**{LIVE_SUGGESTIONS_ARG: live}), guard
    )

    assert result.success is True, result.output


def test_two_creates_for_one_path_overlap(tmp_path: Path) -> None:
    _, guard, _ = _workspace(tmp_path)
    live = _live({"id": "sg_9", "path": "new.py", "kind": "create", "old_string": ""})

    result = propose_module.propose_change_tool(
        {
            "path": "new.py", "kind": "create", "new_string": "x = 1\n",
            "title": "t", "what": "w", "why": "y", LIVE_SUGGESTIONS_ARG: live,
        },
        guard,
    )

    assert result.success is False
    assert "sg_9" in result.output


def test_eleventh_suggestion_is_refused_with_stop_and_summarize(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)
    live = _live(count=MAX_SUGGESTIONS_PER_REQUEST, paths=("app.py",))

    result = propose_module.propose_change_tool(
        _replace_args(**{LIVE_SUGGESTIONS_ARG: live}), guard
    )

    assert result.success is False
    assert "Stop" in result.output and "summar" in result.output


def test_sixth_distinct_file_is_refused(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)
    paths = tuple(f"f{index}.py" for index in range(MAX_FILES_PER_REQUEST))
    live = _live(count=MAX_FILES_PER_REQUEST, paths=paths)

    refused = propose_module.propose_change_tool(_replace_args(**{LIVE_SUGGESTIONS_ARG: live}), guard)
    allowed = propose_module.propose_change_tool(
        _replace_args(**{LIVE_SUGGESTIONS_ARG: _live(count=MAX_FILES_PER_REQUEST, paths=(*paths[:-1], "app.py"))}),
        guard,
    )

    assert refused.success is False
    assert "files" in refused.output
    assert allowed.success is True, allowed.output


def test_group_and_depends_on_are_recorded_and_validated(tmp_path: Path) -> None:
    root, guard, _ = _workspace(tmp_path)
    _write_source(root)

    plain = propose_module.propose_change_tool(_replace_args(), guard)
    assert plain.metadata["suggested_change"]["group"] is None
    assert plain.metadata["suggested_change"]["depends_on"] == []

    linked = propose_module.propose_change_tool(
        _replace_args(group="rename-api", depends_on=["sc_1", "call_7", "sc_1"]), guard
    )
    assert linked.success is True, linked.output
    assert linked.metadata["suggested_change"]["group"] == "rename-api"
    assert linked.metadata["suggested_change"]["depends_on"] == ["sc_1", "call_7"]

    for bad in ({"group": "two words"}, {"group": ""}, {"depends_on": "sc_1"}, {"depends_on": ["ok"] * 11}):
        refused = propose_module.propose_change_tool(_replace_args(**bad), guard)
        assert refused.success is False, bad
