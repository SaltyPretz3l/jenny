"""Multi-stage test commands: one ``TestProgressTracker`` per stage, one followed at a time.

Two shapes put more than one test run behind a single run_command call:

- Wrapper gates such as ``scripts/checks/run_ci.py`` run stages in parallel waves and prefix
  every child line with ``[HH:MM:SS] [<stage> +<s>s] ``. The prefix is stripped, each stage
  gets its own tracker (built from the stage's ``START <command>`` line, so pytest file
  discovery sees the real pytest command), and the run_ci bookkeeping lines are dropped.
- Sequential lanes (``npm run test:affected``: the node lane, then ``pytest -q``) print
  unprefixed: once the current runner finishes, a different runner's signature opens a new
  stage.

The UI follows one stage: the biggest unfinished one, handing over when it finishes. Every
snapshot carries ``stage`` (bumped on each hand-over) so the renderer and the hosted throttle
drop the previous stage's grid labels. The finished ``test_summary`` reports the first stage
with failures (else the largest) and adds the other stages' failures to it.
"""

from __future__ import annotations

import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from sidecar.ai.tools.builtins.test_progress import SUMMARY_FAILURES, TestProgressTracker
from sidecar.ai.tools.builtins.test_progress_runners import (
    MAX_LINE_CHARS,
    detect_runner,
    strip_ansi,
)

MAX_STAGES = 16
# run_ci.py `_print_stage_event`: "[12:27:30] [pytest_sidecar +2.1s] <child line>".
_STAGE_LINE_RE = re.compile(
    r"^\[\d{2}:\d{2}:\d{2}\] \[([A-Za-z0-9_.:-]{1,64}) \+\d+(?:\.\d+)?s\] ?(.*)$"
)
_STAGE_END_RE = re.compile(
    r"^(?:PASS|FAIL) \(\d+(?:\.\d+)?s\)$|^FAIL unable to start stage|^GLOBAL TIMEOUT"
)
_STAGE_START = "START "
_STAGE_HEARTBEAT = "HEARTBEAT "
_PLAIN = ""
# A finished run hands over only to a strong signature: a failing node file's captured output
# can carry "TAP version" lines after the safe runner's last progress line.
_HANDOVER_RUNNERS = frozenset({"pytest", "node_safe"})


@dataclass
class _Stage:
    tracker: TestProgressTracker
    ended: bool = False

    def state(self) -> tuple[str, bool, int] | None:
        """(runner, done, size) once a runner is detected."""
        state = self.tracker.stage_state()
        if state is None:
            return None
        runner, finished, size = state
        return runner, finished or self.ended, size


