"""Orientation-only ignore policy and deterministic file ranking for manifest v2.

Git remains the authority for ``.gitignore`` semantics inside a worktree.  The
optional root ``.jennyignore`` is intentionally narrower: a bounded Git-style
subset used only to keep low-value paths out of the generated orientation map.
Neither source changes :class:`WorkspaceGuard` or direct tool access.
"""

from __future__ import annotations

import os
import re
import stat as stat_module
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Final, Iterable

from sidecar.ai.tools.builtins.git_process import git_environment
from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcessCapacityError,
    OwnedProcessError,
    OwnedProcessResult,
    get_owned_process_service,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_path_identity import is_link_object

IGNORE_FILE_MAX_BYTES: Final[int] = 32 * 1024
IGNORE_RULE_MAX_COUNT: Final[int] = 256
IGNORE_PATTERN_MAX_CHARS: Final[int] = 512
GIT_INVENTORY_MAX_PATHS: Final[int] = 50_000
GIT_INVENTORY_MAX_SECONDS: Final[float] = 1.5
RANKED_FILE_LIMIT: Final[int] = 24
_INVENTORY_CASE_INSENSITIVE: Final[bool] = os.name == "nt"

INVENTORY_REASON_COMMAND_FAILED = "command_failed"
INVENTORY_REASON_MALFORMED_OUTPUT = "malformed_output"
INVENTORY_REASON_OUTPUT_TRUNCATED = "output_truncated"
INVENTORY_REASON_PATH_BUDGET = "path_budget"
INVENTORY_REASON_TIME_BUDGET = "time_budget"

INVENTORY_STATUS_COMPLETE = "complete"
INVENTORY_STATUS_DEGRADED = "degraded"
INVENTORY_STATUS_NOT_REPOSITORY = "not_repository"
# Git answered for a repository that does not index this workspace.
INVENTORY_STATUS_UNCOVERED = "uncovered"

CLASS_SOURCE = "source"
CLASS_TEST = "test"
CLASS_DOCUMENTATION = "documentation"
CLASS_CONFIGURATION = "configuration"
CLASS_GENERATED = "generated"
CLASS_OTHER = "other"
FILE_CLASSIFICATIONS: Final[tuple[str, ...]] = (
    CLASS_SOURCE,
    CLASS_TEST,
    CLASS_DOCUMENTATION,
    CLASS_CONFIGURATION,
    CLASS_GENERATED,
    CLASS_OTHER,
)

_SOURCE_EXTENSIONS = frozenset(
    {
        ".c",
        ".cc",
        ".cpp",
        ".cs",
        ".go",
        ".h",
        ".hpp",
        ".java",
        ".js",
        ".jsx",
        ".kt",
        ".lua",
        ".mjs",
        ".php",
        ".py",
        ".rb",
        ".rs",
        ".sh",
        ".sql",
        ".swift",
        ".ts",
        ".tsx",
        ".vue",
    }
)
_DOCUMENT_EXTENSIONS = frozenset({".md", ".mdx", ".rst"})
_CONFIG_EXTENSIONS = frozenset({".cfg", ".ini", ".json", ".toml", ".yaml", ".yml"})
_GENERATED_SEGMENTS = frozenset(
    {
        ".cache",
        "artifacts",
        "build",
        "coverage",
        "dist",
        "generated",
        "out",
        "target",
        "vendor",
    }
)
_TEST_SEGMENTS = frozenset({"__tests__", "fixture", "fixtures", "spec", "specs", "test", "tests"})
_DOC_SEGMENTS = frozenset({"doc", "docs", "documentation"})
_CONFIG_NAMES = frozenset(
    {
        ".editorconfig",
        ".gitattributes",
        ".gitignore",
        ".jennyignore",
        "cargo.toml",
        "composer.json",
        "gemfile",
        "go.mod",
        "makefile",
        "package.json",
        "pipfile",
        "pom.xml",
        "pyproject.toml",
        "requirements.txt",
        "setup.cfg",
        "setup.py",
        "tsconfig.json",
    }
)
_CLASS_SCORES: Final[dict[str, int]] = {
    CLASS_SOURCE: 100,
    CLASS_TEST: 80,
    CLASS_CONFIGURATION: 70,
    CLASS_DOCUMENTATION: 60,
    CLASS_OTHER: 20,
    CLASS_GENERATED: 5,
}
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_INVENTORY_PATH_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


