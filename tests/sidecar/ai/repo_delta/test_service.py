"""Contract tests for `sidecar.ai.repo_delta.service` (anchor persistence +
turn-start/run-end orchestration).

Written against the "Test plan" bullets in `docs/plans/REPO_DELTA_ON_RESUME.md`
plus the security/observability hardening notes documented inline at the top
of `service.py` itself -- not against whatever the implementation happens to
do. A disagreement between the contract and the implementation is a real
finding and is asserted here rather than avoided or softened.

Two reconciliations worth flagging up front (see the individual tests for the
full reasoning):

- The task directive describing this suite says a TAMPERED anchor (non-hex
  `head_sha`, foreign `root`) yields `None`. That literal wording only holds
  when the anchor's `root` still matches the real, current workspace root --
  `build_repository_delta_block` treats a genuinely mismatched anchor root as
  an intentional, documented signal (`_root_changed_delta`) worth surfacing
  to the agent, not a silent drop. Both shapes are tested below: same-root
  tampered sha -> `None` (the literal contract), and foreign/mismatched root
  -> a rendered "root changed" block, with the actual security invariant
  (the foreign root string is NEVER handed to git as `-C`) verified via a
  subprocess spy either way.
- "corrupt-anchor read logs a FIXED reason code" is asserted directly. At the
  time this suite was authored, `read_repo_anchor`'s tolerant catch degrades
  silently (no log call at all), so this assertion is expected to fail --
  that is a real, reportable observability gap per the task directive
  ("real impl bugs surfacing here is GOOD"), not a bad test.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.repo_delta import git_delta
from sidecar.ai.repo_delta.git_delta import RepoAnchor, RepoDelta, read_repo_snapshot
from sidecar.ai.repo_delta.service import (
    SCHEMA_VERSION,
    build_repository_delta_block,
    read_repo_anchor,
    refresh_repo_anchor,
    repo_anchor_path,
    safe_session_dirname,
    write_repo_anchor,
)

# ---------------------------------------------------------------------------
# Real-git fixtures/helpers (mirrors test_git_delta.py's pattern -- small git
# fixtures are deliberately duplicated per test file across this codebase
# rather than shared, per that file's own header comment).
# ---------------------------------------------------------------------------


def _git_available() -> bool:
    return (
        subprocess.run(
            ["git", "--version"], capture_output=True, text=True, check=False
        ).returncode
        == 0
    )


def _skip_if_no_git() -> None:
    if not _git_available():
        pytest.skip("git is unavailable in this environment")


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init"], cwd=path, capture_output=True, text=True, check=True)
    subprocess.run(
        ["git", "symbolic-ref", "HEAD", "refs/heads/main"],
        cwd=path,
        capture_output=True,
        text=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=path,
        capture_output=True,
        text=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Jenny Test"],
        cwd=path,
        capture_output=True,
        text=True,
        check=True,
    )


def _commit(path: Path, filename: str, content: str, message: str) -> str:
    target = path / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=path, capture_output=True, text=True, check=True)
    subprocess.run(
        ["git", "commit", "-m", message], cwd=path, capture_output=True, text=True, check=True
    )
    return _head_sha(path)


def _head_sha(path: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=path, capture_output=True, text=True, check=True
    ).stdout.strip()


def _config(**overrides: object) -> RuntimeConfig:
    return RuntimeConfig(repo_delta_resume_enabled=True, **overrides)  # type: ignore[arg-type]


def _snapshot_tree(root: Path) -> frozenset[str]:
    if not root.exists():
        return frozenset()
    return frozenset(str(p.relative_to(root)) for p in root.rglob("*"))


def _spy_subprocess_run(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    """Record every git argv `git_delta.run_git` spawns without changing behavior.

    git runs through the owned-process service (see `run_git`), so the spy wraps
    the module's service accessor rather than `subprocess.run`.
    """
    calls: list[list[str]] = []
    real_service = git_delta.get_owned_process_service()

    class _SpyService:
        def run(self, argv, *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
            calls.append(list(argv))
            return real_service.run(argv, *args, **kwargs)

    monkeypatch.setattr(
        "sidecar.ai.repo_delta.git_delta.get_owned_process_service",
        _SpyService,
    )
    return calls


@pytest.fixture()
def anchors_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect `resolve_background_runtime_root` at a temp dir (per task directive)."""
    base = tmp_path / "background-memory"
    monkeypatch.setattr(
        "sidecar.ai.repo_delta.service.resolve_background_runtime_root",
        lambda _config: base,
    )
    return base / "repo-anchors"