class StagedTestProgress:
    __test__ = False  # not a pytest test class

    def __init__(
        self,
        *,
        command: str,
        cwd: Path,
        workspace_root: Path,
        clock: Callable[[], float] = time.monotonic,
        **tracker_options: object,
    ) -> None:
        self._command = command
        self._cwd = Path(cwd)
        self._workspace_root = Path(workspace_root)
        self._clock = clock
        self._options = tracker_options
        self._started = clock()
        self._lock = threading.Lock()
        self._stages: list[_Stage] = []
        self._named: dict[str, _Stage] = {}
        self._plain = self._new_stage(command)
        self._active: _Stage | None = None
        self._stage_index = 0
        self._switched = False

    # ------------------------------------------------------------------ input

    def feed_line(self, line: str) -> None:
        try:
            self._feed(line)
        except Exception:  # noqa: BLE001 - progress is strictly best-effort
            return

    def _feed(self, line: str) -> None:
        match = _STAGE_LINE_RE.match(line[:MAX_LINE_CHARS]) if line.startswith("[") else None
        if match is None and len(self._stages) == 1 and self._plain.tracker.gave_up():
            return  # not a test command: stop paying for it (benign unlocked read)
        with self._lock:
            stage = self._stage_line(*match.groups()) if match else self._plain_line(line)
            if stage is None:
                return
            stage.tracker.feed_line(match.group(2) if match else line)
            # Only a detected stage can change the choice; the followed one only when it finishes.
            state = stage.state()
            if state is not None and (stage is not self._active or state[1]):
                self._select()

    def _stage_line(self, name: str, body: str) -> _Stage | None:
        stage = self._named.get(name)
        if body.startswith(_STAGE_START):
            if stage is None and len(self._stages) < MAX_STAGES:
                self._named[name] = self._new_stage(body[len(_STAGE_START) :])
            return None
        if body.startswith(_STAGE_HEARTBEAT):
            return None
        if _STAGE_END_RE.match(body):
            if stage is not None:
                stage.ended = True
                self._select()
            return None
        if stage is None and len(self._stages) < MAX_STAGES:
            stage = self._named[name] = self._new_stage(self._command)
        return stage

    def _plain_line(self, line: str) -> _Stage | None:
        state = self._plain.state()
        if state is not None and state[1] and len(self._stages) < MAX_STAGES:
            runner = detect_runner(strip_ansi(line[:MAX_LINE_CHARS]))
            if runner in _HANDOVER_RUNNERS and runner != state[0]:
                self._plain = self._new_stage(self._command)
        return self._plain

    def _new_stage(self, command: str) -> _Stage:
        tracker = TestProgressTracker(
            command=command,
            cwd=self._cwd,
            workspace_root=self._workspace_root,
            clock=self._clock,
            **self._options,  # type: ignore[arg-type]
        )
        stage = _Stage(tracker)
        self._stages.append(stage)
        return stage

    def _select(self) -> None:
        """Follow the biggest unfinished stage; keep the last one once every stage is done."""
        states = [(stage, stage.state()) for stage in self._stages]
        detected = [(stage, state) for stage, state in states if state is not None]
        if not detected:
            return
        open_stages = [(stage, state[2]) for stage, state in detected if not state[1]]
        active = self._active
        current = next((state for stage, state in detected if stage is active), None)
        if current is not None and not current[1]:  # the followed stage yields only to a bigger one
            open_stages = [item for item in open_stages if item[1] > current[2]]
        if open_stages:
            choice = max(open_stages, key=lambda item: item[1])[0]
        elif current is None:
            choice = detected[0][0]
        else:
            return
        if choice is not active:
            if active is not None:
                self._stage_index += 1
            self._active = choice
            self._switched = True

    # ------------------------------------------------------------------ output

    def has_update(self) -> bool:
        with self._lock:
            active, switched = self._active, self._switched
        return active is not None and (switched or active.tracker.has_update())

    def wants_wake(self) -> bool:
        with self._lock:
            active, switched = self._active, self._switched
        return active is not None and (switched or active.tracker.wants_wake())

    def snapshot(self, *, final: bool = False) -> dict[str, object] | None:
        with self._lock:
            active, index = self._active, self._stage_index
            self._switched = False
        if active is None:
            return None
        snapshot = active.tracker.snapshot(final=final)
        if snapshot is not None:
            snapshot["stage"] = index
        return snapshot

    def background_progress(self) -> dict[str, object] | None:
        with self._lock:
            active = self._active
        return active.tracker.background_progress() if active is not None else None

    def summary(self) -> dict[str, object] | None:
        with self._lock:
            stages = list(self._stages)
        summaries = [s for s in (stage.tracker.summary() for stage in stages) if s is not None]
        if len(summaries) <= 1:
            return summaries[0] if summaries else None
        failing = [s for s in summaries if _count(s, "failed")]
        primary = failing[0] if failing else max(summaries, key=lambda s: _count(s, "tests"))
        merged = dict(primary)
        failures = list(_failures(primary))
        for other in failing:
            if other is primary:
                continue
            merged["failed"] = _count(merged, "failed") + _count(other, "failed")
            failures.extend(_failures(other))
        merged["failures"] = failures[:SUMMARY_FAILURES]
        merged["duration_ms"] = max(0, int((self._clock() - self._started) * 1000))
        return merged


def _count(summary: dict[str, object], key: str) -> int:
    value = summary.get(key)
    return value if isinstance(value, int) else 0


def _failures(summary: dict[str, object]) -> list[object]:
    value = summary.get("failures")
    return list(value) if isinstance(value, list) else []