@dataclass(frozen=True)
class _IgnoreRule:
    matcher: re.Pattern[str]
    negated: bool

    def matches(self, relative_path: str) -> bool:
        return bool(self.matcher.fullmatch(relative_path))


@dataclass(frozen=True)
class IgnoreSource:
    name: str
    status: str
    rules: tuple[_IgnoreRule, ...] = ()

    def allows(self, relative_path: str) -> bool:
        included = True
        for rule in self.rules:
            if rule.matches(relative_path):
                included = rule.negated
        return included

    def diagnostic(self) -> dict[str, object]:
        return {
            "name": self.name,
            "status": self.status,
            "rules_loaded": len(self.rules),
        }


@dataclass(frozen=True)
class ManifestScanPolicy:
    """Immutable filter applied before filesystem entries consume scan budget."""

    inventory_files: frozenset[str] | None
    inventory_directories: frozenset[str]
    inventory_status: str
    inventory_degraded_reason: str | None
    ignore_sources: tuple[IgnoreSource, ...]

    def allows(self, relative_path: str, *, is_directory: bool) -> bool:
        normalized = _normalize_relative_path(relative_path)
        if not normalized:
            return True
        if not _safe_inventory_path(normalized):
            return False
        if self.inventory_files is not None:
            inventory_key = _inventory_key(normalized)
            if is_directory:
                inventory_match = (
                    inventory_key in self.inventory_directories
                    or inventory_key in self.inventory_files
                )
            else:
                inventory_match = inventory_key in self.inventory_files
            if not inventory_match:
                return False
        return all(source.allows(normalized) for source in self.ignore_sources)

    def diagnostics(
        self,
        *,
        excluded_entries: int,
        ranked_candidates: int,
    ) -> dict[str, object]:
        return {
            "inventory": {
                "mode": "git" if self.inventory_files is not None else "filesystem",
                "status": self.inventory_status,
                "degraded_reason": self.inventory_degraded_reason,
                "paths_indexed": len(self.inventory_files or ()),
            },
            "ignore_sources": [source.diagnostic() for source in self.ignore_sources],
            "excluded_entries": max(0, int(excluded_entries)),
            "ranking": {
                "method": "static_v1",
                "candidate_count": max(0, int(ranked_candidates)),
                "limit": RANKED_FILE_LIMIT,
            },
        }


@dataclass(frozen=True)
class RankedFileCandidate:
    path: str
    classification: str
    score: int
    reasons: tuple[str, ...]

    def payload(self) -> dict[str, object]:
        return {
            "path": self.path,
            "classification": self.classification,
            "score": self.score,
            "reasons": list(self.reasons),
        }


@dataclass(frozen=True)
class _GitInventory:
    files: frozenset[str] | None
    directories: frozenset[str]
    degraded_reason: str | None


def build_manifest_scan_policy(
    root: Path,
    *,
    timeout_seconds: float,
) -> ManifestScanPolicy:
    """Build a bounded orientation policy without changing workspace authority."""
    git_marker = _git_marker_present(root)
    inventory = _read_git_inventory(root, timeout_seconds=timeout_seconds) if git_marker else None
    if inventory is not None and inventory.files is not None:
        if _inventory_covers(inventory, root):
            return ManifestScanPolicy(
                inventory_files=inventory.files,
                inventory_directories=inventory.directories,
                inventory_status=INVENTORY_STATUS_COMPLETE,
                inventory_degraded_reason=None,
                ignore_sources=(
                    IgnoreSource(name=".gitignore", status="git"),
                    _read_ignore_source(root, ".jennyignore"),
                ),
            )
        # Git answered, but for a repository that does not index this
        # workspace at all -- a plain folder nested under a repo that ignores
        # it. The empty file list is git's truth about the repository, not
        # about the folder: trusting it would erase every file that is really
        # here and report an occupied workspace as an empty one.
        return _filesystem_scan_policy(root, status=INVENTORY_STATUS_UNCOVERED)

    degraded_reason = inventory.degraded_reason if inventory is not None else None
    return _filesystem_scan_policy(
        root,
        status=INVENTORY_STATUS_DEGRADED if degraded_reason else INVENTORY_STATUS_NOT_REPOSITORY,
        degraded_reason=degraded_reason,
    )


