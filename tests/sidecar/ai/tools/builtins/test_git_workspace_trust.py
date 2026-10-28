"""Real Git ownership refusal, with command trust supplied only by workspace validation."""
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import git_ops, git_process, worktree_change_tracking
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _marker_command(marker: Path) -> str:
    script = (
        "import pathlib;"
        f"pathlib.Path(bytes.fromhex('{str(marker).encode().hex()}').decode())."
        "write_text('executed')"
    )
    return f'"{sys.executable}" -c "{script}"'


def _init_committed_repo(path: Path) -> None:
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)


def _commit_all(path: Path, message: str) -> None:
    subprocess.run(["git", "add", "."], cwd=path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", message], cwd=path, check=True)


def _install_real_process_adapter(
    monkeypatch: pytest.MonkeyPatch,
    *,
    assume_different_owner: bool,
) -> list[list[str]]:
    commands: list[list[str]] = []

    def run(arguments, *, cwd, timeout_seconds, env):
        commands.append(arguments)
        if assume_different_owner:
            env = {**env, "GIT_TEST_ASSUME_DIFFERENT_OWNER": "1"}
        return subprocess.run(
            arguments,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout_seconds,
            check=False,
        )

    monkeypatch.setattr(git_process, "get_owned_process_service", lambda: SimpleNamespace(run=run))
    return commands


def test_foreign_owner_selected_workspace_status_and_baseline(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / "untracked.txt").write_text("user content")
    config_before = (tmp_path / ".git/config").read_bytes()
    commands = []

    def run(arguments, *, cwd, timeout_seconds, env):
        commands.append(arguments)
        env = {**env, "GIT_TEST_ASSUME_DIFFERENT_OWNER": "1"}
        return subprocess.run(arguments, cwd=cwd, env=env, capture_output=True, text=True,
                              encoding="utf-8", timeout=timeout_seconds, check=False)

    monkeypatch.setattr(git_process, "get_owned_process_service", lambda: SimpleNamespace(run=run))
    guard = WorkspaceGuard(str(tmp_path))
    assert "untracked.txt" in git_ops.git_status_tool({}, guard)
    baseline = worktree_change_tracking.workspace_change_baseline_tool({}, guard)
    delta = worktree_change_tracking.workspace_change_delta_tool(
        {"baseline_id": baseline.metadata["baseline_id"]}, guard)
    assert delta.success
    subdir = tmp_path / "subdir"
    subdir.mkdir()
    git_ops.git_status_tool({"cwd": "subdir"}, guard)
    assert all(
        ["-c", f"safe.directory={tmp_path.resolve().as_posix()}"]
        in [command[index:index + 2] for index in range(len(command) - 1)]
        for command in commands
    )
    assert (tmp_path / ".git/config").read_bytes() == config_before
    with pytest.raises(ToolExecutionFailure, match="dubious ownership"):
        git_ops.git_status_tool({"cwd": str(tmp_path)}, WorkspaceGuard(str(tmp_path.parent)))


def test_delta_cannot_reuse_trust_after_workspace_changes(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    guard = WorkspaceGuard(str(tmp_path))
    baseline = worktree_change_tracking.workspace_change_baseline_tool({}, guard)
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(ToolExecutionFailure):
        worktree_change_tracking.workspace_change_delta_tool(
            {"baseline_id": baseline.metadata["baseline_id"]}, WorkspaceGuard(str(other)))


@pytest.mark.parametrize("foreign_owner", [True, False])
def test_git_status_neutralizes_configured_fsmonitor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    foreign_owner: bool,
) -> None:
    workspace_root = tmp_path if foreign_owner else tmp_path / "workspace"
    repo = workspace_root if foreign_owner else workspace_root / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    _init_committed_repo(repo)
    marker = tmp_path / f"fsmonitor-{foreign_owner}.marker"
    subprocess.run(
        ["git", "config", "core.fsmonitor", _marker_command(marker)],
        cwd=repo,
        check=True,
    )
    _install_real_process_adapter(
        monkeypatch,
        assume_different_owner=foreign_owner,
    )

    output = git_ops.git_status_tool(
        {} if foreign_owner else {"cwd": "repo"},
        WorkspaceGuard(str(workspace_root)),
    )

    assert isinstance(output, str)
    assert not marker.exists()


@pytest.mark.parametrize("handler", [git_ops.git_status_tool, git_ops.git_diff_tool])
def test_git_status_and_diff_neutralize_clean_filter(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    handler,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _init_committed_repo(repo)
    tracked = repo / "tracked.txt"
    tracked.write_text("before\n", encoding="utf-8")
    (repo / ".gitattributes").write_text("* filter=evil\n", encoding="utf-8")
    _commit_all(repo, "initial")
    marker = tmp_path / f"filter-{handler.__name__}.marker"
    subprocess.run(
        ["git", "config", "filter.evil.clean", _marker_command(marker)],
        cwd=repo,
        check=True,
    )
    tracked.write_text("after!\n", encoding="utf-8")
    _install_real_process_adapter(monkeypatch, assume_different_owner=False)

    output = handler({"cwd": "repo"}, WorkspaceGuard(str(tmp_path)))

    assert isinstance(output, str)
    assert not marker.exists()


@pytest.mark.parametrize("handler", [git_ops.git_status_tool, git_ops.git_diff_tool])
def test_git_status_and_diff_never_run_a_submodule_clean_filter(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    handler,
) -> None:
    # Security review 2026-10-25 item 16: the parent's -c overrides cannot name a
    # filter that only the submodule's own config defines, so its worktree is skipped.
    repo = tmp_path / "repo"
    repo.mkdir()
    _init_committed_repo(repo)
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    sub = repo / "sub"
    sub.mkdir()
    _init_committed_repo(sub)
    (sub / ".gitattributes").write_text("* filter=evil\n", encoding="utf-8")
    tracked = sub / "f.txt"
    tracked.write_text("hello\n", encoding="utf-8")
    _commit_all(sub, "sub")
    marker = tmp_path / f"submodule-{handler.__name__}.marker"
    subprocess.run(["git", "config", "filter.evil.clean", _marker_command(marker)], cwd=sub, check=True)
    _commit_all(repo, "parent with a gitlink")
    # Same content, newer mtime: the submodule's status must re-read it through the filter.
    stat = tracked.stat()
    os.utime(tracked, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
    commands = _install_real_process_adapter(monkeypatch, assume_different_owner=False)

    handler({"cwd": "repo"}, WorkspaceGuard(str(tmp_path)))

    assert not marker.exists()
    assert any("--ignore-submodules=dirty" in command for command in commands)


@pytest.mark.parametrize("config_key", ["diff.evil.command", "diff.evil.textconv"])
@pytest.mark.parametrize("handler", [git_ops.git_diff_tool, git_ops.git_show_tool])
def test_git_diff_and_show_neutralize_diff_drivers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    config_key: str,
    handler,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _init_committed_repo(repo)
    tracked = repo / "tracked.txt"
    tracked.write_text("before\n", encoding="utf-8")
    (repo / ".gitattributes").write_text("*.txt diff=evil\n", encoding="utf-8")
    _commit_all(repo, "initial")
    tracked.write_text("after\n", encoding="utf-8")
    _commit_all(repo, "changed")
    marker = tmp_path / f"{config_key}-{handler.__name__}.marker"
    subprocess.run(
        ["git", "config", config_key, _marker_command(marker)],
        cwd=repo,
        check=True,
    )
    if handler is git_ops.git_diff_tool:
        tracked.write_text("working tree\n", encoding="utf-8")
    _install_real_process_adapter(monkeypatch, assume_different_owner=False)

    output = handler({"cwd": "repo"}, WorkspaceGuard(str(tmp_path)))

    assert "tracked.txt" in output
    assert not marker.exists()


def test_neutralizing_config_arguments_are_stable_and_unique() -> None:
    configured_keys = [
        "filter.evil.clean",
        "filter.evil.process",
        "diff.zed.textconv",
        "credential.https://example.com.helper",
        "filter.evil.clean",
        "filter.evil.required",
        "filter.evil.smudge",
        "diff.alpha.command",
        "user.name",
    ]

    arguments = git_process.neutralizing_config_arguments(configured_keys)

    assert arguments == [
        "-c", "core.fsmonitor=false",
        "-c", f"core.hooksPath={os.devnull}",
        "-c", "diff.external=",
        "-c", "core.sshCommand=",
        "-c", "core.askPass=",
        "-c", "credential.helper=",
        "-c", "core.pager=cat",
        "-c", "log.showSignature=false",
        "-c", "core.quotePath=false",
        "-c", "credential.https://example.com.helper=",
        "-c", "diff.alpha.command=",
        "-c", "diff.zed.textconv=",
        "-c", "filter.evil.clean=",
        "-c", "filter.evil.process=",
        "-c", "filter.evil.required=false",
        "-c", "filter.evil.smudge=",
    ]


def _configured_filter_repo(repo: Path, marker: Path) -> None:
    repo.mkdir()
    _init_committed_repo(repo)
    tracked = repo / "tracked.txt"
    tracked.write_text("before\n", encoding="utf-8")
    (repo / ".gitattributes").write_text("* filter=evil\n", encoding="utf-8")
    _commit_all(repo, "initial")
    subprocess.run(
        ["git", "config", "filter.evil.clean", _marker_command(marker)],
        cwd=repo,
        check=True,
    )
    tracked.write_text("after!\n", encoding="utf-8")


def _install_discovery_result_adapter(
    monkeypatch: pytest.MonkeyPatch,
    discovery_result: object,
) -> list[list[str]]:
    calls: list[list[str]] = []

    def run(arguments, *, cwd, timeout_seconds, env):
        calls.append(arguments)
        if len(calls) == 1:
            return discovery_result
        return subprocess.run(
            arguments,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout_seconds,
            check=False,
        )

    monkeypatch.setattr(git_process, "get_owned_process_service", lambda: SimpleNamespace(run=run))
    return calls


def test_invalid_utf8_config_key_does_not_discard_valid_filter_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    marker = tmp_path / "invalid-utf8.marker"
    _configured_filter_repo(repo, marker)
    discovery_result = SimpleNamespace(
        returncode=0,
        stdout=b"filter.evil.clean\0other.\xff.name\0",
        stderr="",
        timed_out=False,
        aborted=False,
        drain_incomplete=False,
        output=SimpleNamespace(truncated=False),
    )
    calls = _install_discovery_result_adapter(monkeypatch, discovery_result)

    output = git_ops.git_status_tool({"cwd": "repo"}, WorkspaceGuard(str(tmp_path)))

    assert isinstance(output, str)
    assert len(calls) == 2
    assert not marker.exists()


@pytest.mark.parametrize(
    "discovery_result",
    [
        SimpleNamespace(
            returncode=0,
            stdout=b"filter.evil.clean\0",
            stderr="",
            timed_out=False,
            aborted=False,
            drain_incomplete=False,
            output=SimpleNamespace(truncated=True),
        ),
        SimpleNamespace(
            returncode=1,
            stdout=b"",
            stderr="failed",
            timed_out=False,
            aborted=False,
            drain_incomplete=False,
            output=SimpleNamespace(truncated=False),
        ),
        SimpleNamespace(
            returncode=0,
            stdout=b"filter.evil.clean\0",
            stderr="",
            timed_out=True,
            aborted=False,
            drain_incomplete=False,
            output=SimpleNamespace(truncated=False),
        ),
        SimpleNamespace(
            returncode=0,
            stdout=b"filter.evil.clean\0",
            stderr="",
            timed_out=False,
            aborted=True,
            drain_incomplete=False,
            output=SimpleNamespace(truncated=False),
        ),
        SimpleNamespace(
            returncode=0,
            stdout=b"filter.evil.clean\0",
            stderr="",
            timed_out=False,
            aborted=False,
            drain_incomplete=True,
            output=SimpleNamespace(truncated=False),
        ),
    ],
    ids=["truncated", "non-zero", "timeout", "aborted", "drain-incomplete"],
)
def test_unverifiable_git_config_refuses_read_only_command(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    discovery_result: object,
) -> None:
    repo = tmp_path / "repo"
    marker = tmp_path / "unverified.marker"
    _configured_filter_repo(repo, marker)
    calls = _install_discovery_result_adapter(monkeypatch, discovery_result)

    with pytest.raises(ToolExecutionFailure) as exc_info:
        git_ops.git_status_tool({"cwd": "repo"}, WorkspaceGuard(str(tmp_path)))

    assert "Git configuration could not be verified" in exc_info.value.message
    assert "read-only command was not run" in exc_info.value.message
    assert len(calls) == 1
    assert not marker.exists()


def test_repository_core_worktree_cannot_redirect_status_outside_the_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = tmp_path / "workspace"
    repo = workspace_root / "repo"
    repo.mkdir(parents=True)
    _init_committed_repo(repo)
    (repo / "tracked.txt").write_text("tracked\n", encoding="utf-8")
    _commit_all(repo, "initial")
    (repo / "inside-only.txt").write_text("inside\n", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "outside-only.txt").write_text("outside\n", encoding="utf-8")
    subprocess.run(
        ["git", "config", "core.worktree", str(outside)], cwd=repo, check=True
    )
    (repo / "nested").mkdir()
    _install_real_process_adapter(monkeypatch, assume_different_owner=False)

    for cwd in ("repo", "repo/nested"):
        output = git_ops.git_status_tool({"cwd": cwd}, WorkspaceGuard(str(workspace_root)))
        assert "outside-only.txt" not in output
        assert "inside-only.txt" in output


def test_non_ascii_file_names_are_reported_literally(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _init_committed_repo(repo)
    (repo / "tracked.txt").write_text("tracked\n", encoding="utf-8")
    _commit_all(repo, "initial")
    (repo / "café.txt").write_text("cafe\n", encoding="utf-8")
    _install_real_process_adapter(monkeypatch, assume_different_owner=False)

    output = git_ops.git_status_tool({"cwd": "repo"}, WorkspaceGuard(str(tmp_path)))

    assert "?? café.txt" in output


def _discovery_count(commands: list[list[str]]) -> int:
    return sum(1 for command in commands if "--list" in command)


def test_config_key_discovery_is_reused_until_a_config_file_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    git_process.reset_config_keys_cache()
    repo = tmp_path / "repo"
    marker = tmp_path / "cached.marker"
    repo.mkdir()
    _init_committed_repo(repo)
    tracked = repo / "tracked.txt"
    tracked.write_text("before\n", encoding="utf-8")
    (repo / ".gitattributes").write_text("* filter=evil\n", encoding="utf-8")
    _commit_all(repo, "initial")
    tracked.write_text("after!\n", encoding="utf-8")
    commands = _install_real_process_adapter(monkeypatch, assume_different_owner=False)
    guard = WorkspaceGuard(str(tmp_path))

    git_ops.git_status_tool({"cwd": "repo"}, guard)
    git_ops.git_diff_tool({"cwd": "repo"}, guard)
    assert _discovery_count(commands) == 1

    # A filter configured after the first discovery changes .git/config, so the
    # next command rediscovers and neutralizes it.
    subprocess.run(
        ["git", "config", "filter.evil.clean", _marker_command(marker)], cwd=repo, check=True
    )
    git_ops.git_status_tool({"cwd": "repo"}, guard)
    assert _discovery_count(commands) == 2
    assert not marker.exists()


def test_config_key_discovery_naming_an_include_is_never_cached(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    git_process.reset_config_keys_cache()
    repo = tmp_path / "repo"
    repo.mkdir()
    _init_committed_repo(repo)
    (repo / "extra.cfg").write_text("[user]\n\tname = Included\n", encoding="utf-8")
    subprocess.run(["git", "config", "include.path", "../extra.cfg"], cwd=repo, check=True)
    commands = _install_real_process_adapter(monkeypatch, assume_different_owner=False)
    guard = WorkspaceGuard(str(tmp_path))

    git_ops.git_status_tool({"cwd": "repo"}, guard)
    git_ops.git_status_tool({"cwd": "repo"}, guard)

    assert _discovery_count(commands) == 2


def test_config_key_cache_entries_expire(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    git_process.reset_config_keys_cache()
    repo = tmp_path / "repo"
    repo.mkdir()
    _init_committed_repo(repo)
    commands = _install_real_process_adapter(monkeypatch, assume_different_owner=False)
    guard = WorkspaceGuard(str(tmp_path))

    git_ops.git_status_tool({"cwd": "repo"}, guard)
    cache = git_process._CONFIG_KEYS_CACHE
    for key, (stored_at, keys) in list(cache.items()):
        cache[key] = (stored_at - git_process.CONFIG_KEYS_TTL_SECONDS - 1, keys)
    git_ops.git_status_tool({"cwd": "repo"}, guard)

    assert _discovery_count(commands) == 2
