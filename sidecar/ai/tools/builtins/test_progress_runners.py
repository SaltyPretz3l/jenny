"""Line parsers for the supported test runners (pytest, TAP, Jenny's node safe runner).

The parsers only read output lines; they never rewrite the command. They share one
``RunStats`` that the tracker (``test_progress.py``) turns into wire snapshots.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from sidecar.ai.tools.builtins.tool_output_stream import strip_ansi as _strip_ansi_escapes
from sidecar.ai.tools.sanitization import sanitize_tool_output

MAX_FAILURES = 50
MAX_FAIL_POSITIONS = 10_000
MAX_LINE_CHARS = 4000
DETECT_WINDOW_LINES = 200
INFER_TOTAL_MIN_PERCENT = 5

# Runner signatures (detection window only).
_PYTEST_SIGNATURE_RE = re.compile(
    r"^=+ test session starts =+$"
    r"|collected \d+ items?"
    r"|^\d+ workers? \[\d+ items?\]"
    r"|^(?:[.FEsxX]+\s+\[\s*\d+%\]|\S+\.py\s+[.FEsxX]+\s+\[\s*\d+%\])\s*$"
)
_TAP_SIGNATURE = "TAP version"
_NODE_SAFE_PREFIX = "[run-node-tests-safe] "


def clean(text: str) -> str:
    return sanitize_tool_output(text, max_chars=160, tool_name="run_command")


def strip_ansi(line: str) -> str:
    """Escapes and ALL trailing whitespace go, so the foreground (rstripped) and background
    (raw pipe lines) feeds see identical text."""
    return _strip_ansi_escapes(line).rstrip()


def detect_runner(line: str) -> str | None:
    if line.startswith(_NODE_SAFE_PREFIX):
        return "node_safe"
    if line.startswith(_TAP_SIGNATURE):
        return "tap"
    if _PYTEST_SIGNATURE_RE.search(line):
        return "pytest"
    return None


@dataclass
class Failure:
    file: str
    name: str
    at: float


@dataclass
class RunStats:
    """Counts and per-file evidence shared by every runner parser."""

    runner: str = ""
    cwd: Path = field(default_factory=Path.cwd)
    total: int | None = None
    total_inferred: bool = False
    total_unit: str = "tests"
    tests: int = 0
    done: int = 0
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    printed_percent: float | None = None
    finished: bool = False
    # A command may run pytest more than once: totals and counts accumulate across runs.
    prior_total: int = 0
    base_counts: tuple[int, int, int] = (0, 0, 0)
    segment: int = 0
    failures: list[Failure] = field(default_factory=list)
    fail_positions: list[int] = field(default_factory=list)
    known_failures: set[tuple[str, str]] = field(default_factory=set)
    files: dict[str, list[float]] = field(default_factory=dict)  # file -> [p, f, s, last_t]
    file_order: list[str] = field(default_factory=list)
    cells: list[tuple[str, str]] = field(default_factory=list)  # node_safe (label, state)

    def normalize_path(self, raw: str) -> str:
        path = raw.strip().replace("\\", "/")
        if path.startswith("./"):
            path = path[2:]
        if path.startswith("/") or path[1:3] == ":/":
            try:
                rel = os.path.relpath(path, self.cwd).replace("\\", "/")
            except ValueError:
                return path
            if not rel.startswith(".."):
                return rel
        return path

    def begin_segment(self) -> None:
        """A new pytest run starts after one finished: keep what ran, restart the run totals."""
        self.prior_total = self.total if self.total is not None else self.tests
        self.base_counts = (self.passed, self.failed, self.skipped)
        self.total, self.total_inferred = None, False
        self.printed_percent, self.finished = None, False
        self.segment += 1

    def set_run_total(self, count: int, *, inferred: bool = False) -> None:
        self.total, self.total_inferred = self.prior_total + count, inferred

    def fraction(self) -> float:
        if self.printed_percent is not None and not self.prior_total:
            return max(0.0, min(1.0, self.printed_percent / 100.0))
        if self.total:
            return max(0.0, min(1.0, self.done / self.total))
        return 0.0

    def add_result(self, kind: str, file: str, name: str, now: float) -> None:
        """Record one finished test (``kind`` is p, f or s)."""
        self.tests += 1
        self.done += 1
        if kind == "f":
            self.failed += 1
        elif kind == "s":
            self.skipped += 1
        else:
            self.passed += 1
        if file:
            file = self.normalize_path(file)
            stat = self.files.get(file)
            if stat is None:
                stat = self.files[file] = [0.0, 0.0, 0.0, now]
                self.file_order.append(file)
            stat["pfs".index(kind)] += 1
            stat[3] = now
        if kind == "f":
            self.add_failure(file, name)

    def add_failure(self, file: str, name: str) -> None:
        if len(self.fail_positions) < MAX_FAIL_POSITIONS:
            self.fail_positions.append(max(0, self.done - 1))
        self.known_failures.add((file, name))
        if len(self.failures) < MAX_FAILURES:
            self.failures.append(Failure(clean(file), clean(name), self.fraction()))

    def fill_failure(self, file: str, name: str) -> None:
        """Short-summary line: name an anonymous failure or add one not seen live."""
        file = self.normalize_path(file) if file else ""
        if (file, name) in self.known_failures:
            return
        for failure in self.failures:
            if not failure.name and failure.file in ("", clean(file)):
                failure.name = clean(name)
                failure.file = clean(file) or failure.file
                self.known_failures.add((file, name))
                return
        if len(self.failures) < MAX_FAILURES:
            self.known_failures.add((file, name))
            self.failures.append(Failure(clean(file), clean(name), self.fraction()))


# --------------------------------------------------------------------------- pytest

_XDIST_RE = re.compile(
    r"^\[gw\d+\]\s+\[\s*(\d+)%\]\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\s+(\S.*)$"
)
_SERIAL_RE = re.compile(
    r"^(\S.*?::\S.*?)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b.*?(?:\[\s*(\d+)%\])?\s*$"
)
_CHARS_FILE_RE = re.compile(r"^(\S+?\.py)\s+([.FEsxXR]+)\s*(?:\[\s*(\d+)%\])?\s*$")
_CHARS_ONLY_RE = re.compile(r"^([.FEsxXR]+)\s+\[\s*(\d+)%\]\s*$")
_COLLECTED_RE = re.compile(
    r"(?:^|\s)collected (\d+) items?(?: / (\d+) deselected)?(?: / (\d+) selected)?"
)
_WORKERS_RE = re.compile(r"^\d+ workers? \[(\d+) items?\]")
_SUMMARY_ITEM_RE = re.compile(r"^(FAILED|ERROR) (\S.*?)(?: - .*)?$")
_FINAL_RE = re.compile(r"^(?:no tests ran|(\d+ [A-Za-z]+(?:, \d+ [A-Za-z]+)*)) in [\d.]+s\b")
_COUNT_RE = re.compile(r"(\d+) ([A-Za-z]+)")
_OUTCOME_KIND = {
    "PASSED": "p",
    "XPASS": "p",
    "FAILED": "f",
    "ERROR": "f",
    "SKIPPED": "s",
    "XFAIL": "s",
}
_FINAL_WORDS = frozenset(
    {
        "passed",
        "failed",
        "skipped",
        "error",
        "errors",
        "xfailed",
        "xpassed",
        "deselected",
        "warning",
        "warnings",
    }
)
_CHAR_KIND = {".": "p", "X": "p", "F": "f", "E": "f", "s": "s", "x": "s", "R": "s"}
_FINAL_KIND = {
    "passed": "p",
    "xpassed": "p",
    "failed": "f",
    "error": "f",
    "errors": "f",
    "skipped": "s",
    "xfailed": "s",
}


class PytestParser:
    def __init__(self, stats: RunStats) -> None:
        self.stats = stats
        self.in_summary = False
        self.last_file = ""

    def feed(self, line: str, now: float) -> bool:
        stats = self.stats
        if stats.finished and self._starts_run(line):
            self._begin_segment()
        if self.in_summary:
            return self._summary_line(line) or self._final_line(line)
        if self._verbose_line(line, now):
            return True
        if line.startswith("=") and "short test summary info" in line:
            self.in_summary = True
            return False
        if "collected" in line:
            match = _COLLECTED_RE.search(line)
            if match:
                self._set_collected(match)
                return True
        match = _WORKERS_RE.match(line)
        if match:
            stats.set_run_total(int(match.group(1)))
            return True
        return self._chars(line, now) or self._final_line(line)

    def _verbose_line(self, line: str, now: float) -> bool:
        if line.startswith("[gw"):
            match = _XDIST_RE.match(line)
            if match:
                return self._result(match.group(2), match.group(3), match.group(1), now)
        elif "::" in line:
            match = _SERIAL_RE.match(line)
            if match:
                return self._result(match.group(2), match.group(1), match.group(3), now)
        return False

    def flush(self, now: float) -> bool:
        del now
        return False

    @staticmethod
    def _starts_run(line: str) -> bool:
        if line.startswith("=") and "test session starts" in line:
            return True
        return "collected" in line and _COLLECTED_RE.search(line) is not None

    def _begin_segment(self) -> None:
        self.in_summary = False
        self.last_file = ""
        self.stats.begin_segment()

    def _set_collected(self, match: re.Match[str]) -> None:
        stats = self.stats
        count, deselected, selected = (int(g) if g else None for g in match.groups())
        total = selected if selected is not None else count
        if selected is None and deselected is not None and count is not None:
            total = max(0, count - deselected)
        stats.set_run_total(total or 0)

    def _result(self, outcome: str, test_id: str, percent: str | None, now: float) -> bool:
        file, _, name = test_id.partition("::")
        if self.stats.finished:  # a later run without a header (`pytest -q a; pytest -q b`)
            self._begin_segment()
        self._note_percent(percent)
        self.stats.add_result(_OUTCOME_KIND[outcome], file, name, now)
        self._infer_total()
        return True

    def _chars(self, line: str, now: float) -> bool:
        match = _CHARS_FILE_RE.match(line)
        if match:
            self.last_file = match.group(1)
            chars, percent = match.group(2), match.group(3)
        else:
            match = _CHARS_ONLY_RE.match(line)
            if not match:
                return False
            chars, percent = match.group(1), match.group(2)
        if self.stats.finished:
            self._begin_segment()
        self._note_percent(percent)
        for char in chars:
            self.stats.add_result(_CHAR_KIND[char], self.last_file, "", now)
        self._infer_total()
        return True

    def _note_percent(self, percent: str | None) -> None:
        if percent is not None:
            value = float(percent)
            stats = self.stats
            if stats.printed_percent is None or value >= stats.printed_percent:
                stats.printed_percent = min(100.0, value)

    def _infer_total(self) -> None:
        """`-q` runs print no total; derive one from the printed percent."""
        stats = self.stats
        pct = stats.printed_percent
        if (
            (stats.total is None or stats.total_inferred)
            and pct is not None
            and pct >= INFER_TOTAL_MIN_PERCENT
        ):
            local = stats.done - stats.prior_total
            stats.set_run_total(max(local, round(local * 100 / pct)), inferred=True)

    def _summary_line(self, line: str) -> bool:
        match = _SUMMARY_ITEM_RE.match(line)
        if not match:
            return False
        file, _, name = match.group(2).partition("::")
        self.stats.fill_failure(file if name else "", name or file)
        return True

    def _final_line(self, line: str) -> bool:
        if " in " not in line:
            return False
        match = _FINAL_RE.match(line.strip("= "))
        if not match:
            return False
        stats = self.stats
        items = _COUNT_RE.findall(match.group(1) or "")
        if any(label.lower() not in _FINAL_WORDS for _, label in items):
            return False  # e.g. "12 files in 3.4s" is not a pytest outcome line
        wrapped = line.startswith("=") and line.rstrip().endswith("=")
        if not wrapped and not (stats.tests or stats.total is not None or self.in_summary):
            return False  # the bare -q last line only counts inside a pytest run
        if items:
            totals = {"p": 0, "f": 0, "s": 0}
            for count, label in items:
                kind = _FINAL_KIND.get(label.lower())
                if kind:
                    totals[kind] += int(count)
            base_p, base_f, base_s = stats.base_counts
            stats.passed = base_p + totals["p"]
            stats.failed = base_f + totals["f"]
            stats.skipped = base_s + totals["s"]
            stats.tests = stats.done = stats.passed + stats.failed + stats.skipped
            if stats.total is None or stats.total < stats.tests or stats.total_inferred:
                stats.total, stats.total_inferred = stats.tests, False
        stats.finished = True
        return True


# --------------------------------------------------------------------------- TAP

_TAP_RE = re.compile(r"^(\s*)(not ok|ok) \d+(?: - )?(.*?)(?: # (SKIP|TODO)\b.*)?$", re.IGNORECASE)
_TAP_SUMMARY_RE = re.compile(r"^# (tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$")
_TAP_LOCATION_RE = re.compile(r"^location:\s*['\"]?(.*?)['\"]?\s*$")
_TAP_LINECOL_RE = re.compile(r":\d+(?::\d+)?$")


class TapParser:
    def __init__(self, stats: RunStats) -> None:
        self.stats = stats
        stats.total_unit = "tests"
        self.pending: tuple[bool, str, bool] | None = None  # ok, name, skipped
        self.yaml_indent: int | None = None
        self.yaml_suite = False
        self.yaml_location = ""
        self.summary: dict[str, int] = {}

    def feed(self, line: str, now: float) -> bool:
        if self.yaml_indent is not None:
            return self._yaml_line(line, now)
        changed = False
        if self.pending is not None:
            if line.strip() == "---":
                self.yaml_indent = len(line) - len(line.lstrip())
                self.yaml_suite, self.yaml_location = False, ""
                return False
            changed = self.commit(now)
        match = _TAP_RE.match(line)
        if match:
            self.pending = (match.group(2).lower() == "ok", match.group(3), bool(match.group(4)))
            return changed
        match = _TAP_SUMMARY_RE.match(line)
        if match:
            self.summary[match.group(1)] = int(match.group(2))
            self._reconcile()
            return True
        return changed

    def _yaml_line(self, line: str, now: float) -> bool:
        text = line.strip()
        indent = len(line) - len(line.lstrip())
        if text == "..." and indent == self.yaml_indent:
            self.yaml_indent = None
            return self.commit(now)
        if text.startswith("type:") and "suite" in text:
            self.yaml_suite = True
        match = _TAP_LOCATION_RE.match(text)
        if match and not self.yaml_location:
            self.yaml_location = match.group(1)
        return False

    def commit(self, now: float) -> bool:
        pending, self.pending = self.pending, None
        if pending is None:
            return False
        ok, name, skipped = pending
        if self.yaml_suite:
            self.yaml_suite = False
            return False
        kind = "s" if skipped else ("p" if ok else "f")
        self.stats.add_result(kind, self._failure_file() if kind == "f" else "", name, now)
        self.yaml_location = ""
        return True

    def flush(self, now: float) -> bool:
        return self.commit(now)

    def _failure_file(self) -> str:
        raw = _TAP_LINECOL_RE.sub("", self.yaml_location.strip())
        return self.stats.normalize_path(raw) if raw else ""

    def _reconcile(self) -> None:
        stats, summary = self.stats, self.summary
        if "tests" not in summary:
            return
        stats.tests = stats.done = summary["tests"]
        stats.passed = summary.get("pass", stats.passed)
        stats.failed = summary.get("fail", stats.failed) + summary.get("cancelled", 0)
        stats.skipped = summary.get("skipped", 0) + summary.get("todo", 0)
        stats.finished = True


# --------------------------------------------------------------------------- node safe

_NODE_FILES_RE = re.compile(r"^\[run-node-tests-safe\] files (\d+)\s*$")
_NODE_PROGRESS_RE = re.compile(
    r"^\[run-node-tests-safe\] progress (\d+)/(\d+) (pass|fail) (\S.*?)(?: \((\d+) tests?\))?\s*$"
)


class NodeSafeParser:
    def __init__(self, stats: RunStats) -> None:
        self.stats = stats
        stats.total_unit = "files"

    def flush(self, now: float) -> bool:
        del now
        return False

    def feed(self, line: str, now: float) -> bool:
        del now
        stats = self.stats
        match = _NODE_FILES_RE.match(line)
        if match:
            stats.total = int(match.group(1))
            return True
        match = _NODE_PROGRESS_RE.match(line)
        if not match:
            return False
        done, total, outcome, path, count = match.groups()
        stats.total = int(total)
        stats.done = min(int(done), stats.total)
        stats.finished = stats.done >= stats.total
        stats.tests += int(count) if count else 0
        path = stats.normalize_path(path)
        if outcome == "pass":
            stats.passed += 1
            stats.cells.append((clean(path), "p"))  # labels are cleaned once, here
        else:
            stats.failed += 1
            stats.cells.append((clean(path), "f"))
            stats.add_failure(path, path.rsplit("/", 1)[-1])
        return True


def make_parser(runner: str, stats: RunStats) -> PytestParser | TapParser | NodeSafeParser:
    stats.runner = runner
    if runner == "tap":
        return TapParser(stats)
    if runner == "node_safe":
        return NodeSafeParser(stats)
    return PytestParser(stats)