def _filesystem_scan_policy(
    root: Path,
    *,
    status: str,
    degraded_reason: str | None = None,
) -> ManifestScanPolicy:
    """Scan the filesystem, filtered only by the root ignore files."""
    return ManifestScanPolicy(
        inventory_files=None,
        inventory_directories=frozenset(),
        inventory_status=status,
        inventory_degraded_reason=degraded_reason,
        ignore_sources=(
            _read_ignore_source(root, ".gitignore"),
            _read_ignore_source(root, ".jennyignore"),
        ),
    )


def _inventory_covers(inventory: _GitInventory, root: Path) -> bool:
    """Does this git inventory actually describe the workspace it names?

    Only an empty inventory is ever in doubt, and only over a workspace that
    holds something: an empty answer about an empty folder is the truth.
    """
    if inventory.files:
        return True
    return not _workspace_holds_entries(root)


def _workspace_holds_entries(root: Path) -> bool:
    """Report whether the workspace holds anything besides its git metadata.

    Bounded to the first entry -- this only decides whether an empty git
    inventory is believable, so nothing is gained by walking further.
    """
    try:
        with os.scandir(root) as entries:
            for entry in entries:
                if entry.name == ".git":
                    continue
                return True
    except OSError:
        return False
    return False


def classify_workspace_path(relative_path: str) -> str:
    normalized = _normalize_relative_path(relative_path)
    path = PurePosixPath(normalized)
    parts = tuple(part.casefold() for part in path.parts)
    name = path.name.casefold()
    suffix = path.suffix.casefold()

    classification = CLASS_OTHER
    if any(part in _GENERATED_SEGMENTS for part in parts) or name.endswith(".min.js"):
        classification = CLASS_GENERATED
    elif any(part in _TEST_SEGMENTS for part in parts[:-1]):
        classification = CLASS_TEST
    elif any(part in _DOC_SEGMENTS for part in parts[:-1]):
        classification = CLASS_DOCUMENTATION
    elif _looks_like_test_name(name):
        classification = CLASS_TEST
    elif suffix in _DOCUMENT_EXTENSIONS:
        classification = CLASS_DOCUMENTATION
    elif name in _CONFIG_NAMES or suffix in _CONFIG_EXTENSIONS:
        classification = CLASS_CONFIGURATION
    elif suffix in _SOURCE_EXTENSIONS:
        classification = CLASS_SOURCE
    return classification


def make_ranked_file_candidate(
    relative_path: str,
    *,
    is_entry_point: bool,
) -> RankedFileCandidate:
    normalized = _normalize_relative_path(relative_path)
    classification = classify_workspace_path(normalized)
    score = _CLASS_SCORES[classification]
    reasons = [f"class:{classification}"]
    if is_entry_point:
        score += 40
        reasons.append("entry_point")
    if "/" not in normalized:
        score += 10
        reasons.append("workspace_root")
    return RankedFileCandidate(
        path=normalized,
        classification=classification,
        score=score,
        reasons=tuple(reasons),
    )


def order_ranked_files(
    candidates: Iterable[RankedFileCandidate],
    *,
    limit: int = RANKED_FILE_LIMIT,
) -> list[dict[str, object]]:
    ordered = sorted(
        candidates,
        key=lambda item: (-item.score, item.classification, item.path.casefold(), item.path),
    )
    return [candidate.payload() for candidate in ordered[: max(0, int(limit))]]


