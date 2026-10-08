"""Scripted-edit capture (row 34 S1): user-only diffs for files a command changed.

``run_command``/``run_temp_script``/``python_execute`` can rewrite workspace
files without edit_file's stale-file check, encoding preservation or undo. The
dispatch seam now records what changed in the V1 diff shape typed edits use,
plus a ``scripted_change_review`` record, and tells the model which source
paths changed (paths only, never content).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import scripted_change_capture as capture
from sidecar.ai.tools.builtins import scripted_restore_point as restore_points
from sidecar.ai.tools.builtins import worktree_change_tracking as tracking
from sidecar.ai.tools.builtins.git_ops import _run_git_raw
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar.ai.tools.builtins.test_worktree_change_tracking import _repo, _run_shell

_SECRET = "hunter2-do-not-leak"


@pytest.fixture(autouse=True)
def _reset() -> None:
    tracking._reset_worktree_tracking_for_tests()


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def _commit(repo: Path, files: dict[str, bytes]) -> None:
    for name, data in files.items():
        target = repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "fixture")


def _diffs(result: ToolHandlerResult) -> dict[str, dict[str, object]]:
    return {str(diff["path"]): diff for diff in result.metadata.get("diffs", [])}


def _lines(diff: dict[str, object]) -> list[str]:
    return [line for hunk in diff["hunks"] for line in hunk["lines"]]  # type: ignore[union-attr]


def _assert_summary_only(diff: dict[str, object], reason: str) -> None:
    assert diff["truncated"] is True
    assert diff["review_state"] == "summary_only"
    assert diff["body_kind"] == "summary_only"
    assert diff["truncation_reason"] == reason
    assert diff["hunks"] == []


def test_a_clean_tracked_file_gets_its_preimage_from_head(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(guard, lambda: (repo / "tracked.txt").write_text("edited\n", "utf-8"))

    diff = _diffs(result)["tracked.txt"]
    assert diff["status"] == "modified"
    assert _lines(diff) == ["-base", "+edited"]
    assert diff["before_hash"] and diff["after_hash"]


def test_new_and_deleted_files_get_created_and_deleted_status(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def work() -> None:
        (repo / "tracked.txt").unlink()
        (repo / "pkg").mkdir()
        (repo / "pkg" / "new_mod.py").write_text("print('hi')\n", "utf-8")

    result = _run_shell(guard, work, tool_name="run_command")

    diffs = _diffs(result)
    assert diffs["pkg/new_mod.py"]["status"] == "created"
    assert _lines(diffs["pkg/new_mod.py"]) == ["+print('hi')"]
    assert diffs["tracked.txt"]["status"] == "deleted"
    assert _lines(diffs["tracked.txt"]) == ["-base"]
    assert [diff["path"] for diff in result.metadata["diffs"]] == ["pkg/new_mod.py", "tracked.txt"]
    assert [str(diff["diff_id"]).rsplit(":", 1)[1] for diff in result.metadata["diffs"]] == [
        "0", "1"
    ]


def test_diff_ids_carry_the_operation_id(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    result = _run_shell(
        guard,
        lambda: (repo / "tracked.txt").write_text("edited\n", "utf-8"),
        _jenny_operation_id="op_abc/123",
    )

    assert result.metadata["diffs"][0]["diff_id"] == "scripted:op_abc_123:0"
    assert result.metadata["diffs"][0]["operation_index"] == 0


def test_a_sensitive_path_is_listed_but_never_read_or_diffed(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    _commit(repo, {"config/.env.local": b"TOKEN=old\n"})
    (repo / "id_rsa").write_text("old key\n", "utf-8")

    def work() -> None:
        (repo / "config" / ".env.local").write_text(f"TOKEN={_SECRET}\n", "utf-8")
        (repo / "id_rsa").write_text(f"{_SECRET}\n", "utf-8")
        (repo / "API_Secret.json").write_text(f'"{_SECRET}"\n', "utf-8")

    result = _run_shell(guard, work)

    diffs = _diffs(result)
    assert set(diffs) == {"config/.env.local", "id_rsa", "API_Secret.json"}
    for diff in diffs.values():
        _assert_summary_only(diff, "sensitive_path")
        assert diff["before_hash"] is None and diff["after_hash"] is None
    assert diffs["API_Secret.json"]["status"] == "created"
    assert diffs["config/.env.local"]["status"] == "modified"
    assert _SECRET not in json.dumps(result.metadata)
    assert _SECRET not in result.output
    assert "old" not in json.dumps(result.metadata["diffs"])
    assert result.metadata["scripted_change_review"]["state"] == "partial"


def test_a_clean_tracked_sensitive_file_is_never_fetched_from_head(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    _commit(repo, {".env": b"TOKEN=old\n", "app.py": b"x = 1\n"})
    (repo / ".env").write_text(f"TOKEN={_SECRET}\n", "utf-8")
    (repo / "app.py").write_text("x = 2\n", "utf-8")
    seen: list[list[str]] = []

    def run_git(args: list[str]) -> str:
        seen.append(list(args))
        return _run_git_raw(args, cwd=repo.resolve(), workspace=guard)

    diffs = capture.build_scripted_diffs(
        repo_root=repo.resolve(),
        workspace_root=guard.require_root().resolve(),
        changed=[".env", "app.py"],
        before_status={},
        after_status={".env": " M", "app.py": " M"},
        preimages={},
        run_git=run_git,
        diff_id_prefix="scripted:test",
    )

    by_path = {str(diff["path"]): diff for diff in diffs.diffs}
    _assert_summary_only(by_path[".env"], "sensitive_path")
    assert by_path["app.py"]["review_state"] != "summary_only"
    assert seen and not any(".env" in arg for args in seen for arg in args)
    assert "TOKEN=old" not in json.dumps(diffs.diffs)
    assert _SECRET not in json.dumps(diffs.diffs)


@pytest.mark.parametrize(
    "name",
    [".env", ".ENV.production", "cert.PEM", "a.key", "b.p12", "c.pfx", "id_rsa.pub",
     "id_ed25519", ".npmrc", ".pypirc", ".netrc", "aws_credentials.ini", "my-secret.txt",
     "vault.kdbx"],
)
def test_sensitive_deny_globs_match_basenames_case_insensitively(name: str) -> None:
    assert capture.is_sensitive_path(f"deep/dir/{name}") is True


def test_ordinary_names_are_not_sensitive() -> None:
    for name in ("src/app.py", "keys/readme.md", "env.py", "docs/pem.md", "secrets/config.yaml"):
        assert capture.is_sensitive_path(name) is False


def _make_dir_link(link: Path, target: Path) -> None:
    if sys.platform == "win32":
        completed = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True, check=False,
        )
        if completed.returncode != 0:
            pytest.skip("junction creation is unavailable")
        return
    os.symlink(target, link, target_is_directory=True)


def _build_untracked(
    repo: Path, guard: WorkspaceGuard, changed: list[str], clock: object = None
) -> capture.ScriptedDiffs:
    """Diffs for paths that are new and untracked after the call."""
    root = guard.require_root().resolve()
    return capture.build_scripted_diffs(
        repo_root=repo.resolve(),
        workspace_root=root,
        changed=changed,
        before_status={},
        after_status=dict.fromkeys(changed, "??"),
        preimages={},
        run_git=lambda args: _run_git_raw(args, cwd=repo.resolve(), workspace=guard),
        diff_id_prefix="scripted:test",
        **({"clock": clock} if clock is not None else {}),
    )


def test_a_junction_or_symlink_escape_is_never_followed(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (outside / "loot.txt").write_text(f"{_SECRET}\n", "utf-8")
    _make_dir_link(repo / "link", outside)

    built = _build_untracked(repo, guard, ["link/loot.txt"])

    assert len(built.diffs) == 1
    _assert_summary_only(built.diffs[0], "unknown")
    assert _SECRET not in json.dumps(built.diffs)


def test_a_file_symlink_is_summary_only(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text(f"{_SECRET}\n", "utf-8")
    try:
        os.symlink(outside, repo / "alias.txt")
    except (OSError, NotImplementedError):
        pytest.skip("file symlink creation is unavailable")

    built = _build_untracked(repo, guard, ["alias.txt"])

    _assert_summary_only(built.diffs[0], "unknown")
    assert _SECRET not in json.dumps(built.diffs)


def test_binary_and_oversize_files_are_summary_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, guard = _repo(tmp_path)
    monkeypatch.setattr(capture, "MAX_FILE_BYTES", 64)

    def work() -> None:
        (repo / "blob.bin").write_bytes(b"\x00\x01binary")
        (repo / "big.py").write_text("x = 1\n" * 40, "utf-8")

    result = _run_shell(guard, work)

    diffs = _diffs(result)
    _assert_summary_only(diffs["blob.bin"], "binary")
    _assert_summary_only(diffs["big.py"], "byte_limit")
    assert diffs["big.py"]["status"] == "created"


def test_the_diff_count_cap_reports_omitted_paths(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def work() -> None:
        for index in range(capture.MAX_DIFFS + 3):
            (repo / f"f{index:02d}.py").write_text(f"v = {index}\n", "utf-8")

    result = _run_shell(guard, work)

    review = result.metadata["scripted_change_review"]
    assert len(result.metadata["diffs"]) == capture.MAX_DIFFS
    assert review["changed_path_count"] == capture.MAX_DIFFS + 3
    assert review["omitted_count"] == 3
    assert review["diff_count"] == capture.MAX_DIFFS
    assert review["state"] == "partial"


def test_the_aggregate_metadata_cap_degrades_to_summary_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, guard = _repo(tmp_path)
    monkeypatch.setattr(capture, "MAX_DIFF_METADATA_BYTES", 1200)

    def work() -> None:
        for name in ("a.py", "b.py", "c.py"):
            (repo / name).write_text("line\n" * 20, "utf-8")

    result = _run_shell(guard, work)

    diffs = result.metadata["diffs"]
    assert len(diffs) == 3
    assert diffs[0]["review_state"] == "full"
    assert diffs[-1]["truncation_reason"] == "byte_limit"
    assert len(json.dumps(diffs)) <= 1200 + 2 * 500
    assert result.metadata["scripted_change_review"]["summary_only_count"] >= 1


def test_the_wall_budget_yields_time_limit_entries(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    for name in ("a.py", "b.py"):
        (repo / name).write_text("new\n", "utf-8")
    ticks = iter([0.0])

    built = _build_untracked(repo, guard, ["a.py", "b.py"], clock=lambda: next(ticks, 5.0))

    assert [diff["truncation_reason"] for diff in built.diffs] == ["time_limit", "time_limit"]
    assert [diff["status"] for diff in built.diffs] == ["created", "created"]
    assert built.summary_only_count == 2


def test_preimage_capture_caps_file_count_and_skips_sensitive_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, _guard = _repo(tmp_path)
    monkeypatch.setattr(capture, "MAX_FILES", 1)
    for name in ("a.py", "b.py", ".env"):
        (repo / name).write_bytes(f"{_SECRET}\n".encode())

    preimages = capture.capture_preimages(
        repo.resolve(), tmp_path.resolve(), ["a.py", "b.py", ".env"]
    )

    assert preimages["a.py"].text == f"{_SECRET}\n"
    assert preimages["b.py"].text is None
    assert preimages["b.py"].reason == "preimage_unavailable"
    assert preimages[".env"].text is None
    assert preimages[".env"].reason == "sensitive_path"


def test_head_blobs_after_an_undecodable_one_are_still_recovered(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    _commit(repo, {"a.txt": b"caf\xe9 latin-1\n", "b.txt": b"plain\n", "c.txt": b"also\n"})

    def work() -> None:
        for name in ("a.txt", "b.txt", "c.txt"):
            (repo / name).write_bytes(b"rewritten\n")

    result = _run_shell(guard, work)

    diffs = _diffs(result)
    _assert_summary_only(diffs["a.txt"], "decode_error")
    assert _lines(diffs["b.txt"]) == ["-plain", "+rewritten"]
    assert _lines(diffs["c.txt"]) == ["-also", "+rewritten"]


def test_an_index_only_change_is_listed_without_a_diff(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    (repo / "tracked.txt").write_text("edited\n", "utf-8")

    result = _run_shell(guard, lambda: _git(repo, "add", "tracked.txt"), tool_name="run_command")

    review = result.metadata["scripted_change_review"]
    assert review["changed_paths"] == ["tracked.txt"]
    assert review["state"] == "observed"
    assert "diffs" not in result.metadata


def test_the_model_line_names_changed_source_paths_only(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    _commit(repo, {"pkg/mod.py": b"value = 1\n"})

    def work() -> None:
        (repo / "pkg" / "mod.py").write_text(f"value = '{_SECRET}'\n", "utf-8")
        (repo / "run.log").write_text("noise\n", "utf-8")

    result = _run_shell(guard, work)

    first, *rest = result.output.splitlines()
    assert first == "ok"
    line = rest[0]
    assert line.startswith("This command changed workspace files outside edit_file/write_file: ")
    assert "pkg/mod.py" in line and "run.log" not in line
    assert line.endswith("use edit_file/write_file for source edits.")
    assert len(line) <= capture.MAX_NOTE_CHARS
    assert rest[1].startswith("New untracked files outside ignored folders: run.log")
    assert _SECRET not in result.output
    assert "diffs" not in result.output and "scripted_change_review" not in result.output


def test_the_model_line_keeps_a_json_result_valid(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    payload = json.dumps({"stdout": "", "exit_code": 0})

    result = tracking.run_with_worktree_observation(
        side_effecting=True, tool_name="run_command", arguments={"cwd": "repo"},
        workspace=guard,
        handler=lambda: (
            (repo / "tracked.txt").write_text("edited\n", "utf-8"),
            ToolHandlerResult(output=payload),
        )[1],
        logger=__import__("logging").getLogger(__name__),
    )

    parsed = json.loads(result.output)
    assert parsed["exit_code"] == 0
    assert "tracked.txt" in parsed["scripted_edit_note"]


def test_no_model_line_for_non_source_or_unobserved_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, guard = _repo(tmp_path)

    non_source = _run_shell(guard, lambda: (repo / "report.csv").write_text("c,d\n", "utf-8"))
    monkeypatch.setenv(tracking.SHELL_CHANGE_EVIDENCE_FLAG, "0")
    disabled = _run_shell(guard, lambda: (repo / "tracked.txt").write_text("e\n", "utf-8"))

    assert non_source.metadata["source_changed"] is False
    assert non_source.metadata["diffs"][0]["path"] == "report.csv"
    assert "This command changed" not in non_source.output
    assert disabled.output == "ok"


def test_the_note_is_bounded_and_counts_hidden_paths() -> None:
    paths = [f"src/{'deep_' * 12}{index}.py" for index in range(9)]

    note = capture.scripted_edit_note(paths)

    assert len(note) <= capture.MAX_NOTE_CHARS
    assert "(+" in note and "more)" in note
    assert note.endswith("use edit_file/write_file for source edits.")
    assert capture.scripted_edit_note([]) == ""


def test_the_note_does_not_claim_scripted_edits_cannot_be_undone() -> None:
    # Gate F4 (2026-10-05): the Changes view restores script-changed files
    # from the turn's checkpoint (row 34 S5), so "skip ... undo" was false.
    note = capture.scripted_edit_note(["src/app.py"])

    assert "and undo" not in note
    assert "undo them from Changes" in note


def test_changed_paths_order_source_first_and_bound_the_review() -> None:
    paths = [f"data/{index:03d}.csv" for index in range(60)] + ["z.py", "a.md"]

    review = capture.build_review(
        state="observed", call_outcome="failed", changed_paths=paths, diffs=None
    )

    assert review["changed_paths"][:2] == ["a.md", "z.py"]
    assert len(review["changed_paths"]) == capture.MAX_REVIEW_PATHS
    assert review["changed_path_count"] == 62
    assert review["call_outcome"] == "failed"
    assert "reason" not in review


def test_summary_reasons_stay_inside_the_truncation_enum() -> None:
    from sidecar.ai.tools.builtins.structured_diff import TRUNCATION_REASONS

    assert {"preimage_unavailable", "sensitive_path", "time_limit"} <= TRUNCATION_REASONS
    built = capture.summary_only_diffs(["a.py"], "scripted:x", "not_a_reason")

    assert built.diffs[0]["truncation_reason"] == "unknown"
    assert built.diffs[0]["status"] == "unknown"


# Row 34 S5 step 4: the review names the restore point taken before the turn.
_CHECKPOINT = {
    "kind": "git_checkpoint",
    "ref": "refs/jenny/checkpoints/sess-1/3",
    "created_at": "2026-10-05T12:00:00.123Z",
}


@pytest.mark.parametrize(
    "point",
    [
        _CHECKPOINT,
        {"kind": "head", "created_at": "2026-10-05T12:00:00Z"},
        {"kind": "none", "reason": "not_git"},
        {"kind": "none", "reason": "disabled"},
        {"kind": "none", "reason": "failed"},
        {"kind": "none", "reason": "unavailable"},
    ],
)
def test_the_review_carries_a_well_formed_restore_point(point: dict[str, str]) -> None:
    review = capture.build_review(state="observed", call_outcome="succeeded", restore_point=point)

    assert review["restore_point"] == point
    assert review["schema_version"] == 1


def test_a_review_without_a_restore_point_has_no_restore_point_key() -> None:
    review = capture.build_review(state="observed", call_outcome="succeeded")

    assert "restore_point" not in review


@pytest.mark.parametrize(
    "point",
    [
        None,
        "refs/jenny/checkpoints/sess-1/3",
        {"kind": "git_checkpoint", "ref": "refs/heads/main", "created_at": "2026-10-05T12:00:00Z"},
        {"kind": "git_checkpoint", "ref": "refs/jenny/checkpoints/a/b/1",
         "created_at": "2026-10-05T12:00:00Z"},
        {"kind": "git_checkpoint", "ref": "refs/jenny/checkpoints/s/x",
         "created_at": "2026-10-05T12:00:00Z"},
        {"kind": "git_checkpoint", "ref": "refs/jenny/checkpoints/" + "s" * 200 + "/1",
         "created_at": "2026-10-05T12:00:00Z"},
        {"kind": "git_checkpoint", "ref": "refs/jenny/checkpoints/s/1", "created_at": "yesterday"},
        {"kind": "git_checkpoint", "ref": "refs/jenny/checkpoints/s/1"},
        {"kind": "head", "created_at": "2026-10-05 12:00:00"},
        {"kind": "none", "reason": "too_large"},
        {"kind": "none"},
        {"kind": "stash", "created_at": "2026-10-05T12:00:00Z"},
    ],
)
def test_a_malformed_restore_point_is_dropped(point: object) -> None:
    review = capture.build_review(state="observed", call_outcome="succeeded", restore_point=point)

    assert "restore_point" not in review


def test_a_restore_point_keeps_only_its_contract_fields() -> None:
    noisy = {**_CHECKPOINT, "sha": "a" * 40, "note": "x"}

    review = capture.build_review(state="observed", call_outcome="failed", restore_point=noisy)

    assert review["restore_point"] == _CHECKPOINT
    assert restore_points.bounded_restore_point({"kind": "none", "reason": "failed", "ref": "x"}) == {
        "kind": "none", "reason": "failed"
    }
