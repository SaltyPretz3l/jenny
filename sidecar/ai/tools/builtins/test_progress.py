"""Live test-run progress: turns a test command's output lines into UI snapshots.

``TestProgressTracker`` is fed complete output lines (stdout and stderr) and answers with the
``test_progress`` wire object, the persisted ``test_summary`` and a small background-job
digest. It never rewrites the command and never raises from ``feed_line``.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from pathlib import Path

from sidecar.ai.tools.builtins.test_progress_grid import (
    MAX_CELLS,
    MIN_FILE_GRID,
    Grid,
    file_grid,
    order_grid,
)
from sidecar.ai.tools.builtins.test_progress_manifest import discover
from sidecar.ai.tools.builtins.test_progress_runners import (
    DETECT_WINDOW_LINES,
    MAX_FAILURES,
    MAX_LINE_CHARS,
    NodeSafeParser,
    PytestParser,
    RunStats,
    TapParser,
    clean,
    detect_runner,
    make_parser,
    strip_ansi,
)

RUNNING_WINDOW_SECONDS = 2.0
ETA_WINDOW_SECONDS = 20.0
ETA_MIN_PERCENT = 10.0
FULL_PERCENT = 100.0
SUMMARY_FAILURES = 20
BACKGROUND_MARKS = 50
BACKGROUND_NAMES = 10


class TestProgressTracker:
    __test__ = False  # not a pytest test class

    def __init__(  # noqa: PLR0913
        self,
        *,
        command: str,
        cwd: Path,
        workspace_root: Path,
        clock: Callable[[], float] = time.monotonic,
        manifest_budget_seconds: float = 1.0,
        start_manifest_thread: bool = True,
    ) -> None:
        self._command = command
        self._cwd = Path(cwd)
        self._workspace_root = Path(workspace_root)
        self._clock = clock
        self._budget = manifest_budget_seconds
        self._start_thread = start_manifest_thread
        self._started = clock()
        self._lock = threading.Lock()
        self._stats = RunStats(cwd=self._cwd)
        self._parser: PytestParser | TapParser | NodeSafeParser | None = None
        self._lines_seen = 0
        self._dirty = False
        self._manifest_state = "idle"  # idle | pending | ready | failed
        self._manifest: list[str] = []
        self._manifest_clean: list[str] = []  # sanitized once, in set_manifest
        self._manifest_index: dict[str, int] = {}
        self._extras: list[str] = []
        self._extras_clean: list[str] = []
        self._extras_scanned = 0
        self._segment = 0
        self._labels_sent = 0
        self._samples: deque[tuple[float, float]] = deque()
        self._decay_at: float | None = None
        self._percent_floor = 0.0

    # ------------------------------------------------------------------ input

    def feed_line(self, line: str) -> None:
        try:
            self._feed(line)
        except Exception:  # noqa: BLE001 - progress is strictly best-effort
            return

    def _feed(self, line: str) -> None:
        if self._parser is None and self._lines_seen > DETECT_WINDOW_LINES:
            return  # not a test command: stop paying for it (benign unlocked read)
        text = strip_ansi(line[:MAX_LINE_CHARS])
        with self._lock:
            if self._parser is None:
                self._lines_seen += 1
                if self._lines_seen > DETECT_WINDOW_LINES:
                    return
                runner = detect_runner(text)
                if runner is None:
                    return
                self._parser = make_parser(runner, self._stats)
                self._dirty = True
                if runner == "pytest":
                    self._start_manifest()
            if self._parser.feed(text, self._clock()):
                self._dirty = True

    def _start_manifest(self) -> None:
        if not self._start_thread:
            return
        self._manifest_state = "pending"
        threading.Thread(target=self._discover, name="test-progress-manifest", daemon=True).start()

    def _discover(self) -> None:
        try:
            labels = discover(
                command=self._command,
                cwd=self._cwd,
                workspace_root=self._workspace_root,
                budget_seconds=self._budget,
            )
        except Exception:  # noqa: BLE001 - a crash must never leave the manifest pending
            labels = None
        self.set_manifest(labels)

    def set_manifest(self, labels: list[str] | None) -> None:
        """Install the discovered pytest file list (``None`` = discovery failed)."""
        cleaned = [clean(label) for label in labels] if labels is not None else []
        with self._lock:
            if labels is None:
                self._manifest_state = "failed"
            else:
                self._manifest = list(labels)
                self._manifest_clean = cleaned
                self._manifest_index = {label: i for i, label in enumerate(labels)}
                self._manifest_state = "ready"
            self._dirty = True

    # ------------------------------------------------------------------ output

    def gave_up(self) -> bool:
        """No runner within the detection window (benign unlocked read)."""
        return self._parser is None and self._lines_seen > DETECT_WINDOW_LINES

    def stage_state(self) -> tuple[str, bool, int] | None:
        """(runner, finished, size) once a runner is detected (multi-stage selection)."""
        with self._lock:
            if self._parser is None:
                return None
            stats = self._stats
            return stats.runner, stats.finished, stats.total or stats.tests

    def has_update(self) -> bool:
        with self._lock:
            if self._dirty:
                return True
            return self._decay_at is not None and self._clock() >= self._decay_at

    def wants_wake(self) -> bool:
        """A snapshot is due now, or soon: a decay deadline or the manifest thread is pending."""
        with self._lock:
            return self._dirty or self._decay_at is not None or self._manifest_state == "pending"

    def snapshot(self, *, final: bool = False) -> dict[str, object] | None:
        with self._lock:
            if self._parser is None:
                return None
            if final:
                self._parser.flush(self._clock())
            return self._build(final=final)

    def summary(self) -> dict[str, object] | None:
        with self._lock:
            if self._parser is None:
                return None
            self._parser.flush(self._clock())
            stats = self._stats
            grid, _ = self._grid(final=True, labels_from=MAX_CELLS)  # no labels needed
            return {
                "runner": stats.runner,
                "unit": self._unit(grid),
                "total": stats.total,
                "total_unit": stats.total_unit,
                "tests": stats.tests,
                "passed": stats.passed,
                "failed": stats.failed,
                "skipped": stats.skipped,
                "duration_ms": self._elapsed_ms(),
                "failures": self._failures()[:SUMMARY_FAILURES],
                "grid": grid,
            }

    def background_progress(self) -> dict[str, object] | None:
        with self._lock:
            if self._parser is None:
                return None
            stats = self._stats
            marks = [round(f.at, 4) for f in stats.failures[:BACKGROUND_MARKS]]
            names = [f.name or f.file or "failed test" for f in stats.failures[:BACKGROUND_NAMES]]
            return {
                "runner": stats.runner,
                "total_unit": stats.total_unit,
                "percent": self._percent(),
                "done": stats.done,
                "total": stats.total,
                "failed": stats.failed,
                "skipped": stats.skipped,
                "failure_marks": marks,
                "failures": names,
            }

    # ------------------------------------------------------------------ building

    def _build(self, *, final: bool) -> dict[str, object]:
        stats = self._stats
        percent = self._percent()
        now = self._clock()
        # The final snapshot resends every label (a dropped earlier event cannot be repaired).
        start = 0 if final else self._labels_sent
        grid, cell_labels = self._grid(final=final, labels_from=start)
        snapshot: dict[str, object] = {
            "runner": stats.runner,
            "unit": self._unit(grid),
            "total": stats.total,
            "total_unit": stats.total_unit,
            "done": stats.done,
            "tests": stats.tests,
            "passed": stats.passed,
            "failed": stats.failed,
            "skipped": stats.skipped,
            "percent": percent,
            "elapsed_ms": self._elapsed_ms(),
            "eta_ms": self._eta_ms(percent, now),
            "failures": self._failures(),
            "grid": grid,
        }
        if self._unit(grid) == "file":
            labels: list[str] = []
            while start + len(labels) < len(cell_labels):
                label = cell_labels[start + len(labels)]
                if label is None:
                    break
                labels.append(label)
            if labels:
                snapshot["labels_from"] = start
                snapshot["labels"] = labels
                self._labels_sent = start + len(labels)
        snapshot["final"] = final
        self._dirty = False
        return snapshot

    def _unit(self, grid: Grid | None) -> str:
        if grid is None:
            return "none"
        return "file" if self._file_grid_active() else "order"

    def _elapsed_ms(self) -> int:
        return max(0, int((self._clock() - self._started) * 1000))

    def _failures(self) -> list[dict[str, object]]:
        return [
            {"file": f.file, "name": f.name or f.file or "failed test", "at": round(f.at, 4)}
            for f in self._stats.failures[:MAX_FAILURES]
        ]

    def _percent(self) -> float | None:
        stats = self._stats
        if stats.runner == "tap":
            return None
        value: float
        if stats.finished:
            value = FULL_PERCENT
        elif (
            stats.printed_percent is not None and stats.runner == "pytest" and not stats.prior_total
        ):
            value = stats.printed_percent
        elif stats.total:
            value = min(FULL_PERCENT, stats.done * FULL_PERCENT / stats.total)
        else:
            return None
        if stats.segment != self._segment:  # a later pytest run restarts the bar
            self._segment, self._percent_floor = stats.segment, 0.0
            self._samples.clear()
        self._percent_floor = max(self._percent_floor, value)
        return round(self._percent_floor, 2)

    def _eta_ms(self, percent: float | None, now: float) -> int | None:
        if percent is None or percent < ETA_MIN_PERCENT:
            return None
        if percent >= FULL_PERCENT:
            return 0
        samples = self._samples
        samples.append((now, percent))
        while samples and now - samples[0][0] > ETA_WINDOW_SECONDS:
            samples.popleft()
        first_t, first_p = samples[0]
        if now > first_t and percent > first_p:
            rate = (percent - first_p) / (now - first_t)
        else:
            elapsed = now - self._started
            if elapsed <= 0:
                return None
            rate = percent / elapsed
        return int((100.0 - percent) / rate * 1000)

    # ------------------------------------------------------------------ grid

    def _file_grid_active(self) -> bool:
        stats = self._stats
        if stats.runner == "node_safe":
            return (stats.total or 0) >= MIN_FILE_GRID
        if stats.runner != "pytest" or self._manifest_state != "ready":
            return False
        return len(self._manifest) + len(self._extras) >= MIN_FILE_GRID and bool(stats.files)

    def _grid(self, *, final: bool, labels_from: int = 0) -> tuple[Grid | None, list[str | None]]:
        stats = self._stats
        self._decay_at = None
        if stats.runner == "tap" or not stats.total:
            return None, []
        if stats.runner == "pytest" and self._manifest_state == "pending" and not final:
            return None, []
        if self._file_grid_active():
            states, labels = self._file_states(final=final)
            return file_grid(states, labels, labels_from=labels_from)
        return order_grid(stats.total, stats.done, stats.fail_positions, final=final), []

    def _file_states(self, *, final: bool) -> tuple[str, list[str]]:
        stats = self._stats
        if stats.runner == "node_safe":
            total = stats.total or 0
            labels = [label for label, _ in stats.cells[:total]]
            done_states = "".join(state for _, state in stats.cells[:total])
            return done_states + "-" * (total - len(done_states)), labels
        self._scan_extras()
        now = self._clock()
        chars: list[str] = []
        latest = 0.0
        for label in (*self._manifest, *self._extras):
            stat = stats.files.get(label)
            if stat is None:
                chars.append("-")
            elif stat[1]:
                chars.append("f")
            elif not final and now - stat[3] < RUNNING_WINDOW_SECONDS:
                chars.append("r")
                latest = max(latest, stat[3])
            else:
                chars.append("s" if stat[0] == 0 and stat[2] else "p")
        if latest:
            self._decay_at = latest + RUNNING_WINDOW_SECONDS
        return "".join(chars), self._manifest_clean + self._extras_clean

    def _scan_extras(self) -> None:
        order = self._stats.file_order
        while self._extras_scanned < len(order):
            label = order[self._extras_scanned]
            self._extras_scanned += 1
            if label not in self._manifest_index:
                self._manifest_index[label] = len(self._manifest) + len(self._extras)
                self._extras.append(label)
                self._extras_clean.append(clean(label))
