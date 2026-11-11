"""A synced sandbox run's change review survives the Electron tool bridge (row 106).

The review is what `buildSyncedChangeReview` emits. The bridge's path scrub dropped every key
containing "path", so the Changed files rows, Undo and the refused list never reached the app.
"""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.runtime import electron_tool_bridge as bridge


def _diff(index: int, path: Any = "README.md", lines: int = 1) -> dict[str, Any]:
    return {
        "diff_id": f"scripted:c1:{index}", "operation_index": index, "path": path, "status": "modified",
        "review_state": "full", "body_kind": "inline_hunks", "additions": lines, "deletions": 0,
        "truncated": False, "truncation_reason": None, "hash_kind": "diff_input_text",
        "before_hash": "sha256:a", "after_hash": "sha256:b",
        "hunks": [{"oldStart": 1, "oldLines": 0, "newStart": 1, "newLines": lines,
                   "lines": [f"+line {n}" for n in range(lines)]}],
    }


def _normalized(metadata: dict[str, Any]) -> dict[str, Any]:
    result = bridge._normalize_result_payload(
        {"success": True, "output": "ok", "metadata": metadata}, fallback_tool_name="run_command",
    )
    return result.metadata


def _review(**fields: Any) -> dict[str, Any]:
    return {"schema_version": 1, "state": "observed", "coverage": "synced_write_back", **fields}


def test_diff_paths_reach_the_turn_event() -> None:
    metadata = _normalized({"diffs": [_diff(0), _diff(1, "src/app.js")], "workspace_id": "abc"})
    assert [entry["path"] for entry in metadata["diffs"]] == ["README.md", "src/app.js"]
    assert metadata["workspace_id"] == "abc"


def test_review_path_lists_reach_the_turn_event() -> None:
    review = _normalized({"scripted_change_review": _review(
        changed_paths=["README.md", "old.txt"], changed_path_count=2,
        refused_paths=[{"path": ".GIT/config", "reason": "protected"}], refused_count=1,
        host_run_paths=["run.sh"], host_run_count=1,
        restore_point={"kind": "git_checkpoint", "ref": "refs/jenny/sandbox/s/1", "created_at": "t"},
    )})["scripted_change_review"]
    assert review["changed_paths"] == ["README.md", "old.txt"]
    assert review["changed_path_count"] == 2
    assert review["refused_paths"] == [{"path": ".GIT/config", "reason": "protected"}]
    assert review["host_run_paths"] == ["run.sh"]
    assert review["restore_point"]["ref"] == "refs/jenny/sandbox/s/1"


def test_a_full_length_diff_body_is_not_cut() -> None:
    # MAX_DIFF_LINES (services/tools/structured-diff.js) is 200, twice the bridge's generic item cap.
    diff = _normalized({"diffs": [_diff(0, lines=200)]})["diffs"][0]
    assert len(diff["hunks"][0]["lines"]) == 200


@pytest.mark.parametrize("path", [
    "C:/Windows/win.ini", "/etc/passwd", "//server/share/x", "../outside.txt", "a/../../b",
    "sub\\..\\..\\b", "notes.txt:stream", "x\x00y", "", None, 7,
])
def test_an_unsafe_diff_path_is_dropped(path: Any) -> None:
    assert "path" not in _normalized({"diffs": [_diff(0, path)]})["diffs"][0]


def test_unsafe_review_paths_are_dropped_and_safe_neighbours_kept() -> None:
    review = _normalized({"scripted_change_review": _review(
        changed_paths=["ok.txt", "C:/secret", "../up", 7],
        refused_paths=[{"path": "/etc/passwd", "reason": "protected"}, {"path": "fine.txt", "reason": "symlink"}],
    )})["scripted_change_review"]
    assert review["changed_paths"] == ["ok.txt"]
    assert review["refused_paths"] == [{"path": "fine.txt", "reason": "symlink"}]


def test_a_secret_shaped_path_is_never_carried() -> None:
    token = "sk-" + "a" * 24
    assert "path" not in _normalized({"diffs": [_diff(0, f"{token}.txt")]})["diffs"][0]


def test_other_path_keys_stay_scrubbed_inside_a_review() -> None:
    entry = {**_diff(0), "absolute_path": "C:/real/README.md", "local_path": "C:/x", "workspace_path": "C:/y"}
    review = _normalized({"diffs": [entry], "scripted_change_review": _review(
        absolute_path="C:/real", source_paths=["C:/z"],
    )})
    for key in ("absolute_path", "local_path", "workspace_path"):
        assert key not in review["diffs"][0]
    assert "absolute_path" not in review["scripted_change_review"]
    assert "source_paths" not in review["scripted_change_review"]


def test_path_keys_outside_a_review_stay_scrubbed() -> None:
    metadata = _normalized({"path": "README.md", "changed_paths": ["a"], "nested": {"path": "b", "keep": 1}})
    assert metadata == {"nested": {"keep": 1}}


def test_review_shapes_are_bounded() -> None:
    metadata = _normalized({
        "diffs": [_diff(index, f"f{index}.txt") for index in range(500)],
        "scripted_change_review": _review(changed_paths=[f"f{index}.txt" for index in range(5000)]),
    })
    assert len(metadata["diffs"]) <= 256
    assert len(metadata["scripted_change_review"]["changed_paths"]) <= 256


def test_nested_refused_paths_stop_at_the_depth_bound() -> None:
    entry: dict[str, Any] = {"path": "leaf.txt"}
    for _ in range(5000):
        entry = {"path": "a.txt", "refused_paths": [entry]}

    metadata = _normalized({"scripted_change_review": _review(refused_paths=[entry])})

    depth = 0
    node = metadata["scripted_change_review"]
    while node.get("refused_paths"):
        node = node["refused_paths"][0]
        depth += 1
    assert 1 <= depth <= 7


def test_a_non_container_review_is_omitted() -> None:
    metadata = _normalized({"diffs": "nope", "scripted_change_review": 3})
    assert "diffs" not in metadata
    assert "scripted_change_review" not in metadata