# ---------------------------------------------------------------------------
# safe_session_dirname -- SECURITY GATE (client-supplied path segment)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "session_id",
    [
        "../../evil",
        "/etc/passwd",
        ".",
        "..",
        "a/b",
        "x\0y",
        "",
        None,
        "   ",
        "a" * 129,  # over the 128-char ceiling
    ],
)
def test_safe_session_dirname_rejects_hostile_and_malformed_ids(
    session_id: str | None, anchors_root: Path
) -> None:
    assert safe_session_dirname(session_id) is None
    # repo_anchor_path must fail closed identically -- the regex gate is the
    # sole authority; nothing downstream should ever resolve a path for these.
    assert repo_anchor_path(_config(), session_id) is None


@pytest.mark.parametrize("session_id", ["session-123", "abc_DEF.456", "a"])
def test_safe_session_dirname_accepts_well_formed_ids(session_id: str) -> None:
    assert safe_session_dirname(session_id) == session_id


def test_hostile_session_id_writes_no_file_anywhere_not_even_inside_the_sanctioned_base(
    tmp_path: Path, anchors_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    calls = _spy_subprocess_run(monkeypatch)
    before = _snapshot_tree(tmp_path)

    refresh_repo_anchor(config=config, session_id="../../evil", workspace_root=str(repo))
    result = build_repository_delta_block(
        config=config, session_id="../../evil", workspace_root=str(repo)
    )

    after = _snapshot_tree(tmp_path)
    assert result is None
    assert calls == [], "a rejected session_id must never even reach a git spawn"
    assert before == after, "a rejected session_id must never write a file anywhere"
    assert not anchors_root.exists()


# ---------------------------------------------------------------------------
# Anchor round-trip, tolerant read, atomic write
# ---------------------------------------------------------------------------


def test_write_then_read_repo_anchor_round_trips(tmp_path: Path) -> None:
    path = tmp_path / "anchor.json"
    anchor = RepoAnchor(head_sha="a" * 40, branch="main", root=str(tmp_path / "repo"))

    write_repo_anchor(path, anchor)
    loaded = read_repo_anchor(path)

    assert loaded == anchor


def test_repo_anchor_path_round_trip_via_service_functions(
    tmp_path: Path, anchors_root: Path
) -> None:
    config = _config()
    path = repo_anchor_path(config, "session-abc")
    assert path is not None
    assert path.is_relative_to(anchors_root.resolve())

    anchor = RepoAnchor(head_sha="c" * 40, branch="main", root=str(tmp_path))
    write_repo_anchor(path, anchor)

    assert read_repo_anchor(path) == anchor


def test_read_repo_anchor_missing_file_returns_none(tmp_path: Path) -> None:
    assert read_repo_anchor(tmp_path / "missing.json") is None


def test_read_repo_anchor_corrupt_json_returns_none(tmp_path: Path) -> None:
    path = tmp_path / "anchor.json"
    path.write_text("{not valid json at all", encoding="utf-8")

    assert read_repo_anchor(path) is None


def test_read_repo_anchor_future_schema_version_returns_none(tmp_path: Path) -> None:
    path = tmp_path / "anchor.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION + 1,
                "head_sha": "a" * 40,
                "branch": "main",
                "root": str(tmp_path),
            }
        ),
        encoding="utf-8",
    )

    assert read_repo_anchor(path) is None


def test_read_repo_anchor_malformed_shape_returns_none(tmp_path: Path) -> None:
    path = tmp_path / "anchor.json"
    # head_sha must be a string or None -- an int is a shape violation.
    path.write_text(
        json.dumps(
            {"schema_version": SCHEMA_VERSION, "head_sha": 12345, "branch": "main", "root": str(tmp_path)}
        ),
        encoding="utf-8",
    )

    assert read_repo_anchor(path) is None


def test_read_repo_anchor_missing_root_returns_none(tmp_path: Path) -> None:
    path = tmp_path / "anchor.json"
    path.write_text(
        json.dumps({"schema_version": SCHEMA_VERSION, "head_sha": "a" * 40, "branch": "main"}),
        encoding="utf-8",
    )

    assert read_repo_anchor(path) is None


