"""Post-execution git operation detection for shell commands.

Pure text analysis — parses command strings and stdout/stderr to detect
git write operations (commit, push, merge, rebase, cherry-pick, PR
creation) and extract SHAs, branch names, and PR URLs.

Called from ``shell.py`` after subprocess completion, NOT from the
read-only ``git_ops.py`` tools.  Feature-gated behind
``FEATURE_GIT_TRACKING``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class GitOperation:
    kind: str
    branch: str | None = None
    sha: str | None = None
    pr_number: int | None = None
    pr_url: str | None = None
    remote: str | None = None
    summary: str = ""


# ── Regex patterns for output parsing ─────────────────────────────────

# git commit: [main abc1234] commit message
_RE_COMMIT = re.compile(
    r"\[(?P<branch>[^\]\s]+)\s+(?P<sha>[0-9a-f]{7,40})\]",
)

# git push: abc1234..def5678  main -> main  OR  * [new branch] main -> main
_RE_PUSH_RANGE = re.compile(
    r"(?P<old>[0-9a-f]{3,40})\.\.(?P<new>[0-9a-f]{3,40})\s+"
    r"(?P<local>\S+)\s+->\s+(?P<remote_branch>\S+)",
)
_RE_PUSH_NEW = re.compile(
    r"\*\s+\[new branch\]\s+(?P<local>\S+)\s+->\s+(?P<remote_branch>\S+)",
)
_RE_PUSH_TO = re.compile(r"To\s+(?P<remote>\S+)")

# git merge: Merge made by the '...' strategy.  OR  Fast-forward
_RE_MERGE_COMMIT = re.compile(r"Merge made by")
_RE_MERGE_FF = re.compile(r"Fast-forward")

# git cherry-pick: [main abc1234] cherry-picked message
_RE_CHERRY_PICK = _RE_COMMIT  # same output format

# git checkout -b / git switch -c
_RE_BRANCH_CREATE = re.compile(
    r"Switched to a new branch '(?P<branch>[^']+)'",
)

# GitHub / GitLab PR/MR URL
_RE_PR_URL = re.compile(
    r"(?P<url>https?://[^\s]+/(?:pull|merge_requests)/(?P<number>\d+))",
)

# git rebase: Successfully rebased and updated refs/heads/<branch>.
# Git ends that line with a sentence period. A ref component can never end with
# a dot (git check-ref-format), so a trailing dot is always Git's punctuation
# and never part of the branch name -- but an INTERNAL dot can be (release/1.2.3),
# so strip only one at the end rather than splitting on ".".
_RE_REBASE = re.compile(
    r"Successfully rebased and updated refs/heads/(?P<branch>\S+?)\.?(?=\s|$)",
)


# ── Git global-option skipping (shared logic with shell_security) ─────


def _extract_git_subcommand(argv: list[str]) -> str | None:
    """Return the git subcommand from *argv*, skipping global options."""
    i = 1
    while i < len(argv):
        token = argv[i]
        if token in ("-c", "-C", "--git-dir", "--work-tree", "--namespace"):
            i += 2
            continue
        if token.startswith(("--git-dir=", "--work-tree=", "--namespace=")):
            i += 1
            continue
        if token in ("--no-pager", "--bare", "--no-replace-objects"):
            i += 1
            continue
        if token.startswith("-") and not token.startswith("--"):
            i += 1
            continue
        return token.lower()
    return None


def _safe_argv(command: str) -> list[str]:
    """Best-effort tokenization of *command* for subcommand detection."""
    import shlex

    try:
        return shlex.split(command, posix=False)
    except ValueError:
        return command.split()


def _extract_cli_subcommand(argv: list[str]) -> tuple[str | None, str | None]:
    if not argv:
        return None, None
    exe = argv[0].lower().rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    for ext in (".exe", ".cmd", ".bat"):
        if exe.endswith(ext):
            exe = exe[: -len(ext)]
    if exe == "gh" and len(argv) >= 3:
        return exe, f"{argv[1].lower()} {argv[2].lower()}"
    if exe == "glab" and len(argv) >= 3:
        return exe, f"{argv[1].lower()} {argv[2].lower()}"
    return exe, None


# ── Per-subcommand detectors ──────────────────────────────────────────


def _detect_commit(stdout: str, stderr: str) -> list[GitOperation]:
    ops: list[GitOperation] = []
    for m in _RE_COMMIT.finditer(stdout):
        ops.append(
            GitOperation(
                kind="commit",
                branch=m.group("branch"),
                sha=m.group("sha"),
                summary=f"committed {m.group('sha')} on {m.group('branch')}",
            )
        )
    return ops


def _detect_push(stdout: str, stderr: str) -> list[GitOperation]:
    combined = f"{stdout}\n{stderr}"
    remote_match = _RE_PUSH_TO.search(combined)
    remote = remote_match.group("remote") if remote_match else None

    ops: list[GitOperation] = []
    for m in _RE_PUSH_RANGE.finditer(combined):
        ops.append(
            GitOperation(
                kind="push",
                branch=m.group("remote_branch"),
                sha=m.group("new"),
                remote=remote,
                summary=f"pushed {m.group('local')} -> {m.group('remote_branch')}",
            )
        )
    for m in _RE_PUSH_NEW.finditer(combined):
        ops.append(
            GitOperation(
                kind="push",
                branch=m.group("remote_branch"),
                remote=remote,
                summary=f"pushed new branch {m.group('local')} -> {m.group('remote_branch')}",
            )
        )
    return ops


def _detect_merge(stdout: str, stderr: str) -> list[GitOperation]:
    if _RE_MERGE_COMMIT.search(stdout) or _RE_MERGE_FF.search(stdout):
        return [GitOperation(kind="merge", summary="merge completed")]
    return []


def _detect_rebase(stdout: str, stderr: str) -> list[GitOperation]:
    combined = f"{stdout}\n{stderr}"
    m = _RE_REBASE.search(combined)
    if m:
        return [
            GitOperation(
                kind="rebase",
                branch=m.group("branch"),
                summary=f"rebased {m.group('branch')}",
            )
        ]
    return []


def _detect_cherry_pick(stdout: str, stderr: str) -> list[GitOperation]:
    ops: list[GitOperation] = []
    for m in _RE_CHERRY_PICK.finditer(stdout):
        ops.append(
            GitOperation(
                kind="cherry_pick",
                branch=m.group("branch"),
                sha=m.group("sha"),
                summary=f"cherry-picked {m.group('sha')}",
            )
        )
    return ops


def _detect_branch_create(stdout: str, stderr: str) -> list[GitOperation]:
    combined = f"{stdout}\n{stderr}"
    m = _RE_BRANCH_CREATE.search(combined)
    if m:
        return [
            GitOperation(
                kind="branch_create",
                branch=m.group("branch"),
                summary=f"created branch {m.group('branch')}",
            )
        ]
    return []


def _detect_pr_create(stdout: str, stderr: str) -> list[GitOperation]:
    combined = f"{stdout}\n{stderr}"
    ops: list[GitOperation] = []
    for m in _RE_PR_URL.finditer(combined):
        ops.append(
            GitOperation(
                kind="pr_create",
                pr_number=int(m.group("number")),
                pr_url=m.group("url"),
                summary=f"PR #{m.group('number')} at {m.group('url')}",
            )
        )
    return ops


# Map subcommand -> detector function
_SUBCOMMAND_DISPATCH: dict[str, object] = {
    "commit": _detect_commit,
    "push": _detect_push,
    "merge": _detect_merge,
    "rebase": _detect_rebase,
    "cherry-pick": _detect_cherry_pick,
    "checkout": _detect_branch_create,
    "switch": _detect_branch_create,
}


# ── Public API ────────────────────────────────────────────────────────


def detect_git_operations(
    command: str,
    stdout: str,
    stderr: str,
) -> list[GitOperation]:
    """Detect git write operations from *command* and its output.

    Returns an empty list when no operations are detected.
    """
    argv = _safe_argv(command)
    if not argv:
        return []

    exe, cli_subcommand = _extract_cli_subcommand(argv)

    if exe == "gh":
        return _detect_pr_create(stdout, stderr) if cli_subcommand == "pr create" else []
    if exe == "glab":
        return _detect_pr_create(stdout, stderr) if cli_subcommand == "mr create" else []

    if exe != "git":
        return []

    subcmd = _extract_git_subcommand(argv)
    if subcmd is None:
        return []

    detector = _SUBCOMMAND_DISPATCH.get(subcmd)
    if detector is not None:
        return detector(stdout, stderr)  # type: ignore[operator]

    # PR URL detection for any git command (e.g. git push may print PR URL)
    return _detect_pr_create(stdout, stderr)
