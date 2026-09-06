from __future__ import annotations

import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_PRECONDITION_UNMET
from sidecar.ai.tools.builtins import git_ops as git_ops_module
from sidecar.ai.tools.builtins.git_ops import (
    _GIT_METADATA_MAX_BYTES,
    MAX_OUTPUT_CHARS,
    _git_environment,
    _read_git_metadata_file,
    _run_git,
    git_diff_tool,
    git_log_tool,
    git_show_tool,
    git_status_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


@pytest.fixture(autouse=True)
def _legacy_unit_process_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    """Preserve these command-shaping tests' injected subprocess seam."""

    def _run_owned(
        arguments: list[str],
        *,
        cwd: Path,
        timeout_seconds: float,
        env: dict[str, str],
    ) -> object:
        return subprocess.run(
            arguments,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
            env=env,
        )

    monkeypatch.setattr(git_ops_module, "_run_owned_process", _run_owned)


def _init_minimal_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / ".git").mkdir()


def _init_real_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)


def _commit_all(path: Path, message: str) -> None:
    subprocess.run(["git", "add", "."], cwd=path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", message], cwd=path, check=True)


def test_git_show_path_uses_parent_ref_and_preserves_file_content(tmp_path: Path) -> None:
    repo = tmp_path / "repo with spaces"
    _init_real_repo(repo)
    target = repo / "nested" / "file name.txt"
    target.parent.mkdir()
    target.write_text("parent\n", encoding="utf-8", newline="")
    _commit_all(repo, "parent")
    target.write_text("child\n", encoding="utf-8", newline="")
    _commit_all(repo, "child")

    output = git_show_tool(
        {"cwd": "repo with spaces", "ref": "HEAD^", "path": "nested/file name.txt"},
        _guard(tmp_path),
    )
    assert output == "parent\n"


def test_git_show_path_supports_nested_cwd_and_rejects_unsafe_or_binary_paths(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    _init_real_repo(repo)
    nested = repo / "a" / "b"
    nested.mkdir(parents=True)
    (repo / "root.txt").write_text("root\n", encoding="utf-8", newline="")
    (repo / "binary.bin").write_bytes(b"a\x00b")
    (repo / "invalid.txt").write_bytes(b"bad\xfftext")
    _commit_all(repo, "files")
    assert git_show_tool(
        {"cwd": "repo/a/b", "path": "../../root.txt"}, _guard(tmp_path)
    ) == "root\n"
    for path in ("../../../escape.txt", "-option"):
        with pytest.raises(ToolExecutionFailure):
            git_show_tool({"cwd": "repo/a/b", "path": path}, _guard(tmp_path))
    with pytest.raises(ToolExecutionFailure):
        git_show_tool({"cwd": "repo", "path": "binary.bin"}, _guard(tmp_path))
    with pytest.raises(ToolExecutionFailure):
        git_show_tool({"cwd": "repo", "path": "invalid.txt"}, _guard(tmp_path))
    with pytest.raises(ToolExecutionFailure):
        git_show_tool({"cwd": "repo", "path": "missing.txt"}, _guard(tmp_path))
    with pytest.raises(ToolExecutionFailure):
        git_show_tool({"cwd": "repo", "ref": "HEAD:root.txt", "path": "root.txt"}, _guard(tmp_path))


def test_git_diff_builds_staged_command(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_minimal_repo(repo)
    captured: dict[str, object] = {}

    def fake_run(command, **kwargs):  # noqa: ANN001
        captured["command"] = command
        captured["cwd"] = kwargs["cwd"]
        return SimpleNamespace(returncode=0, stdout="diff output", stderr="")

    monkeypatch.setattr("sidecar.ai.tools.builtins.git_ops.subprocess.run", fake_run)

    output = git_diff_tool({"cwd": "repo", "staged": True}, _guard(tmp_path))

    assert output == "diff output"
    assert captured["command"] == [
        "git",
        "--no-pager",
        "--no-optional-locks",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--cached",
    ]
    assert captured["cwd"] == str(repo)


def test_git_diff_builds_ref_and_path_command(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo = tmp_path / "repo"
    subdir = repo / "subdir"
    _init_minimal_repo(repo)
    subdir.mkdir(parents=True)
    captured: dict[str, object] = {}

    def fake_run(command, **kwargs):  # noqa: ANN001
        captured["command"] = command
        return SimpleNamespace(returncode=0, stdout="diff output", stderr="")

    monkeypatch.setattr("sidecar.ai.tools.builtins.git_ops.subprocess.run", fake_run)

    output = git_diff_tool(
        {"cwd": "repo/subdir", "ref": "HEAD~2", "path": "../deleted.txt"},
        _guard(tmp_path),
    )

    assert output == "diff output"
    assert captured["command"] == [
        "git",
        "--no-pager",
        "--no-optional-locks",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD~2",
        "--",
        "../deleted.txt",
    ]


def test_git_diff_returns_empty_state_for_blank_output(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    _init_minimal_repo(repo)
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.git_ops.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="", stderr=""),
    )

    output = git_diff_tool({"cwd": "repo"}, _guard(tmp_path))

    assert output == "(no changes found)"


def test_git_show_defaults_to_head(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_minimal_repo(repo)
    captured: dict[str, object] = {}

    def fake_run(command, **kwargs):  # noqa: ANN001
        captured["command"] = command
        return SimpleNamespace(returncode=0, stdout="commit output", stderr="")

    monkeypatch.setattr("sidecar.ai.tools.builtins.git_ops.subprocess.run", fake_run)

    output = git_show_tool({"cwd": "repo"}, _guard(tmp_path))

    assert output == "commit output"
    assert captured["command"] == [
        "git",
        "--no-pager",
        "--no-optional-locks",
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
        "--patch",
        "HEAD",
    ]


@pytest.mark.parametrize(
    ("handler", "arguments"),
    [
        (git_diff_tool, {"staged": "yes"}),
        (git_diff_tool, {"ref": 123}),
        (git_diff_tool, {"path": 456}),
        (git_show_tool, {"ref": 123}),
    ],
)
def test_git_tools_reject_invalid_argument_types(
    handler,
    arguments: dict[str, object],
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    _init_minimal_repo(repo)
    payload = {"cwd": "repo", **arguments}

    with pytest.raises(ToolExecutionFailure) as exc_info:
        handler(payload, _guard(tmp_path))

    assert "must be" in exc_info.value.message


@pytest.mark.parametrize("handler", [git_diff_tool, git_show_tool])
def test_git_tools_reject_option_like_refs(handler, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_minimal_repo(repo)

    with pytest.raises(ToolExecutionFailure) as exc_info:
        handler({"cwd": "repo", "ref": "--output=proof.patch"}, _guard(tmp_path))

    assert "must not start with '-'" in exc_info.value.message


@pytest.mark.parametrize("handler", [git_diff_tool, git_show_tool])
def test_git_tools_reject_gitdir_outside_workspace(handler, tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    outside_repo = tmp_path / "outside-repo"
    (outside_repo / ".git").mkdir(parents=True)
    fake_repo = workspace_root / "fake-repo"
    fake_repo.mkdir()
    (fake_repo / ".git").write_text(f"gitdir: {outside_repo / '.git'}", encoding="utf-8")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        handler({"cwd": "fake-repo"}, WorkspaceGuard(str(workspace_root)))

    assert "workspace root" in exc_info.value.message.lower()


@pytest.mark.parametrize(
    "handler",
    [git_status_tool, git_log_tool, git_diff_tool, git_show_tool],
)
def test_read_only_git_tools_accept_mutually_linked_worktree_metadata(
    handler,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    linked = workspace_root / "linked"
    linked.mkdir(parents=True)
    common_dir = tmp_path / "primary" / ".git"
    git_dir = common_dir / "worktrees" / "linked"
    git_dir.mkdir(parents=True)
    (linked / ".git").write_text(f"gitdir: {git_dir}", encoding="utf-8")
    (git_dir / "commondir").write_text("../..", encoding="utf-8")
    (git_dir / "gitdir").write_text(str(linked / ".git"), encoding="utf-8")
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.git_ops.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="", stderr=""),
    )

    output = handler({"cwd": "linked"}, WorkspaceGuard(str(workspace_root)))

    assert isinstance(output, str)


def test_linked_worktree_metadata_rejects_an_unrelated_backlink(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    linked = workspace_root / "linked"
    linked.mkdir(parents=True)
    common_dir = tmp_path / "primary" / ".git"
    git_dir = common_dir / "worktrees" / "linked"
    git_dir.mkdir(parents=True)
    (linked / ".git").write_text(f"gitdir: {git_dir}", encoding="utf-8")
    (git_dir / "commondir").write_text("../..", encoding="utf-8")
    (git_dir / "gitdir").write_text(str(tmp_path / "unrelated" / ".git"), encoding="utf-8")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        git_status_tool({"cwd": "linked"}, WorkspaceGuard(str(workspace_root)))

    assert exc_info.value.code == CMP_TOOL_INVALID_PATH


def test_git_metadata_read_rejects_a_symlink_and_leaves_the_target_untouched(
    tmp_path: Path,
) -> None:
    # An out-of-workspace sentinel that a hostile symlinked pointer file would
    # otherwise expose. It must be neither read-through nor modified.
    sentinel = tmp_path / "sentinel_outside"
    sentinel.write_text("gitdir: /etc/attacker", encoding="utf-8")
    link = tmp_path / "gitfile_link"
    try:
        link.symlink_to(sentinel)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted on this host")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        _read_git_metadata_file(link, label=".git file")

    assert exc_info.value.code == CMP_TOOL_INVALID_PATH
    assert "symlink" in exc_info.value.message.lower()
    # Sentinel is untouched: same bytes, still present.
    assert sentinel.read_text(encoding="utf-8") == "gitdir: /etc/attacker"


def test_git_metadata_read_rejects_a_fifo(tmp_path: Path) -> None:
    if not hasattr(os, "mkfifo"):
        pytest.skip("FIFOs are not supported on this platform")
    fifo = tmp_path / "fifo_pointer"
    os.mkfifo(fifo)  # type: ignore[attr-defined]

    with pytest.raises(ToolExecutionFailure) as exc_info:
        _read_git_metadata_file(fifo, label=".git file")

    assert exc_info.value.code == CMP_TOOL_INVALID_PATH
    assert "regular file" in exc_info.value.message.lower()


def test_git_metadata_read_rejects_an_oversize_file(tmp_path: Path) -> None:
    oversize = tmp_path / "oversize_pointer"
    oversize.write_bytes(b"a" * (_GIT_METADATA_MAX_BYTES + 1))

    with pytest.raises(ToolExecutionFailure) as exc_info:
        _read_git_metadata_file(oversize, label="commondir")

    assert exc_info.value.code == CMP_TOOL_INVALID_PATH
    assert "too large" in exc_info.value.message.lower()


def test_git_metadata_read_rejects_non_utf8_bytes(tmp_path: Path) -> None:
    malformed = tmp_path / "malformed_pointer"
    malformed.write_bytes(b"gitdir: \xff\xfe\x00not-utf8")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        _read_git_metadata_file(malformed, label="gitdir")

    assert exc_info.value.code == CMP_TOOL_INVALID_PATH
    assert "utf-8" in exc_info.value.message.lower()


def test_git_metadata_read_accepts_an_ordinary_pointer_file(tmp_path: Path) -> None:
    pointer = tmp_path / "ordinary_pointer"
    pointer.write_text("gitdir: ../primary/.git/worktrees/x\n", encoding="utf-8")

    assert (
        _read_git_metadata_file(pointer, label=".git file")
        == "gitdir: ../primary/.git/worktrees/x"
    )


def test_git_diff_returns_summary_for_oversized_change_set(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    _init_minimal_repo(repo)
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):  # noqa: ANN001
        calls.append(command)
        if "--shortstat" in command:
            return SimpleNamespace(
                returncode=0,
                stdout=" 250 files changed, 12000 insertions(+), 10 deletions(-)\n",
                stderr="",
            )
        pytest.fail("full git diff should not run for oversized diffs")

    monkeypatch.setattr("sidecar.ai.tools.builtins.git_ops.subprocess.run", fake_run)

    output = git_diff_tool({"cwd": "repo"}, _guard(tmp_path))

    assert "250 files changed" in output
    assert "Patch omitted because the diff is too large" in output
    assert len(calls) == 1


def test_git_show_returns_summary_for_oversized_commit(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    _init_minimal_repo(repo)
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):  # noqa: ANN001
        calls.append(command)
        if "--shortstat" in command:
            assert "--no-patch" not in command
            return SimpleNamespace(
                returncode=0,
                stdout=" 250 files changed, 12000 insertions(+), 10 deletions(-)\n",
                stderr="",
            )
        if "--no-patch" in command:
            return SimpleNamespace(
                returncode=0,
                stdout="commit deadbeef\nAuthor: Test\n\nHuge commit\n",
                stderr="",
            )
        pytest.fail("full git show should not run for oversized commits")

    monkeypatch.setattr("sidecar.ai.tools.builtins.git_ops.subprocess.run", fake_run)

    output = git_show_tool({"cwd": "repo"}, _guard(tmp_path))

    assert "commit deadbeef" in output
    assert "250 files changed" in output
    assert "Patch omitted because the commit diff is too large" in output
    assert len(calls) == 2


def test_run_git_truncates_long_output(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.git_ops.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout="x" * (MAX_OUTPUT_CHARS + 10),
            stderr="",
        ),
    )

    output = _run_git(["status"], cwd=repo)

    assert output.endswith("\n...[truncated]")
    assert len(output) > MAX_OUTPUT_CHARS


def test_git_environment_uses_minimal_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", "C:/Tools")
    monkeypatch.setenv("HOME", "C:/Users/example")
    monkeypatch.setenv("GITHUB_TOKEN", "secret-token")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "secret-key")

    env = _git_environment()

    assert env["PATH"] == "C:/Tools"
    assert env["HOME"] == "C:/Users/example"
    assert env["GIT_PAGER"] == "cat"
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    assert env["GIT_EXTERNAL_DIFF"] == ""
    assert "GITHUB_TOKEN" not in env
    assert "AWS_ACCESS_KEY_ID" not in env


def test_git_timeout_can_be_configured_with_bounds(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    captured_timeouts: list[float] = []

    def fake_run(*_args, **kwargs):  # noqa: ANN001
        captured_timeouts.append(kwargs["timeout"])
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(git_ops_module.subprocess, "run", fake_run)
    git_ops_module.configure_git_tools({"tools_git_timeout_seconds": 999})

    try:
        _run_git(["status"], cwd=repo)
    finally:
        git_ops_module.configure_git_tools({})

    assert captured_timeouts == [120.0]


def test_run_git_surfaces_non_zero_exit(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.git_ops.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=1, stdout="", stderr="fatal: bad revision"
        ),
    )

    with pytest.raises(ToolExecutionFailure) as exc_info:
        _run_git(["show"], cwd=repo)

    assert exc_info.value.message == "fatal: bad revision"


def test_git_status_omitted_cwd_defaults_to_workspace_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / ".git").mkdir()
    captured: dict[str, object] = {}

    def fake_run(command, **kwargs):  # noqa: ANN001
        captured["cwd"] = kwargs["cwd"]
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("sidecar.ai.tools.builtins.git_ops.subprocess.run", fake_run)

    output = git_status_tool({}, _guard(tmp_path))

    assert output == "(clean working tree)"
    assert Path(str(captured["cwd"])).resolve() == tmp_path.resolve()


@pytest.mark.parametrize("blank_cwd", ["", "   "])
def test_git_status_blank_cwd_behaves_like_omitted(
    blank_cwd: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / ".git").mkdir()
    captured: dict[str, object] = {}

    def fake_run(command, **kwargs):  # noqa: ANN001
        captured["cwd"] = kwargs["cwd"]
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("sidecar.ai.tools.builtins.git_ops.subprocess.run", fake_run)

    output = git_status_tool({"cwd": blank_cwd}, _guard(tmp_path))

    assert output == "(clean working tree)"
    assert Path(str(captured["cwd"])).resolve() == tmp_path.resolve()


def test_git_status_rejects_nonexistent_cwd_with_remediation(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()

    with pytest.raises(ToolExecutionFailure) as exc_info:
        git_status_tool({"cwd": "does-not-exist"}, _guard(tmp_path))

    message = exc_info.value.message
    assert exc_info.value.code == CMP_TOOL_INVALID_PATH
    assert "cwd" in message
    assert "does-not-exist" in message
    assert "list_dir" in message
    assert "Omit 'cwd'" in message
    assert str(tmp_path.resolve()) in message


def test_git_status_rejects_non_repo_dir_and_names_workspace_root(tmp_path: Path) -> None:
    # No .git anywhere under the workspace root: cwd resolves fine as a plain
    # directory but there is no repository to root the git command in. The
    # caller passed 'cwd' explicitly, so "omit it" is genuine remediation.
    plain_dir = tmp_path / "plain"
    plain_dir.mkdir()

    with pytest.raises(ToolExecutionFailure) as exc_info:
        git_status_tool({"cwd": "plain"}, _guard(tmp_path))

    message = exc_info.value.message
    assert exc_info.value.code == CMP_TOOL_PRECONDITION_UNMET
    assert exc_info.value.retryable is False
    assert "git repository" in message
    assert "Omit 'cwd'" in message
    assert str(plain_dir.resolve()) in message
    assert str(tmp_path.resolve()) in message


@pytest.mark.parametrize("arguments", [{}, {"cwd": ""}, {"cwd": "   "}])
def test_git_status_non_repo_workspace_root_omits_nonsense_remediation(
    arguments: dict[str, object], tmp_path: Path
) -> None:
    # The incident lane: the caller never passed 'cwd', so cwd defaulted to the
    # workspace root and the root itself is not a repository. Telling the model
    # to "omit 'cwd'" would tell it to repeat exactly what it just did.
    with pytest.raises(ToolExecutionFailure) as exc_info:
        git_status_tool(dict(arguments), _guard(tmp_path))

    message = exc_info.value.message
    assert exc_info.value.code == CMP_TOOL_PRECONDITION_UNMET
    assert exc_info.value.retryable is False
    assert "is not a git repository" in message
    assert "Omit 'cwd'" not in message
    assert "Pass 'cwd'" in message
    assert str(tmp_path.resolve()) in message