def empty_classification_counts() -> dict[str, int]:
    return {classification: 0 for classification in FILE_CLASSIFICATIONS}


def _read_git_inventory(root: Path, *, timeout_seconds: float) -> _GitInventory:
    timeout = min(GIT_INVENTORY_MAX_SECONDS, max(0.0, float(timeout_seconds)))
    result, degraded_reason = _run_git_inventory_command(root, timeout_seconds=timeout)
    if result is None:
        return _GitInventory(None, frozenset(), degraded_reason)
    return _parse_git_inventory_result(result)


def _run_git_inventory_command(
    root: Path,
    *,
    timeout_seconds: float,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[OwnedProcessResult | None, str]:
    if timeout_seconds <= 0.0:
        return None, INVENTORY_REASON_TIME_BUDGET
    deadline = clock() + timeout_seconds
    service = get_owned_process_service()
    try:
        owned = service.spawn(
            [
                "git",
                "-C",
                str(root),
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
            ],
            cwd=root,
            env=git_environment(),
            allow_queue=True,
            queue_timeout_seconds=timeout_seconds,
        )
        result = service.wait(
            owned,
            timeout_seconds=max(0.0, deadline - clock()),
        )
    except (OSError, OwnedProcessError) as error:
        reason = (
            INVENTORY_REASON_TIME_BUDGET
            if isinstance(error, OwnedProcessCapacityError)
            else INVENTORY_REASON_COMMAND_FAILED
        )
        return None, reason
    if result.timed_out or result.aborted:
        return None, INVENTORY_REASON_TIME_BUDGET
    if result.output.truncated or result.drain_incomplete:
        return None, INVENTORY_REASON_OUTPUT_TRUNCATED
    if result.returncode != 0:
        return None, INVENTORY_REASON_COMMAND_FAILED
    return result, ""


def _parse_git_inventory_result(result: OwnedProcessResult) -> _GitInventory:
    if "\ufffd" in result.stdout:
        return _GitInventory(None, frozenset(), INVENTORY_REASON_MALFORMED_OUTPUT)

    paths = [_normalize_relative_path(path) for path in result.stdout.split("\0") if path]
    if len(paths) > GIT_INVENTORY_MAX_PATHS:
        return _GitInventory(None, frozenset(), INVENTORY_REASON_PATH_BUDGET)
    if any(not _safe_inventory_path(path) for path in paths):
        return _GitInventory(None, frozenset(), INVENTORY_REASON_MALFORMED_OUTPUT)
    files = frozenset(_inventory_key(path) for path in paths)
    directories = frozenset(
        parent
        for path in files
        for parent in _relative_parent_paths(path)
        if parent
    )
    return _GitInventory(files, directories, None)


def _read_ignore_source(root: Path, name: str) -> IgnoreSource:
    candidate = root / name
    content, status = _read_ignore_bytes(candidate)
    if content is None:
        return IgnoreSource(name=name, status=status)
    try:
        text = content.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return IgnoreSource(name=name, status="malformed")
    if _CONTROL_CHARS_RE.search(text):
        return IgnoreSource(name=name, status="malformed")
    try:
        rules = _parse_ignore_rules(text)
    except ValueError:
        return IgnoreSource(name=name, status="oversized")
    return IgnoreSource(name=name, status="loaded", rules=rules)


def _read_ignore_bytes(candidate: Path) -> tuple[bytes | None, str]:
    status = _inspect_ignore_candidate(candidate)
    if status != "ready":
        return None, status
    return _read_ignore_handle(candidate)


def _inspect_ignore_candidate(candidate: Path) -> str:
    try:
        file_stat = os.lstat(candidate)
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "unreadable"
    try:
        if is_link_object(candidate):
            return "refused"
    except ToolExecutionFailure:
        return "unreadable"
    if file_stat.st_size > IGNORE_FILE_MAX_BYTES:
        return "oversized"
    return "ready"


def _read_ignore_handle(candidate: Path) -> tuple[bytes | None, str]:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(str(candidate), flags)
    except OSError:
        return None, "unreadable"
    content: bytes | None = None
    status = "unreadable"
    try:
        if not stat_module.S_ISREG(os.fstat(descriptor).st_mode):
            status = "refused"
        else:
            content = os.read(descriptor, IGNORE_FILE_MAX_BYTES + 1)
            status = "ready"
    except OSError:
        pass
    finally:
        os.close(descriptor)
    if content is not None and len(content) > IGNORE_FILE_MAX_BYTES:
        return None, "oversized"
    return content, status


def _parse_ignore_rules(text: str) -> tuple[_IgnoreRule, ...]:
    rules: list[_IgnoreRule] = []
    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if not line or line.startswith("#"):
            continue
        escaped_prefix = line.startswith((r"\#", r"\!"))
        if escaped_prefix:
            line = line[1:]
        negated = line.startswith("!") and not escaped_prefix
        if negated:
            line = line[1:]
        if not line:
            continue
        if len(line) > IGNORE_PATTERN_MAX_CHARS or len(rules) >= IGNORE_RULE_MAX_COUNT:
            raise ValueError("ignore rule budget exceeded")
        rules.append(_compile_ignore_rule(line, negated=negated))
    return tuple(rules)


def _compile_ignore_rule(pattern: str, *, negated: bool) -> _IgnoreRule:
    anchored = pattern.startswith("/")
    directory_only = pattern.endswith("/")
    normalized = pattern.strip("/").replace("\\", "/")
    if not normalized:
        return _IgnoreRule(re.compile(r"(?!)"), negated)
    translated = _translate_glob(normalized)
    if "/" not in normalized and not anchored:
        expression = rf"(?:^|.*/){translated}(?:$|/.*)"
    else:
        suffix = r"(?:/.*)?" if directory_only else ""
        expression = rf"{translated}{suffix}"
    return _IgnoreRule(re.compile(expression), negated)


def _translate_glob(pattern: str) -> str:
    pieces: list[str] = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if index + 1 < len(pattern) and pattern[index + 1] == "*":
                index += 1
                if index + 1 < len(pattern) and pattern[index + 1] == "/":
                    index += 1
                    pieces.append(r"(?:.*/)?")
                else:
                    pieces.append(r".*")
            else:
                pieces.append(r"[^/]*")
        elif char == "?":
            pieces.append(r"[^/]")
        else:
            pieces.append(re.escape(char))
        index += 1
    return "".join(pieces)


def _git_marker_present(root: Path) -> bool:
    for directory in (root, *root.parents):
        marker = directory / ".git"
        try:
            mode = os.lstat(marker).st_mode
        except OSError:
            continue
        if stat_module.S_ISDIR(mode) or stat_module.S_ISREG(mode):
            return True
    return False


def _relative_parent_paths(path: str) -> tuple[str, ...]:
    parts = PurePosixPath(path).parts[:-1]
    return tuple("/".join(parts[:index]) for index in range(1, len(parts) + 1))


def _normalize_relative_path(path: str) -> str:
    return str(path).replace("\\", "/").strip("/")


def _inventory_key(path: str) -> str:
    normalized = _normalize_relative_path(path)
    return normalized.casefold() if _INVENTORY_CASE_INSENSITIVE else normalized


def _safe_inventory_path(path: str) -> bool:
    if not path or _INVENTORY_PATH_CONTROL_CHARS_RE.search(path):
        return False
    pure = PurePosixPath(path)
    return not pure.is_absolute() and ".." not in pure.parts


def _looks_like_test_name(name: str) -> bool:
    stem = PurePosixPath(name).stem
    return (
        stem.startswith("test_")
        or stem.endswith("_test")
        or ".test." in name
        or ".spec." in name
    )


__all__ = [
    "FILE_CLASSIFICATIONS",
    "ManifestScanPolicy",
    "RankedFileCandidate",
    "build_manifest_scan_policy",
    "classify_workspace_path",
    "empty_classification_counts",
    "make_ranked_file_candidate",
    "order_ranked_files",
]
