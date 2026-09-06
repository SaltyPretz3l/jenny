"""Fail on high-confidence secrets in active repo text files.

Scope (intentional): the scan covers git-visible content only — tracked files
plus non-ignored untracked files (``git ls-files --cached --others
--exclude-standard``). Gitignored files are deliberately OUT of scope: local
runtime state such as ``config.json`` and ``.env`` holds real user secrets by
design, cannot be committed, and is excluded from every export path
(``create_github_stage.py`` stages from git content). This gate protects what
can leave the machine via git, not the local working directory. The
``ROOT.rglob`` walk (with the SKIP_* lists) remains only as the fallback for
exported/no-git workspaces, where git visibility cannot be computed.
"""
from __future__ import annotations

import math
import re
import subprocess
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

SKIP_DIRS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    ".claude",
    ".jenny",
    ".tmp",
    "archive",
    "artifacts",
    "build",
    "coverage",
    "dist",
    "llama_server_extract",
    "node_modules",
    "out",
    "PORT_BUNDLES",
    "repomix",
}
SKIP_RELATIVE_PREFIXES = {
    "vendor/unsloth",
}
SKIP_FILENAMES = {
    ".coverage",
    ".env",
    "config.json",
    "coverage.json",
}
SKIP_NAME_PREFIXES = (
    "repomix_",
)
SKIP_SUFFIXES = {
    ".bin",
    ".dll",
    ".dmg",
    ".enc",
    ".exe",
    ".gguf",
    ".ico",
    ".jpg",
    ".jpeg",
    ".log",
    ".pdf",
    ".png",
    ".pyc",
    ".sqlite",
    ".webp",
    ".zip",
}
PLACEHOLDER_TOKENS = {
    "changeme",
    "dummy",
    "example",
    "placeholder",
    "sample",
    "test",
    "your",
}
PRIVATE_KEY_RE = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
TOKEN_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{32,}\b"),
    re.compile(r"\bsk-ant-[A-Za-z0-9_-]{24,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{30,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
]
ASSIGNMENT_RE = re.compile(
    r"(?i)\b(?:api[_-]?key|secret|token|password|credential)\b"
    r"\s*[:=]\s*['\"]([^'\"]{20,})['\"]"
)


def _repo_path(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def _is_skipped(path: Path, *, apply_local_exclusions: bool) -> bool:
    """Whether to skip a candidate. The two exclusion classes are NOT interchangeable.

    Binary suffixes are skipped however the candidate was found -- scanning them is
    pointless and slow, and that is true of a tracked .png as much as an untracked one.

    The path/directory/filename exclusions below are a different thing entirely: they
    exist to keep the rglob FALLBACK from wading through untracked local state
    (build output, caches, .env files) when git cannot list the repository. Applying
    them to git-visible candidates is what W6-07-F01 reports -- a secret committed
    under a tracked path whose name happens to match one of these prefixes was
    skipped by the gate precisely because it was tracked. If git can see it, it is
    repository content and gets scanned.
    """
    if path.suffix.lower() in SKIP_SUFFIXES:
        return True
    if not apply_local_exclusions:
        return False
    relative_path = path.relative_to(ROOT).as_posix()
    return (
        any(
            relative_path == prefix or relative_path.startswith(f"{prefix}/")
            for prefix in SKIP_RELATIVE_PREFIXES
        )
        or any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts)
        or path.name in SKIP_FILENAMES
        or any(path.name.startswith(prefix) for prefix in SKIP_NAME_PREFIXES)
    )


def _looks_placeholder(value: str) -> bool:
    lowered = value.lower()
    return any(token in lowered for token in PLACEHOLDER_TOKENS)


def _entropy(value: str) -> float:
    if not value:
        return 0.0
    counts = Counter(value)
    return -sum((count / len(value)) * math.log2(count / len(value)) for count in counts.values())


def _looks_secret_assignment(value: str) -> bool:
    if _looks_placeholder(value):
        return False
    stripped = value.strip()
    if len(stripped) < 24:
        return False
    return _entropy(stripped) >= 3.5


def _scan_line(line: str) -> bool:
    if PRIVATE_KEY_RE.search(line):
        return True
    for pattern in TOKEN_PATTERNS:
        match = pattern.search(line)
        if match and not _looks_placeholder(match.group(0)):
            return True
    assignment = ASSIGNMENT_RE.search(line)
    return bool(assignment and _looks_secret_assignment(assignment.group(1)))


def _git_visible_paths() -> list[Path] | None:
    """Return tracked and non-ignored untracked paths, or None without git."""
    try:
        completed = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="surrogateescape",
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None

    root = ROOT.resolve()
    paths: list[Path] = []
    for relative_path in completed.stdout.split("\0"):
        if not relative_path:
            continue
        candidate = (ROOT / relative_path).resolve(strict=False)
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        paths.append(candidate)
    return paths


def _iter_text_files() -> Iterator[Path]:
    candidates = _git_visible_paths()
    apply_local_exclusions = candidates is None
    if candidates is None:
        candidates = ROOT.rglob("*")
    for path in candidates:
        if not path.is_file() or _is_skipped(
            path, apply_local_exclusions=apply_local_exclusions
        ):
            continue
        yield path


def find_secret_lines() -> list[str]:
    violations: list[str] = []
    for path in _iter_text_files():
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for lineno, line in enumerate(lines, start=1):
            if _scan_line(line):
                violations.append(f"{_repo_path(path)}:{lineno}")
    return violations


def main() -> int:
    violations = find_secret_lines()
    if violations:
        print("FAIL: potential secrets detected")
        for violation in violations:
            print(f"  - {violation}")
        return 1

    print("PASS: no high-confidence secrets detected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