def test_write_repo_anchor_is_atomic_no_temp_file_left_behind(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "anchor.json"
    anchor = RepoAnchor(head_sha="b" * 40, branch="main", root=str(tmp_path))

    write_repo_anchor(path, anchor)

    assert path.exists()
    assert not path.with_name(f".{path.name}.tmp").exists()
    assert read_repo_anchor(path) == anchor


# ---------------------------------------------------------------------------
# TAMPERED anchor.json -- security gates
# ---------------------------------------------------------------------------


def test_tampered_non_hex_head_sha_same_root_yields_none_with_no_extra_git_spawn(
    tmp_path: Path, anchors_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same root as reality, but `head_sha` is garbage (not hex).

    This is the literal "TAMPERED anchor -> None" contract: since the root
    matches, `build_repository_delta_block` reaches `compute_repo_delta`,
    whose SECURITY GATE rejects a non-`is_valid_sha` anchor sha BEFORE any
    git call is made with it (see git_delta.py `compute_repo_delta`
    docstring). Only the single combined snapshot-read spawn should occur.
    """
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    real_snapshot = read_repo_snapshot(repo)
    assert real_snapshot is not None

    anchor_path = repo_anchor_path(config, "session-tampered-sha")
    assert anchor_path is not None
    anchor_path.parent.mkdir(parents=True, exist_ok=True)
    hostile_sha = "not-a-hex-sha; rm -rf /"
    anchor_path.write_text(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "head_sha": hostile_sha,
                "branch": "main",
                "root": real_snapshot.root,
            }
        ),
        encoding="utf-8",
    )

    calls = _spy_subprocess_run(monkeypatch)
    result = build_repository_delta_block(
        config=config, session_id="session-tampered-sha", workspace_root=str(repo)
    )

    assert result is None
    for argv in calls:
        assert hostile_sha not in argv, "the invalid sha must never enter a git argv"
    # Exactly the one combined snapshot-read spawn -- compute_repo_delta's
    # is_valid_sha gate must short-circuit before any of its own git calls.
    assert len(calls) == 1


def test_tampered_foreign_anchor_root_is_never_used_as_a_git_cwd(
    tmp_path: Path, anchors_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A mismatched (foreign) anchor root is a real, documented signal -- the
    session execution root changed -- so the result is intentionally NOT
    `None`. What the security gate actually promises (see `compute_repo_delta`
    docstring: "the anchor's root describes where the session used to sit,
    not where to run git") is narrower and is what's verified here: the
    foreign root string is never handed to git as a `-C` argument.
    """
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    anchor_path = repo_anchor_path(config, "session-foreign-root")
    assert anchor_path is not None
    anchor_path.parent.mkdir(parents=True, exist_ok=True)
    foreign_root = str(tmp_path / "totally-different-nonexistent-location")
    anchor_path.write_text(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "head_sha": "z" * 40,  # also non-hex ('z' is outside [0-9a-f])
                "branch": "main",
                "root": foreign_root,
            }
        ),
        encoding="utf-8",
    )

    calls = _spy_subprocess_run(monkeypatch)
    result = build_repository_delta_block(
        config=config, session_id="session-foreign-root", workspace_root=str(repo)
    )

    assert result is not None
    assert "The session execution root changed" in result
    for argv in calls:
        assert foreign_root not in argv
        if "-C" in argv:
            c_index = argv.index("-C")
            assert argv[c_index + 1] != foreign_root


# ---------------------------------------------------------------------------
# Corrupt-anchor read: redaction + (expected) fixed reason-code log
# ---------------------------------------------------------------------------


