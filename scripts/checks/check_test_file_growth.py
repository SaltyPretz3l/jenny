"""Keep new Node test cases in the test file their surface already has.

Every Node test file is its own process: 0.13 to 0.7 s of start-up before the
first assertion. A file named `<existing>-<suffix>.test.js` beside
`<existing>.test.js` covers the same surface by its own name, so its cases
belong in the existing file while the two fit under the test-file line cap.

A file fails when all of these hold:
- its name extends a sibling's name in the same directory,
- both files together stay at or under LINE_CAP lines,
- it does not state why it needs its own process in a
  `// new-test-file: <reason>` comment in its first REASON_SCAN_LINES lines,
- it is not on the grandfather list (files that existed when the rule landed).

The grandfather list only shrinks: an entry whose file is gone, or no longer
extends a sibling, must be removed. New files never go on it; they carry the
reason comment instead.
"""
from __future__ import annotations

import json
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TESTS_RELATIVE_DIR = Path("tests")
GRANDFATHERED_RELATIVE_PATH = Path("scripts/checks/test_file_growth_grandfathered.json")
TEST_SUFFIX = ".test.js"
LINE_CAP = 600
REASON_SCAN_LINES = 40
REASON_MIN_CHARS = 12
REASON_RE = re.compile(r"^\s*(?://|\*|/\*)\s*new-test-file:\s*(?P<reason>.*?)\s*(?:\*/)?\s*$")
RULE = (
    "put the cases in the existing file, or state why this file needs its own "
    "process in a `// new-test-file: <reason>` comment near the top "
    "(docs/process/TESTING_STRATEGY.md, Where new test cases go)"
)


@dataclass(frozen=True)
class Extension:
    """A test file whose name extends a sibling test file's name."""

    path: str
    sibling: str


def list_test_files(root: Path) -> list[str]:
    found: list[str] = []
    # os.walk skips a directory that vanishes mid-walk. Dot directories under tests/ are scratch
    # space that running tests create and remove, so they are pruned, not walked.
    for directory, subdirs, names in os.walk(root / TESTS_RELATIVE_DIR):
        subdirs[:] = [
            name for name in subdirs if not name.startswith(".") and name != "node_modules"
        ]
        relative_dir = Path(directory).relative_to(root).as_posix()
        found.extend(f"{relative_dir}/{name}" for name in names if name.endswith(TEST_SUFFIX))
    return sorted(found)


def find_extensions(files: Iterable[str]) -> list[Extension]:
    """Pair every file named `<sibling>-<suffix>` with its longest-named sibling."""
    by_dir: dict[str, set[str]] = {}
    for file in files:
        directory, _, name = file.rpartition("/")
        by_dir.setdefault(directory, set()).add(name[: -len(TEST_SUFFIX)])

    extensions: list[Extension] = []
    for directory, stems in sorted(by_dir.items()):
        for stem in sorted(stems):
            parts = stem.split("-")
            for cut in range(len(parts) - 1, 0, -1):
                candidate = "-".join(parts[:cut])
                if candidate in stems:
                    prefix = f"{directory}/" if directory else ""
                    path = f"{prefix}{stem}{TEST_SUFFIX}"
                    extensions.append(Extension(path, f"{prefix}{candidate}{TEST_SUFFIX}"))
                    break
    return extensions


def read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def stated_reason(lines: list[str]) -> str:
    for line in lines[:REASON_SCAN_LINES]:
        match = REASON_RE.match(line)
        if match and len(match.group("reason")) >= REASON_MIN_CHARS:
            return match.group("reason")
    return ""


def load_grandfathered(path: Path) -> tuple[set[str], list[str]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return set(), [f"missing grandfather list: {path}"]
    except (OSError, json.JSONDecodeError) as error:
        return set(), [f"malformed grandfather list {path}: {error}"]
    files = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(files, list) or not all(isinstance(item, str) for item in files):
        return set(), [f"malformed grandfather list {path}: `files` must be a list of paths"]
    if files != sorted(set(files)):
        return set(), [f"grandfather list {path} must be sorted and free of duplicates"]
    return set(files), []


def evaluate(root: Path, grandfathered: set[str]) -> tuple[list[str], list[str]]:
    """Return (failures, stale grandfather entries) for the tree at `root`."""
    extensions = find_extensions(list_test_files(root))
    extending = {extension.path for extension in extensions}
    stale = sorted(grandfathered - extending)

    failures: list[str] = []
    for extension in extensions:
        if extension.path in grandfathered:
            continue
        lines = read_lines(root / extension.path)
        if stated_reason(lines):
            continue
        sibling_lines = len(read_lines(root / extension.sibling))
        total = len(lines) + sibling_lines
        if total > LINE_CAP:
            continue
        failures.append(
            f"{extension.path} ({len(lines)} lines) extends {extension.sibling} "
            f"({sibling_lines} lines); together {total} lines fit under the {LINE_CAP}-line cap"
        )
    return failures, stale


def main() -> int:
    grandfathered, errors = load_grandfathered(ROOT / GRANDFATHERED_RELATIVE_PATH)
    if errors:
        print("FAIL: the test-file growth grandfather list is missing or malformed")
        for error in errors:
            print(f"  - {error}")
        return 1

    failures, stale = evaluate(ROOT, grandfathered)
    if failures:
        print("FAIL: new test file(s) whose cases fit in the existing file for the same surface")
        for failure in failures:
            print(f"  - {failure}")
        print(f"  Every Node test file is its own process; {RULE}.")
    if stale:
        print(
            "FAIL: grandfather entries that no longer apply; remove them from "
            f"{GRANDFATHERED_RELATIVE_PATH.as_posix()} (the list only shrinks)"
        )
        for entry in stale:
            print(f"  - {entry}")
    if failures or stale:
        return 1

    print(f"PASS: test-file growth ({len(grandfathered)} grandfathered file(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
