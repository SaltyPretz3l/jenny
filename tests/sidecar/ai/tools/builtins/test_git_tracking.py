"""Tests for post-execution git operation detection."""

from __future__ import annotations

from sidecar.ai.tools.builtins.git_tracking import detect_git_operations


def test_detect_git_commit() -> None:
    stdout = "[main abc1234] fix: resolve null pointer\n 1 file changed"
    ops = detect_git_operations("git commit -m 'fix'", stdout, "")
    assert len(ops) == 1
    assert ops[0].kind == "commit"
    assert ops[0].branch == "main"
    assert ops[0].sha == "abc1234"


def test_detect_git_push() -> None:
    stderr = "To github.com:user/repo.git\n   abc1234..def5678  main -> main\n"
    ops = detect_git_operations("git push origin main", "", stderr)
    assert len(ops) == 1
    assert ops[0].kind == "push"
    assert ops[0].branch == "main"
    assert ops[0].sha == "def5678"
    assert ops[0].remote == "github.com:user/repo.git"


def test_detect_git_push_new_branch() -> None:
    stderr = "To github.com:user/repo.git\n * [new branch]      feat -> feat\n"
    ops = detect_git_operations("git push -u origin feat", "", stderr)
    assert len(ops) == 1
    assert ops[0].kind == "push"
    assert ops[0].branch == "feat"


def test_detect_git_merge() -> None:
    stdout = "Merge made by the 'ort' strategy.\n 2 files changed"
    ops = detect_git_operations("git merge feature-branch", stdout, "")
    assert len(ops) == 1
    assert ops[0].kind == "merge"


def test_detect_git_merge_fast_forward() -> None:
    stdout = "Fast-forward\n file.txt | 1 +\n 1 file changed"
    ops = detect_git_operations("git merge hotfix", stdout, "")
    assert len(ops) == 1
    assert ops[0].kind == "merge"


def test_detect_git_rebase() -> None:
    stderr = "Successfully rebased and updated refs/heads/feature."
    ops = detect_git_operations("git rebase main", "", stderr)
    assert len(ops) == 1
    assert ops[0].kind == "rebase"
    # Git's trailing sentence period is punctuation, not part of the ref: a
    # branch name cannot end with a dot. This asserted "feature." until 2026-08-27.
    assert ops[0].branch == "feature"
    assert ops[0].summary == "rebased feature"


def test_detect_git_rebase_keeps_dots_inside_the_branch_name() -> None:
    # Only the sentence-ending dot is punctuation; internal dots are legal in a
    # ref component, so a naive rstrip(".") or split(".") would corrupt this.
    stderr = "Successfully rebased and updated refs/heads/release/1.2.3."
    ops = detect_git_operations("git rebase main", "", stderr)
    assert len(ops) == 1
    assert ops[0].branch == "release/1.2.3"


def test_detect_git_cherry_pick() -> None:
    stdout = "[main deadbeef] cherry-picked fix"
    ops = detect_git_operations("git cherry-pick abc123", stdout, "")
    assert len(ops) == 1
    assert ops[0].kind == "cherry_pick"
    assert ops[0].sha == "deadbeef"


def test_detect_branch_create() -> None:
    stderr = "Switched to a new branch 'feature-x'"
    ops = detect_git_operations("git checkout -b feature-x", "", stderr)
    assert len(ops) == 1
    assert ops[0].kind == "branch_create"
    assert ops[0].branch == "feature-x"


def test_detect_switch_create() -> None:
    stderr = "Switched to a new branch 'my-branch'"
    ops = detect_git_operations("git switch -c my-branch", "", stderr)
    assert len(ops) == 1
    assert ops[0].kind == "branch_create"
    assert ops[0].branch == "my-branch"


def test_detect_gh_pr_create() -> None:
    stdout = "https://github.com/owner/repo/pull/42\n"
    ops = detect_git_operations("gh pr create --title 'fix'", stdout, "")
    assert len(ops) == 1
    assert ops[0].kind == "pr_create"
    assert ops[0].pr_number == 42
    assert ops[0].pr_url == "https://github.com/owner/repo/pull/42"


def test_detect_glab_mr_create() -> None:
    stdout = "https://gitlab.com/group/project/-/merge_requests/99\n"
    ops = detect_git_operations("glab mr create", stdout, "")
    assert len(ops) == 1
    assert ops[0].kind == "pr_create"
    assert ops[0].pr_number == 99


def test_gh_non_create_command_does_not_report_pr_create() -> None:
    stdout = "https://github.com/owner/repo/pull/42\n"
    ops = detect_git_operations("gh pr view 42", stdout, "")
    assert ops == []


def test_no_git_operation_for_read_commands() -> None:
    ops = detect_git_operations("git status", "## main\n M file.txt", "")
    assert ops == []


def test_no_git_operation_for_non_git() -> None:
    ops = detect_git_operations("echo hello", "hello", "")
    assert ops == []


def test_git_global_options_handled() -> None:
    stdout = "[main 1234567] msg"
    ops = detect_git_operations("git -C /some/path commit -m 'msg'", stdout, "")
    assert len(ops) == 1
    assert ops[0].kind == "commit"


def test_multiple_operations_not_merged() -> None:
    """Each detector is called per subcommand — compound commands
    are not split by this module (that's shell_security's job).
    The shell.py integration detects the primary subcommand only."""
    # A single push with range output
    stderr = "To origin\n   aaa1111..bbb2222  main -> main\n   ccc3333..ddd4444  dev -> dev\n"
    ops = detect_git_operations("git push --all", "", stderr)
    assert len(ops) == 2
    assert all(op.kind == "push" for op in ops)


def test_push_with_pr_url_in_stderr() -> None:
    """Some git hosts print a PR creation URL after push."""
    stderr = (
        "To github.com:user/repo.git\n"
        "   aaa..bbb  feat -> feat\n"
        "remote: Create a pull request:\n"
        "remote:   https://github.com/user/repo/pull/7\n"
    )
    # git push triggers push detector, not PR detector
    ops = detect_git_operations("git push origin feat", "", stderr)
    assert any(op.kind == "push" for op in ops)


def test_empty_output_returns_empty() -> None:
    ops = detect_git_operations("git commit --allow-empty -m 'empty'", "", "")
    assert ops == []