def test_corrupt_anchor_read_never_leaks_payload_and_logs_a_fixed_reason_code(
    tmp_path: Path, anchors_root: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    anchor_path = repo_anchor_path(config, "session-corrupt")
    assert anchor_path is not None
    anchor_path.parent.mkdir(parents=True, exist_ok=True)
    secret_path_fragment = "c:/very/secret/workspace/path"
    anchor_path.write_text(
        f'{{"schema_version": 1, "root": "{secret_path_fragment}", not valid json!!!',
        encoding="utf-8",
    )

    with caplog.at_level(logging.INFO, logger="sidecar.ai.repo_delta.service"):
        result = build_repository_delta_block(
            config=config, session_id="session-corrupt", workspace_root=str(repo)
        )

    assert result is None  # tolerant: a corrupt anchor degrades to "no anchor" (bootstrap)

    component_records = [
        record for record in caplog.records if getattr(record, "component", "") == "ai.repo_delta.service"
    ]
    # Whatever ends up logged (if anything) must never leak the raw corrupt
    # payload or the path embedded in it -- counts only (AGENTS.md redaction).
    for record in component_records:
        rendered = json.dumps(getattr(record, "data", {}), default=str) + record.getMessage()
        assert secret_path_fragment not in rendered
        assert "not valid json" not in rendered

    # Contract per the task directive: a corrupt anchor read is observable via
    # exactly one structured log_event carrying a fixed reason code -- distinct
    # from silent "no anchor yet" (bootstrap). As of this writing,
    # read_repo_anchor's tolerant catch degrades with NO log call at all, and
    # build_repository_delta_block only logs on delta_detected /
    # build_failed(exception) / anchor_write_failed -- none of which fire for
    # a plain corrupt-JSON read. This assertion is intentionally strict: if it
    # fails, that is a real, reportable missing-observability gap, not a bad
    # test (see task report deviations).
    assert len(component_records) >= 1, (
        "expected a structured log_event distinguishing a corrupt anchor read "
        "from bootstrap; read_repo_anchor currently degrades silently"
    )


# ---------------------------------------------------------------------------
# None when no anchor / unchanged; a block when diverged
# ---------------------------------------------------------------------------


def test_build_repository_delta_block_no_anchor_yet_returns_none_bootstrap(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    result = build_repository_delta_block(
        config=config, session_id="session-bootstrap", workspace_root=str(repo)
    )

    assert result is None


def test_build_repository_delta_block_unchanged_position_short_circuits_to_none(
    tmp_path: Path, anchors_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    refresh_repo_anchor(config=config, session_id="session-same", workspace_root=str(repo))

    calls = _spy_subprocess_run(monkeypatch)
    result = build_repository_delta_block(
        config=config, session_id="session-same", workspace_root=str(repo)
    )

    assert result is None
    # Cheap short-circuit: only the single combined snapshot-read spawn, no
    # diff/log/rev-list/cat-file/merge-base call for an unchanged position.
    assert len(calls) == 1


def test_build_repository_delta_block_diverged_returns_a_rendered_block(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    refresh_repo_anchor(config=config, session_id="session-diverge", workspace_root=str(repo))
    _commit(repo, "b.txt", "two\n", "second")

    result = build_repository_delta_block(
        config=config, session_id="session-diverge", workspace_root=str(repo)
    )

    assert result is not None
    assert result.startswith("<repository-delta>")
    assert result.endswith("</repository-delta>")
    assert "second" in result


def test_delta_detected_log_on_firing_path_is_counts_only_and_leaks_no_repo_strings(
    tmp_path: Path, anchors_root: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # AGENTS.md §7 redaction on the ONE log whose caller has just built a full
    # RepoDelta of repo-derived strings (branch, commit subject, file path, sha):
    # `delta_detected` must fire on the positive path with a counts/bool-only
    # payload and leak none of those strings. The existing suite only asserts
    # this event's ABSENCE (all-zero delta) -- never its content when it fires.
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    refresh_repo_anchor(config=config, session_id="session-detected-log", workspace_root=str(repo))
    probe_subject = "leak_probe_subject_zzz"
    head_sha = _commit(repo, "leak_probe_file_zzz.py", "two\n", probe_subject)

    with caplog.at_level(logging.INFO, logger="sidecar.ai.repo_delta.service"):
        result = build_repository_delta_block(
            config=config, session_id="session-detected-log", workspace_root=str(repo)
        )

    assert result is not None  # a real delta fired, so the log path is exercised
    detected = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.repo_delta.service.delta_detected"
    ]
    assert len(detected) == 1
    record = detected[0]
    assert set(record.data.keys()) == {  # type: ignore[attr-defined]
        "ahead",
        "behind",
        "commit_count",
        "files_total",
        "root_changed",
        "history_rewritten",
    }
    rendered = json.dumps(record.data, default=str) + record.getMessage()  # type: ignore[attr-defined]
    for secret in (probe_subject, "leak_probe_file_zzz.py", head_sha, head_sha[:7], "main"):
        assert secret not in rendered, f"delta_detected log leaked a repo-derived value: {secret!r}"


def test_build_repository_delta_block_suppresses_content_free_delta(
    tmp_path: Path,
    anchors_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Regression (audit finding): a same-logical-root resume whose raw root
    # representation differs (path casing / symlink) slips past the no-op
    # short-circuit and reaches compute with head==head/branch==branch, which
    # yields an all-zero RepoDelta. has_signal() must suppress it -- no
    # content-free <repository-delta> block and no delta_detected log. Force
    # compute to return an all-zero delta to drive the guard deterministically.
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    refresh_repo_anchor(config=config, session_id="session-empty", workspace_root=str(repo))
    _commit(repo, "b.txt", "two\n", "second")  # advance HEAD so the short-circuit does not fire

    all_zero = RepoDelta(
        history_rewritten=False,
        root_changed=False,
        branch_from="main",
        branch_to="main",
        head_from="a" * 40,
        head_to="a" * 40,
        ahead=0,
        behind=0,
        commits=(),
        files=(),
        files_total=0,
    )
    monkeypatch.setattr(
        "sidecar.ai.repo_delta.service.compute_repo_delta",
        lambda *args, **kwargs: all_zero,
    )

    with caplog.at_level(logging.INFO, logger="sidecar.ai.repo_delta.service"):
        result = build_repository_delta_block(
            config=config, session_id="session-empty", workspace_root=str(repo)
        )

    assert result is None
    assert [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.repo_delta.service.delta_detected"
    ] == []


# ---------------------------------------------------------------------------
# refresh writes
# ---------------------------------------------------------------------------


def test_refresh_repo_anchor_writes_the_current_position(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    sha = _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    refresh_repo_anchor(config=config, session_id="session-refresh", workspace_root=str(repo))

    anchor_path = repo_anchor_path(config, "session-refresh")
    assert anchor_path is not None
    anchor = read_repo_anchor(anchor_path)
    assert anchor is not None
    assert anchor.head_sha == sha
    assert anchor.branch == "main"


def test_refresh_repo_anchor_overwrites_not_appends_on_a_second_call(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    refresh_repo_anchor(config=config, session_id="session-overwrite", workspace_root=str(repo))
    second_sha = _commit(repo, "b.txt", "two\n", "second")
    refresh_repo_anchor(config=config, session_id="session-overwrite", workspace_root=str(repo))

    anchor_path = repo_anchor_path(config, "session-overwrite")
    assert anchor_path is not None
    anchor = read_repo_anchor(anchor_path)
    assert anchor is not None
    assert anchor.head_sha == second_sha


# ---------------------------------------------------------------------------
# Flag gating
# ---------------------------------------------------------------------------


def test_flag_off_build_and_refresh_are_no_ops(tmp_path: Path, anchors_root: Path) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = RuntimeConfig(repo_delta_resume_enabled=False)

    refresh_repo_anchor(config=config, session_id="session-flag-off", workspace_root=str(repo))
    anchor_path = repo_anchor_path(config, "session-flag-off")
    assert anchor_path is not None
    assert not anchor_path.exists()

    result = build_repository_delta_block(
        config=config, session_id="session-flag-off", workspace_root=str(repo)
    )
    assert result is None


# ---------------------------------------------------------------------------
# Fail-closed when the runner never ran
# ---------------------------------------------------------------------------


def test_build_repository_delta_block_fail_closed_when_git_never_runs(
    tmp_path: Path, anchors_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    refresh_repo_anchor(config=config, session_id="session-fail-closed", workspace_root=str(repo))
    _commit(repo, "b.txt", "two\n", "second")

    class _BrokenService:
        def run(self, *_args: object, **_kwargs: object) -> None:
            raise OSError("git executable not found")

    monkeypatch.setattr(
        "sidecar.ai.repo_delta.git_delta.get_owned_process_service",
        _BrokenService,
    )

    result = build_repository_delta_block(
        config=config, session_id="session-fail-closed", workspace_root=str(repo)
    )

    assert result is None


def test_refresh_repo_anchor_fail_closed_when_git_never_runs(
    tmp_path: Path, anchors_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    class _BrokenService:
        def run(self, *_args: object, **_kwargs: object) -> None:
            raise OSError("git executable not found")

    monkeypatch.setattr(
        "sidecar.ai.repo_delta.git_delta.get_owned_process_service",
        _BrokenService,
    )

    refresh_repo_anchor(
        config=config, session_id="session-refresh-fail-closed", workspace_root=str(repo)
    )

    anchor_path = repo_anchor_path(config, "session-refresh-fail-closed")
    assert anchor_path is not None
    assert not anchor_path.exists()


def test_build_repository_delta_block_exception_is_fail_closed_and_logs_error_type_only(
    tmp_path: Path, anchors_root: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    refresh_repo_anchor(config=config, session_id="session-boom", workspace_root=str(repo))
    _commit(repo, "b.txt", "two\n", "second")

    def boom(*_args: object, **_kwargs: object) -> str:
        raise RuntimeError("render exploded")

    monkeypatch.setattr("sidecar.ai.repo_delta.service.render_repository_delta_block", boom)

    with caplog.at_level(logging.WARNING, logger="sidecar.ai.repo_delta.service"):
        result = build_repository_delta_block(
            config=config, session_id="session-boom", workspace_root=str(repo)
        )

    assert result is None
    failed = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.repo_delta.service.build_failed"
    ]
    assert len(failed) == 1
    assert failed[0].data == {"error_type": "RuntimeError"}  # type: ignore[attr-defined]


def test_refresh_repo_anchor_exception_is_fail_closed_and_logs_error_type_only(
    tmp_path: Path, anchors_root: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("write exploded")

    monkeypatch.setattr("sidecar.ai.repo_delta.service.write_repo_anchor", boom)

    with caplog.at_level(logging.WARNING, logger="sidecar.ai.repo_delta.service"):
        refresh_repo_anchor(
            config=config, session_id="session-write-boom", workspace_root=str(repo)
        )

    # The refresh outer-except reports `refresh_failed` (a distinct reason from
    # the write-syscall's `anchor_write_failed`) -- it also covers snapshot-read /
    # path-resolution failures, so it must not be mislabeled as a write failure.
    failed = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.repo_delta.service.refresh_failed"
    ]
    assert len(failed) == 1
    assert failed[0].data == {"error_type": "RuntimeError"}  # type: ignore[attr-defined]


def test_atomic_write_anchor_oserror_logs_write_failed_reason_code(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The inner write-syscall failure keeps the `anchor_write_failed` reason code,
    # distinct from the refresh outer-except's `refresh_failed` (the F3 split).
    def boom_replace(*_args: object, **_kwargs: object) -> None:
        raise OSError("replace failed")

    monkeypatch.setattr("sidecar.ai.repo_delta.service.os.replace", boom_replace)
    anchor = RepoAnchor(head_sha="a" * 40, branch="main", root=str(tmp_path))

    with caplog.at_level(logging.WARNING, logger="sidecar.ai.repo_delta.service"):
        write_repo_anchor(tmp_path / "anchor.json", anchor)  # never raises

    failed = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.repo_delta.service.anchor_write_failed"
    ]
    assert len(failed) == 1
    assert failed[0].data == {"error_type": "OSError"}  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# session_id / workspace_root edge gates
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("session_id", [None, ""])
def test_build_and_refresh_skip_when_session_id_is_none_or_empty(
    session_id: str | None, tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    result = build_repository_delta_block(
        config=config, session_id=session_id, workspace_root=str(repo)
    )
    assert result is None

    refresh_repo_anchor(config=config, session_id=session_id, workspace_root=str(repo))
    assert _snapshot_tree(anchors_root) == frozenset()


def test_build_repository_delta_block_workspace_root_no_longer_exists_returns_none(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    refresh_repo_anchor(config=config, session_id="session-vanished-root", workspace_root=str(repo))

    result = build_repository_delta_block(
        config=config,
        session_id="session-vanished-root",
        workspace_root=str(tmp_path / "does-not-exist"),
    )

    assert result is None


def test_build_repository_delta_block_empty_workspace_root_returns_none(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    refresh_repo_anchor(config=config, session_id="session-empty-root", workspace_root=str(repo))

    result = build_repository_delta_block(
        config=config, session_id="session-empty-root", workspace_root=""
    )

    assert result is None
