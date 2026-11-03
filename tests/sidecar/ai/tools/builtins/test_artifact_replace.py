"""create_artifact ``replaces`` / ``edits``: revise a session artifact in place."""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import artifacts as artifacts_module
from sidecar.ai.tools.builtins.artifacts import MAX_EDITABLE_BYTES, create_artifact_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

_SESSION = "session-revise"


@pytest.fixture
def workspace_root(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    return root


def _call(root: Path, session: str = _SESSION, **arguments: object):
    payload: dict[str, object] = {
        "_jenny_session_id": session,
        "artifact_kind": "document",
        "title": "Mockup",
    }
    payload.update(arguments)
    return create_artifact_tool(payload, WorkspaceGuard(str(root)))


def _create(root: Path, content: str, *, session: str = _SESSION, file_name: str = "mockup.html"):
    result = _call(root, session=session, content=content, file_name=file_name)
    return result.generated_artifacts[0]


def _artifact_dir(root: Path, session: str = _SESSION) -> Path:
    return root / ".jenny" / "artifacts" / session


def test_replace_with_full_content_overwrites_in_place(workspace_root: Path) -> None:
    original = _create(workspace_root, "<p>v1</p>")

    result = _call(
        workspace_root, title="Mockup v2", content="<p>v2</p>", replaces=original["display_path"]
    )

    metadata = result.generated_artifacts[0]
    assert result.success is True
    assert metadata["display_path"] == original["display_path"]
    assert metadata["file_name"] == original["file_name"]
    assert metadata["title"] == "Mockup v2"
    assert metadata["language"] == "html"
    # Fresh id per write: the renderer's deleted-artifact set is keyed by id.
    assert metadata["artifact_id"].startswith(f"artifact_file_{_SESSION}_mockup-html_")
    assert metadata["artifact_id"] != original["artifact_id"]
    assert "Updated" in result.output
    files = sorted(path.name for path in _artifact_dir(workspace_root).iterdir())
    assert files == [original["file_name"]]
    assert (_artifact_dir(workspace_root) / original["file_name"]).read_text(
        encoding="utf-8"
    ) == "<p>v2</p>"


def test_replace_accepts_bare_file_name_and_backslash_display_path(workspace_root: Path) -> None:
    original = _create(workspace_root, "a")

    _call(workspace_root, content="b", replaces=original["file_name"])
    _call(workspace_root, content="c", replaces=original["display_path"].replace("/", "\\"))

    target = _artifact_dir(workspace_root) / original["file_name"]
    assert target.read_text(encoding="utf-8") == "c"


def test_edits_apply_in_order(workspace_root: Path) -> None:
    original = _create(workspace_root, '<div class="row">\n  <b>one</b>\n</div>\n')

    result = _call(
        workspace_root,
        replaces=original["display_path"],
        edits=[
            {"old_string": 'class="row"', "new_string": 'class="column"'},
            {"old_string": "<b>one</b>", "new_string": "<b>one</b>\n  <b>two</b>"},
        ],
    )

    assert result.success is True
    assert result.generated_artifacts[0]["display_path"] == original["display_path"]
    assert "2 edits" in result.output
    assert (_artifact_dir(workspace_root) / original["file_name"]).read_text(
        encoding="utf-8"
    ) == '<div class="column">\n  <b>one</b>\n  <b>two</b>\n</div>\n'


def test_edits_preserve_crlf_line_endings(workspace_root: Path) -> None:
    original = _create(workspace_root, "line one\r\nline two\r\n")

    _call(
        workspace_root,
        replaces=original["display_path"],
        edits=[{"old_string": "line one\nline two", "new_string": "line 1\nline 2"}],
    )

    raw = (_artifact_dir(workspace_root) / original["file_name"]).read_bytes()
    assert raw == b"line 1\r\nline 2\r\n"


def test_edit_without_match_reports_and_changes_nothing(workspace_root: Path) -> None:
    original = _create(workspace_root, "<p>alpha</p>\n")

    with pytest.raises(ToolExecutionFailure) as error:
        _call(
            workspace_root,
            replaces=original["display_path"],
            edits=[{"old_string": "zzz-not-present-qqq", "new_string": "x"}],
        )

    assert "Target string not found" in error.value.message
    assert "No changes were applied" in error.value.message
    assert (_artifact_dir(workspace_root) / original["file_name"]).read_text(
        encoding="utf-8"
    ) == "<p>alpha</p>\n"


def test_edit_with_multiple_matches_is_refused(workspace_root: Path) -> None:
    original = _create(workspace_root, "<li>item</li>\n<li>item</li>\n")

    with pytest.raises(ToolExecutionFailure, match="Found 2 matches"):
        _call(
            workspace_root,
            replaces=original["display_path"],
            edits=[{"old_string": "<li>item</li>", "new_string": "<li>x</li>"}],
        )


def test_edits_are_all_or_nothing(workspace_root: Path) -> None:
    original = _create(workspace_root, "first\nsecond\n")

    with pytest.raises(ToolExecutionFailure, match="Edit 2 of 2"):
        _call(
            workspace_root,
            replaces=original["display_path"],
            edits=[
                {"old_string": "first", "new_string": "FIRST"},
                {"old_string": "missing-token-xyz", "new_string": "y"},
            ],
        )

    assert (_artifact_dir(workspace_root) / original["file_name"]).read_text(
        encoding="utf-8"
    ) == "first\nsecond\n"


def test_edits_require_replaces(workspace_root: Path) -> None:
    with pytest.raises(ToolExecutionFailure, match="edits.*replaces"):
        _call(workspace_root, edits=[{"old_string": "a", "new_string": "b"}])


def test_replace_requires_content_or_edits(workspace_root: Path) -> None:
    original = _create(workspace_root, "a")

    with pytest.raises(ToolExecutionFailure, match="content.*edits"):
        _call(workspace_root, replaces=original["display_path"])


def test_content_and_edits_together_are_refused(workspace_root: Path) -> None:
    original = _create(workspace_root, "a")

    with pytest.raises(ToolExecutionFailure, match="either"):
        _call(
            workspace_root,
            replaces=original["display_path"],
            content="b",
            edits=[{"old_string": "a", "new_string": "b"}],
        )


@pytest.mark.parametrize(
    "edits",
    [
        [],
        "not-a-list",
        [{"old_string": "", "new_string": "b"}],
        [{"old_string": "a"}],
        [{"old_string": "a", "new_string": 3}],
        [{"old_string": "a", "new_string": "b"}] * 21,
    ],
)
def test_malformed_edits_are_refused(workspace_root: Path, edits: object) -> None:
    original = _create(workspace_root, "a")

    with pytest.raises(ToolExecutionFailure, match="edits"):
        _call(workspace_root, replaces=original["display_path"], edits=edits)


@pytest.mark.parametrize(
    "replaces",
    [
        "src/app.html",
        ".jenny/artifacts/other-session/mockup.html",
        ".jenny/artifacts/session-revise/../other-session/mockup.html",
        "../mockup.html",
        ".jenny/artifacts/session-revise/nested/mockup.html",
        ".jenny/backups/session-revise/mockup.html",
        "/etc/passwd",
        "C:/Windows/win.ini",
    ],
)
def test_replace_outside_the_session_artifact_folder_is_refused(
    workspace_root: Path, replaces: str
) -> None:
    _create(workspace_root, "mine")
    _create(workspace_root, "theirs", session="other-session")

    with pytest.raises(ToolExecutionFailure):
        _call(workspace_root, content="pwned", replaces=replaces)

    other = _artifact_dir(workspace_root, "other-session") / "mockup.html"
    assert other.read_text(encoding="utf-8") == "theirs"
    assert (_artifact_dir(workspace_root) / "mockup.html").read_text(encoding="utf-8") == "mine"


def test_replace_of_missing_artifact_is_refused(workspace_root: Path) -> None:
    _create(workspace_root, "mine")

    with pytest.raises(ToolExecutionFailure, match="no artifact"):
        _call(workspace_root, content="x", replaces="never-created.html")

    assert not (_artifact_dir(workspace_root) / "never-created.html").exists()


def test_replace_refuses_a_link_in_the_artifact_folder(workspace_root: Path) -> None:
    _create(workspace_root, "mine")
    outside = workspace_root / "outside.html"
    outside.write_text("outside", encoding="utf-8")
    link = _artifact_dir(workspace_root) / "linked.html"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlink creation is not permitted on this host")

    with pytest.raises(ToolExecutionFailure):
        _call(workspace_root, content="pwned", replaces="linked.html")

    assert outside.read_text(encoding="utf-8") == "outside"


def test_replace_refuses_a_conflicting_file_name_or_extension(workspace_root: Path) -> None:
    original = _create(workspace_root, "a")

    with pytest.raises(ToolExecutionFailure, match="keeps its name"):
        _call(workspace_root, content="b", replaces=original["file_name"], file_name="other.md")
    with pytest.raises(ToolExecutionFailure, match="keeps its name"):
        _call(workspace_root, content="b", replaces=original["file_name"], extension=".md")

    _call(
        workspace_root,
        content="c",
        replaces=original["file_name"],
        file_name=original["file_name"],
        extension=".html",
    )


def test_edits_refuse_a_result_over_the_editable_limit(workspace_root: Path) -> None:
    original = _create(workspace_root, "seed\n")

    with pytest.raises(ToolExecutionFailure, match="byte limit"):
        _call(
            workspace_root,
            replaces=original["display_path"],
            edits=[{"old_string": "seed", "new_string": "x" * (MAX_EDITABLE_BYTES + 1)}],
        )


def test_replace_does_not_count_against_the_session_capacity(
    workspace_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = _create(workspace_root, "a")
    monkeypatch.setattr(artifacts_module, "MAX_ARTIFACTS_PER_SESSION", 1)

    _call(workspace_root, content="b", replaces=original["display_path"])

    assert (_artifact_dir(workspace_root) / original["file_name"]).read_text(
        encoding="utf-8"
    ) == "b"


def test_replace_keeps_the_files_own_name_when_named_in_another_case(
    workspace_root: Path,
) -> None:
    original = _create(workspace_root, "<p>v1</p>")
    probe = _artifact_dir(workspace_root) / original["file_name"].upper()
    if not probe.exists():
        pytest.skip("case-sensitive filesystem: another spelling is another file")

    result = _call(workspace_root, content="<p>v2</p>", replaces=original["file_name"].upper())

    assert result.generated_artifacts[0]["display_path"] == original["display_path"]
