"""Fail if active code files exceed the hard 1000-line ceiling.

Temporary exceptions are allowed only through the named legacy allowlist below.
Each exception must carry:
- a stable label
- a human-readable reason
- a live split-plan reference
- an absolute expiration date

Exceptions are intentionally temporary debt markers:
- expired entries fail
- entries whose files no longer exceed the ceiling fail and must be removed
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAX_LINES = 1000
BUFFER_LINES = 15
CODE_SUFFIXES = {".css", ".js", ".mjs", ".py", ".ts", ".tsx"}
SKIP_DIRS = {"archive", "docs", "node_modules", "dist", "out", ".git", ".venv", "__pycache__"}
ACTIVE_DIRS = {"renderer", "services", "scripts", "sidecar", "styles", "tests"}
# tests/sidecar/ joins the ratchet in a later enforcement packet (see
# "Planned Refactor Expansion" in docs/operations/LEGACY_SIZE_ALLOWLIST.md);
# sidecar production source is enforced as of 2026-07-05.
DONOR_TEST_SUBDIRS = {"sidecar"}
ALLOWLIST_PLAN_DOC = Path("docs/operations/LEGACY_SIZE_ALLOWLIST.md")


@dataclass(frozen=True)
class LegacySizeException:
    label: str
    reason: str
    split_plan: Path
    expires_on: str
    # Bounded raised ceiling for this one file (lines, before BUFFER_LINES).
    # Defaults to the global cap, so an entry is never a blank cheque: a file
    # that grows past max_lines + BUFFER_LINES still hard-FAILs.
    max_lines: int = MAX_LINES


LEGACY_SIZE_ALLOWLIST: dict[Path, LegacySizeException] = {}


def is_active_root_path(path: Path) -> bool:
    if len(path.parts) == 1:
        return True
    first = path.parts[0]
    if first in ACTIVE_DIRS:
        if first == "tests":
            return not (len(path.parts) > 1 and path.parts[1] in DONOR_TEST_SUBDIRS)
        return True
    return False


def should_skip(path: Path) -> bool:
    if any(part in SKIP_DIRS for part in path.parts):
        return True
    if not is_active_root_path(path.relative_to(ROOT)):
        return True
    return False


def normalize_repo_path(path: Path | str) -> Path:
    return Path(str(path).replace("\\", "/"))


def parse_expiration(raw_value: str) -> date:
    return date.fromisoformat(str(raw_value).strip())


def validate_allowlist(today: date) -> tuple[dict[Path, date], list[str]]:
    parsed_expirations: dict[Path, date] = {}
    errors: list[str] = []
    seen_labels: set[str] = set()

    for raw_path, entry in LEGACY_SIZE_ALLOWLIST.items():
        relative_path = normalize_repo_path(raw_path)
        label = str(entry.label or "").strip()
        reason = str(entry.reason or "").strip()
        split_plan = normalize_repo_path(entry.split_plan)

        if not label:
            errors.append(f"{relative_path}: legacy size exception must define a non-empty label")
        elif label in seen_labels:
            errors.append(f"{relative_path}: duplicate legacy size exception label '{label}'")
        else:
            seen_labels.add(label)

        if not reason:
            errors.append(f"{relative_path}: legacy size exception '{label or relative_path}' is missing a reason")

        if split_plan.is_absolute():
            errors.append(f"{relative_path}: split plan must be repo-relative, got {split_plan}")
        elif not (ROOT / split_plan).exists():
            errors.append(
                f"{relative_path}: split plan for legacy size exception '{label or relative_path}' does not exist: {split_plan}"
            )

        try:
            parsed_expirations[relative_path] = parse_expiration(entry.expires_on)
        except ValueError:
            errors.append(
                f"{relative_path}: legacy size exception '{label or relative_path}' has invalid expires_on date: {entry.expires_on}"
            )
            continue

        if parsed_expirations[relative_path] < today:
            errors.append(
                f"{relative_path}: legacy size exception '{label or relative_path}' expired on {entry.expires_on}"
            )

    return parsed_expirations, errors


def format_allowlist_warning(relative_path: Path, line_count: int, entry: LegacySizeException) -> str:
    split_plan = normalize_repo_path(entry.split_plan)
    return (
        f"{relative_path} ({line_count} lines): temporary legacy size exception "
        f"'{entry.label}' until {entry.expires_on} via {split_plan}: {entry.reason}"
    )


def iter_code_files() -> list[Path]:
    """Enumerate active code without descending into ignored repository trees."""
    files: list[Path] = []
    for directory, dir_names, file_names in os.walk(ROOT):
        directory_path = Path(directory)
        dir_names[:] = sorted(
            name
            for name in dir_names
            if not should_skip(directory_path / name)
        )
        for file_name in sorted(file_names):
            path = directory_path / file_name
            if path.suffix in CODE_SUFFIXES and not should_skip(path):
                files.append(path)
    return files


def main() -> int:
    today = date.today()
    parsed_expirations, allowlist_errors = validate_allowlist(today)
    ceiling = MAX_LINES + BUFFER_LINES

    violations: list[str] = []
    allowlist_warnings: list[str] = []
    stale_allowlist_entries: list[str] = []
    line_counts: dict[Path, int] = {}

    for path in iter_code_files():
        relative_path = path.relative_to(ROOT)
        line_count = sum(1 for _ in path.open("r", encoding="utf-8"))
        line_counts[relative_path] = line_count

        if line_count <= ceiling:
            continue

        exception = LEGACY_SIZE_ALLOWLIST.get(relative_path)
        if exception is None:
            violations.append(f"{relative_path} ({line_count} lines)")
            continue

        expires_on = parsed_expirations.get(relative_path)
        if expires_on is None or expires_on < today:
            violations.append(
                f"{relative_path} ({line_count} lines): legacy size exception '{exception.label}' is invalid or expired"
            )
            continue

        raised_ceiling = exception.max_lines + BUFFER_LINES
        if line_count > raised_ceiling:
            # Allowlisted, but grown past its bounded raised ceiling: still a
            # hard FAIL so an accidental blow-up can't hide behind the waiver.
            violations.append(
                f"{relative_path} ({line_count} lines): exceeds the raised legacy ceiling "
                f"{exception.max_lines}+{BUFFER_LINES} for '{exception.label}'"
            )
            continue

        allowlist_warnings.append(format_allowlist_warning(relative_path, line_count, exception))

    for relative_path, entry in LEGACY_SIZE_ALLOWLIST.items():
        normalized_path = normalize_repo_path(relative_path)
        line_count = line_counts.get(normalized_path)
        if line_count is None:
            stale_allowlist_entries.append(
                f"{normalized_path}: remove legacy size exception '{entry.label}' because the target file was not scanned"
            )
            continue
        if line_count <= ceiling:
            stale_allowlist_entries.append(
                f"{normalized_path} ({line_count} lines): remove legacy size exception '{entry.label}' because the file no longer exceeds {ceiling} lines"
            )

    failed = False
    if violations:
        failed = True
        print(f"FAIL: file-size ceiling exceeded ({MAX_LINES}+{BUFFER_LINES} lines)")
        for item in violations:
            print(f"  - {item}")

    if allowlist_errors or stale_allowlist_entries:
        failed = True
        print("FAIL: legacy file-size allowlist invalid")
        for item in allowlist_errors:
            print(f"  - {item}")
        for item in stale_allowlist_entries:
            print(f"  - {item}")

    if allowlist_warnings:
        print("WARN: temporary legacy file-size exceptions")
        for item in allowlist_warnings:
            print(f"  - {item}")

    if failed:
        return 1

    print(f"PASS: file-size check ({MAX_LINES}+{BUFFER_LINES} line ceiling)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
