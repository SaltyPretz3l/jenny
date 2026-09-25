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

    def run(arguments, *, cwd, timeout_seconds, env):  # noqa: ANN001
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

    def run(arguments, *, cwd, timeout_seconds, env):  # noqa: ANN001
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
